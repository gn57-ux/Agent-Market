import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { normalizeAddress } from "../auth/nonce.store.js";
import { deriveOnChainTaskId } from "../tasks/onchain-task-id.js";
import { getTaskById } from "../tasks/repository.js";
import {
  callMatch,
  DispatchServiceUnavailableError,
  type MatchRequest,
} from "./dispatch.client.js";
import { issueAcceptancePermit } from "./permit.service.js";
import {
  assembleCandidateSnapshots,
  getLatestRecommendationCandidates,
  getRequiredAgentLevel,
  insertRecommendationRun,
} from "./repository.js";
import { taskIdParamSchema } from "./schema.js";

/**
 * T-705's single implemented algorithm version — deliberately not
 * configurable (the capsule: "本 Feature 唯一实现的版本，不做成可配置").
 */
const ALGORITHM_VERSION = "v0.1";

/** Same pattern as tasks/routes.ts's/agents/routes.ts's own local copy of
 * this helper — reads `request.address` (populated by `app.requireSession`)
 * without a non-null assertion. The 401 branch is defensive, not expected to
 * actually trigger given `requireSession` already ran as this route's
 * preHandler. */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

export type MatchTaskResult =
  | {
      ok: true;
      taskId: string;
      algorithmVersion: string;
      recommendationCount: number;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "dispatch_unavailable"; message: string };

/**
 * T-705's orchestration: look up the task (404 for both "doesn't exist" and
 * "exists but `sessionAddress` isn't its requester" — the capsule's explicit
 * instruction, mirroring T-605's "不额外暴露任务 ID 是否存在" convention, so this
 * function collapses both into the same `not_found` outcome rather than a
 * separate `forbidden` reason routes.ts would otherwise turn into a
 * distinguishable 403), assemble candidate snapshots, call the Go dispatch
 * service, and persist the run + its recommended candidates in one
 * transaction.
 *
 * No eligibility/scoring/slotting logic lives here or anywhere else in
 * apps/api — this function only gathers data, makes one HTTP call, and
 * writes the result back (T-705 capsule's explicit boundary).
 */
async function matchTask(
  pool: Pool,
  sessionAddress: string,
  taskId: string,
): Promise<MatchTaskResult> {
  const task = await getTaskById(pool, taskId);
  if (!task || task.requesterAddress !== normalizeAddress(sessionAddress)) {
    return { ok: false, reason: "not_found" };
  }

  const requiredLevel = (await getRequiredAgentLevel(pool, taskId)) ?? "BEGINNER";
  const candidates = await assembleCandidateSnapshots(pool, task.category);

  const request: MatchRequest = {
    taskId: task.id,
    category: task.category,
    skillTags: task.skillTags,
    deliveryDeadline: task.deliveryDeadline.toISOString(),
    requiredLevel,
    requesterAddress: task.requesterAddress,
    algorithmVersion: ALGORITHM_VERSION,
    candidates,
  };

  let matchResponse;
  try {
    matchResponse = await callMatch(request);
  } catch (error) {
    if (error instanceof DispatchServiceUnavailableError) {
      return { ok: false, reason: "dispatch_unavailable", message: error.message };
    }
    throw error;
  }

  // Confirms the response is actually FOR this request, not just
  // well-formed (Codex review, T-705 round 2, P2): a schema-valid response
  // whose taskId/algorithmVersion don't match what was sent, or whose
  // recommendations name an agentId never in the candidates this call
  // dispatched, would otherwise get persisted as-is — silently attributing
  // a real Agent's recommendation to the wrong task. Neither the Go
  // service's own contract nor a database FK prevents this class of
  // mix-up (the FK only checks that the agent_id exists somewhere, not
  // that it was actually a candidate for this run).
  if (matchResponse.taskId !== task.id || matchResponse.algorithmVersion !== ALGORITHM_VERSION) {
    return {
      ok: false,
      reason: "dispatch_unavailable",
      message: "dispatch service response did not match this task/algorithmVersion",
    };
  }
  const candidateAgentIds = new Set(candidates.map((c) => c.agentId));
  const seenAgentIds = new Set<string>();
  const seenRanks = new Set<number>();
  for (const recommendation of matchResponse.recommendations) {
    if (!candidateAgentIds.has(recommendation.agentId)) {
      return {
        ok: false,
        reason: "dispatch_unavailable",
        message:
          "dispatch service returned a recommendation for an agent not among this run's candidates",
      };
    }
    // A schema-valid response can still repeat the same agentId or rank
    // across slots — slotting.Select's own invariant is "one agent occupies
    // at most one slot," and rank is meant to be a strict 1..N ordering, so
    // either kind of duplicate means the response can't actually be trusted
    // (Codex review, T-706 round 1, P2). Persisting it as-is would let one
    // agent be issued more than one acceptance permit for the same task.
    if (seenAgentIds.has(recommendation.agentId) || seenRanks.has(recommendation.rank)) {
      return {
        ok: false,
        reason: "dispatch_unavailable",
        message:
          "dispatch service returned duplicate agentId or rank values across recommendations",
      };
    }
    seenAgentIds.add(recommendation.agentId);
    seenRanks.add(recommendation.rank);
  }

  await insertRecommendationRun(pool, {
    taskId: task.id,
    algorithmVersion: ALGORITHM_VERSION,
    // The full candidate pool sent to Go, not the recommendation count —
    // see insertRecommendationRun's own doc comment.
    candidateCount: candidates.length,
    candidates: matchResponse.recommendations.map((recommendation) => ({
      agentId: recommendation.agentId,
      rank: recommendation.rank,
      slotType: recommendation.slotType,
      score: recommendation.score,
      reasons: recommendation.reasons,
    })),
  });

  return {
    ok: true,
    taskId: task.id,
    algorithmVersion: ALGORITHM_VERSION,
    recommendationCount: matchResponse.recommendations.length,
  };
}

/** One entry in `POST /tasks/:taskId/acceptance-permits`'s `permits[]`
 * response array (design.md's fixed response shape, plus
 * `agentWalletAddress` — T-706 capsule's `AcceptancePermitOutput` interface
 * — since the signed `agent` field's actual value is otherwise invisible in
 * the response). `nonce` is a stringified `uint256` (too large for a JS
 * `number`); `expiry`/`chainId` stay `number` (well under
 * `Number.MAX_SAFE_INTEGER`). */
interface AcceptancePermitJson {
  agentId: string;
  taskId: string;
  agentWalletAddress: string;
  nonce: string;
  expiry: number;
  chainId: number;
  verifyingContract: string;
  signature: string;
}

export type IssuePermitsResult =
  | { ok: true; permits: AcceptancePermitJson[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "no_recommendations" };

/**
 * T-706's orchestration for `POST /tasks/:taskId/acceptance-permits`:
 * confirm `sessionAddress` owns `taskId` (same 404-for-both-"missing"-and-
 * "not-mine" collapsing as `matchTask`, mirroring T-605's convention),
 * read back the latest recommendation run's full candidate list, and sign
 * one `AcceptancePermit` per candidate. Deliberately does not persist
 * anything — no `acceptance_permits` table exists yet (T-706 capsule: that
 * table, and backfilling `consumedAt`, is Feature 8's job once it needs
 * one; this Task only signs and returns).
 */
async function issuePermitsForTask(
  pool: Pool,
  sessionAddress: string,
  taskId: string,
): Promise<IssuePermitsResult> {
  const task = await getTaskById(pool, taskId);
  if (!task || task.requesterAddress !== normalizeAddress(sessionAddress)) {
    return { ok: false, reason: "not_found" };
  }

  const candidates = await getLatestRecommendationCandidates(pool, taskId);
  if (candidates.length === 0) {
    return { ok: false, reason: "no_recommendations" };
  }

  const taskIdOnChain = deriveOnChainTaskId(taskId);
  const permits: AcceptancePermitJson[] = [];
  for (const candidate of candidates) {
    // owner_address is DB-constrained to `^0x[0-9a-f]{40}$`
    // (0004_create_agents.sql), the same guarantee chain-config.ts's own
    // `requireHexAddress` relies on before this kind of cast.
    const agentWalletAddress = candidate.agentWalletAddress as `0x${string}`;
    const issued = await issueAcceptancePermit(taskIdOnChain, agentWalletAddress);
    permits.push({
      agentId: candidate.agentId,
      taskId,
      agentWalletAddress,
      nonce: issued.nonce.toString(),
      expiry: issued.expiry,
      chainId: issued.chainId,
      verifyingContract: issued.verifyingContract,
      signature: issued.signature,
    });
  }

  return { ok: true, permits };
}

/**
 * Registers `POST /tasks/:taskId/match` (T-705). Wrapped in its own
 * `app.register(...)` at the call site (see app.ts) — same reasoning as
 * agents/routes.ts and tasks/routes.ts: `app.requireSession` as a
 * preHandler is only guaranteed to exist once `registerSessionMiddleware`'s
 * own registration has finished.
 *
 * Deliberately does NOT register any automatic trigger (e.g. on task
 * OPEN) — this Task only delivers an endpoint a requester calls explicitly
 * (T-705 capsule's explicit scope boundary).
 */
export function registerDispatchRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/tasks/:taskId/match", { preHandler: app.requireSession }, async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) {
      return reply;
    }

    const result = await matchTask(pool, sessionAddress, paramsParsed.data.taskId);
    if (!result.ok) {
      if (result.reason === "not_found") {
        return reply.status(404).send({ error: { message: "未找到该任务。" } });
      }
      return reply.status(502).send({
        error: { message: `撮合服务不可用：${result.message}` },
      });
    }

    return reply.send({
      taskId: result.taskId,
      algorithmVersion: result.algorithmVersion,
      recommendationCount: result.recommendationCount,
    });
  });

  // Public — no `requireSession` preHandler. Recommendation results are not
  // sensitive (same reasoning as `GET /tasks/:taskId` itself, T-706
  // capsule): any visitor viewing a task's detail page can see who it
  // recommends.
  app.get("/tasks/:taskId/recommendations", async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }
    const { taskId } = paramsParsed.data;

    const task = await getTaskById(pool, taskId);
    if (!task) {
      return reply.status(404).send({ error: { message: "未找到该任务。" } });
    }

    const candidates = await getLatestRecommendationCandidates(pool, taskId);
    return reply.send({
      recommendations: candidates.map((candidate) => ({
        agentId: candidate.agentId,
        rank: candidate.rank,
        slotType: candidate.slotType,
        score: candidate.score,
        reasons: candidate.reasons,
      })),
    });
  });

  app.post(
    "/tasks/:taskId/acceptance-permits",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const result = await issuePermitsForTask(pool, sessionAddress, paramsParsed.data.taskId);
      if (!result.ok) {
        if (result.reason === "not_found") {
          return reply.status(404).send({ error: { message: "未找到该任务。" } });
        }
        return reply.status(400).send({
          error: { message: "尚未生成推荐结果，请先调用 POST /tasks/:taskId/match。" },
        });
      }

      return reply.send({ permits: result.permits });
    },
  );
}
