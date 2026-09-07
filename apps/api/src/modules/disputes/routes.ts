import type { ErrorCode } from "@agent-market/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { serverSessionId, writeInteractionEventToOutbox } from "../analytics/outbox-event.js";
import { verifySession } from "../auth/session.service.js";
import { createChainRpcClient } from "../chain/rpc.client.js";
import type { TaskStatusValue } from "../tasks/repository.js";
import { getTaskById } from "../tasks/repository.js";
import { getDisputeForTask, getOpenDisputeForTask, insertDispute } from "./repository.js";
import {
  listDisputeEvidenceQuerySchema,
  submitDisputeEvidenceSchema,
  submitDisputeSchema,
  taskIdParamSchema,
} from "./schema.js";
import { computeEvidenceHash } from "./evidence-hash.js";
import { getDisputeView } from "./service.js";
import {
  insertDisputeEvidenceSubmission,
  listDisputeEvidenceSubmissions,
} from "./evidence-repository.js";
import { resolveDisputeAccessLevel, ARBITRATOR_ROLE } from "./access-guard.js";
import { normalizeAddress } from "../auth/nonce.store.js";
import { resolveChainConfig } from "@agent-market/domain";

const TASK_STATE_CONFLICT: ErrorCode = "TASK_STATE_CONFLICT";

/** Same pattern as deliverables/routes.ts's own copy of this helper —
 * deliberately re-declared per module rather than shared/exported,
 * matching this codebase's established convention for this exact helper. */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

// Matches session.middleware.ts's own SESSION_COOKIE_NAME literal (also
// re-declared in auth/routes.ts and tasks/routes.ts) — not exported from
// either module to import here, so this follows the same existing
// local-constant pattern rather than introducing a new cross-module
// dependency for one string.
const SESSION_COOKIE_NAME = "session_token";

/**
 * `GET /tasks/:taskId/disputes` is a public read (no `app.requireSession`
 * preHandler — a 401 would break anonymous/unrelated visibility into
 * dispute status), but still needs to know the caller's identity WHEN a
 * valid session is present, to decide (via `access-guard.ts`) whether the
 * full response — including `evidenceSummary` — may be shown. Exact same
 * shape and reasoning as `tasks/routes.ts`'s `readOptionalSessionAddress`
 * (Codex review, T-605 round 1, P1, for the analogous DRAFT-visibility
 * problem): reads the session cookie the same way `app.requireSession`
 * does, but never 401s — an absent, malformed, or expired session simply
 * resolves to `null` (anonymous), same as if no cookie were sent at all.
 */
async function readOptionalSessionAddress(
  request: FastifyRequest,
  pool: Pool,
): Promise<string | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  const verified = await verifySession(pool, token);
  return verified?.address ?? null;
}

/**
 * `POST /tasks/:taskId/disputes` (F-1003), `GET /tasks/:taskId/disputes`
 * (F-1004). This is the OFF-CHAIN half of dispute submission — the
 * on-chain `openDispute(taskId, evidenceHash)` call itself is the
 * frontend's own separate wallet transaction (`DisputeSection.tsx`, T-1005),
 * verified independently by `POST /tasks/:taskId/dispute-verifications`
 * (tasks/routes.ts, same file `result-verifications`/
 * `settlement-verifications` already live in — dispute event-sync is this
 * same Task's scope but registered there to keep every settlement-adjacent
 * event-verification route in one place, matching this codebase's
 * established per-concern route-file grouping).
 */
export function registerDisputesRoutes(app: FastifyInstance, pool: Pool): void {
  app.post(
    "/tasks/:taskId/disputes",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const bodyParsed = submitDisputeSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: bodyParsed.error.message } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const task = await getTaskById(pool, paramsParsed.data.taskId);
      if (!task) {
        return reply.status(404).send({ error: { message: "任务不存在。" } });
      }
      if (task.requesterAddress.toLowerCase() !== sessionAddress.toLowerCase()) {
        return reply.status(403).send({ error: { message: "只有本任务的需求方才能发起争议。" } });
      }

      const evidenceHash = computeEvidenceHash(bodyParsed.data.evidenceSummary);

      // Codex review (T-1002 round 2, P2): the status/deadline check and
      // the INSERT used to run as two separate, unlocked reads/writes — a
      // concurrent settlement verification could move the task out of
      // `SUBMITTED` in between, leaving a permanently `OPEN` dispute row
      // behind on an already-terminal task (blocking any future dispute via
      // `disputes_task_id_unique_open`, and misreporting via `GET
      // .../disputes`). `SELECT ... FOR UPDATE` here takes the SAME row
      // lock `transitionTaskStatus` (tasks/repository.ts) takes for every
      // settlement/dispute-resolution transition, so the two can never
      // interleave: whichever acquires the lock first fully commits (or
      // rolls back) before the other's re-check runs.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{
          status: TaskStatusValue;
          review_deadline: Date | null;
        }>(`SELECT status, review_deadline FROM tasks WHERE id = $1 FOR UPDATE`, [task.id]);
        const locked = rows[0];
        if (!locked) {
          await client.query("ROLLBACK");
          return reply.status(404).send({ error: { message: "任务不存在。" } });
        }
        // Mirrors what `TaskEscrow.openDispute` itself requires on-chain
        // (`status == SUBMITTED`, strictly before `reviewDeadline`) — a
        // fast, UX-only precondition; the contract remains the
        // authoritative check, this just avoids letting a doomed on-chain
        // call get this far in the first place.
        if (locked.status !== "SUBMITTED") {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: {
              code: TASK_STATE_CONFLICT,
              message: `任务当前状态为 ${locked.status}，无法发起争议。`,
            },
          });
        }
        if (locked.review_deadline && locked.review_deadline.getTime() <= Date.now()) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: { code: TASK_STATE_CONFLICT, message: "验收窗口已过，无法发起争议。" },
          });
        }

        const dispute = await insertDispute(client, {
          taskId: task.id,
          requesterAddress: sessionAddress,
          reason: bodyParsed.data.reason,
          evidenceSummary: bodyParsed.data.evidenceSummary,
          evidenceHash,
        });
        if (!dispute) {
          await client.query("ROLLBACK");
          return reply.status(409).send({
            error: { code: TASK_STATE_CONFLICT, message: "该任务已有一个正在处理的争议。" },
          });
        }

        // F-1901 (T-1901): real DISPUTE event — this is the actual act of
        // a requester opening a dispute (as opposed to
        // `tasks/service.ts`'s `verifyDisputeOpen`, which only confirms
        // the on-chain tx that follows this call; recording it here, not
        // there, matches F-1901's literal "争议" wording).
        await writeInteractionEventToOutbox(client, {
          eventType: "DISPUTE",
          sessionId: serverSessionId(task.id),
          clientEventId: `dispute:${task.id}`,
          taskId: task.id,
          agentId: task.acceptedAgentId ?? undefined,
          actorAddress: sessionAddress,
        });

        await client.query("COMMIT");
        return reply
          .status(201)
          .send({ disputeId: dispute.id, evidenceHash: dispute.evidenceHash });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  // Public read (design.md's F-1004: "展示争议状态与结果"), but the FULL
  // response — including `evidenceSummary` — is restricted to this
  // dispute's actual participants (the task's requester, its accepted
  // Agent) and whoever currently holds `TaskEscrow.ARBITRATOR_ROLE`
  // on-chain (T-1002 human-review fix, Codex round 2 P1: task IDs are
  // discoverable via the public tasks list, so an unrestricted response
  // let any anonymous or unrelated caller read potentially private
  // dispute evidence). All of that decision-making — including the
  // on-chain arbitrator check — lives in `service.ts`'s `getDisputeView`
  // (which itself delegates the actual authorization call to
  // `access-guard.ts`); this route is just the HTTP wiring. Everyone who
  // isn't a participant/arbitrator still gets a 200 with the minimal
  // public projection design.md's own original interface contract
  // specifies (`disputeId, status, reason, resolution?, resolvedAt?`), so
  // this route stays truly public for the "just show me the outcome"
  // case rather than 401ing anonymous/unrelated viewers.
  app.get("/tasks/:taskId/disputes", async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }

    const sessionAddress = await readOptionalSessionAddress(request, pool);
    // `createChainRpcClient` is passed as a FACTORY (not called here) —
    // see service.ts's `getDisputeView` doc comment: it's only actually
    // invoked when a viewer needs the on-chain arbitrator check, which
    // most GET requests never reach. The error callback logs a failed
    // role check (RPC/chain config unavailable) via Fastify's own logger
    // — never sent to the client, which always gets a clean 200 with the
    // fail-closed public projection in that case (T-1002 human-review
    // fix round 2, P2).
    const result = await getDisputeView(
      pool,
      createChainRpcClient,
      sessionAddress,
      paramsParsed.data.taskId,
      (error) =>
        app.log.error(
          { err: error, taskId: paramsParsed.data.taskId },
          "disputes: on-chain arbitrator role check failed, failing closed to public projection",
        ),
    );
    if (!result.ok) {
      if (result.reason === "task_not_found") {
        return reply.status(404).send({ error: { message: "任务不存在。" } });
      }
      return reply.status(404).send({ error: { message: "该任务尚无争议记录。" } });
    }

    return reply.send(result.view);
  });

  // Feature 21 (arbitration-committee), T-2108 (F-2110). Only this
  // dispute's actual two parties may submit a new round of evidence —
  // deliberately NOT the arbitrator (design.md's own "多方" wording means
  // the disputing parties, requester and Agent, not the reviewer of that
  // evidence). Requires a real OPEN dispute — submitting evidence for an
  // already-resolved case would be meaningless (nothing left to review).
  app.post(
    "/tasks/:taskId/disputes/evidence",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const bodyParsed = submitDisputeEvidenceSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: bodyParsed.error.message } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return reply;

      const task = await getTaskById(pool, paramsParsed.data.taskId);
      if (!task) {
        return reply.status(404).send({ error: { message: "任务不存在。" } });
      }
      const dispute = await getOpenDisputeForTask(pool, task.id);
      if (!dispute) {
        return reply.status(404).send({ error: { message: "该任务当前没有正在处理的争议。" } });
      }

      const normalizedSession = sessionAddress.toLowerCase();
      let submitterRole: "REQUESTER" | "AGENT";
      if (normalizedSession === task.requesterAddress.toLowerCase()) {
        submitterRole = "REQUESTER";
      } else if (
        task.acceptedAgentAddress &&
        normalizedSession === task.acceptedAgentAddress.toLowerCase()
      ) {
        submitterRole = "AGENT";
      } else {
        return reply
          .status(403)
          .send({ error: { message: "只有本争议的需求方或 Agent 才能提交举证。" } });
      }

      const submission = await insertDisputeEvidenceSubmission(pool, {
        disputeId: dispute.id,
        submitterAddress: sessionAddress,
        submitterRole,
        content: bodyParsed.data.content,
      });
      // N4 P1 fix (round 1): `null` means the dispute genuinely stopped
      // being OPEN between the check above and this atomic insert (a
      // real concurrent resolution committed in that gap) — the earlier
      // `getOpenDisputeForTask` check is a fast pre-filter, not the
      // authoritative one; this re-check inside `insertDisputeEvidence
      // Submission`'s own SQL is.
      if (!submission) {
        return reply.status(409).send({ error: { message: "该争议已被裁决，无法再提交举证。" } });
      }
      return reply.status(201).send({
        id: submission.id,
        disputeId: submission.disputeId,
        submitterAddress: submission.submitterAddress,
        submitterRole: submission.submitterRole,
        content: submission.content,
        submittedAt: submission.submittedAt.toISOString(),
      });
    },
  );

  // Same "full" access gate `GET /tasks/:taskId/disputes` already
  // establishes (`access-guard.ts`'s `resolveDisputeAccessLevel`) — the
  // multi-round evidence is exactly as private as `evidenceSummary`
  // itself, read by the same three real parties (requester, Agent,
  // whoever currently holds `ARBITRATOR_ROLE` on-chain).
  app.get("/tasks/:taskId/disputes/evidence", async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }
    const queryParsed = listDisputeEvidenceQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({ error: { message: queryParsed.error.message } });
    }
    const task = await getTaskById(pool, paramsParsed.data.taskId);
    if (!task) {
      return reply.status(404).send({ error: { message: "任务不存在。" } });
    }
    const dispute =
      (await getOpenDisputeForTask(pool, task.id)) ?? (await getDisputeForTask(pool, task.id));
    if (!dispute) {
      return reply.status(404).send({ error: { message: "该任务尚无争议记录。" } });
    }

    const sessionAddress = await readOptionalSessionAddress(request, pool);
    const accessLevel = await resolveDisputeAccessLevel({
      sessionAddress,
      requesterAddress: task.requesterAddress,
      acceptedAgentAddress: task.acceptedAgentAddress,
      isArbitrator: async (account) => {
        const normalizedAccount = normalizeAddress(account) as `0x${string}`;
        const chainConfig = resolveChainConfig(process.env);
        return createChainRpcClient().readHasRole(
          chainConfig.addresses.taskEscrow,
          ARBITRATOR_ROLE,
          normalizedAccount,
        );
      },
      onArbitratorCheckError: (error) =>
        app.log.error(
          { err: error, taskId: paramsParsed.data.taskId },
          "disputes: on-chain arbitrator role check failed, failing closed to public projection",
        ),
    });
    if (accessLevel !== "full") {
      return reply.status(403).send({ error: { message: "无权查看本争议的举证记录。" } });
    }

    const { submissions, nextCursor } = await listDisputeEvidenceSubmissions(pool, dispute.id, {
      limit: queryParsed.data.limit,
      after: queryParsed.data.after,
    });
    return reply.status(200).send({
      submissions: submissions.map((s) => ({
        id: s.id,
        disputeId: s.disputeId,
        submitterAddress: s.submitterAddress,
        submitterRole: s.submitterRole,
        content: s.content,
        submittedAt: s.submittedAt.toISOString(),
      })),
      nextCursor,
    });
  });
}
