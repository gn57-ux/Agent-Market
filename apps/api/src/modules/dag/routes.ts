import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import {
  createDagSchema,
  dagIdParamSchema,
  dagNodeParamSchema,
  selectDagNodeResultSchema,
} from "./schema.js";
import { fundingVerificationSchema } from "../tasks/schema.js";
import { createChainRpcClient } from "../chain/rpc.client.js";
import {
  createDag,
  activateDag,
  retryDagNode,
  manualTakeoverDagNode,
  cancelDagNode,
  selectDagNodeResult,
  getDagDetail,
} from "./service.js";

/** Same pattern as every other module's own copy (funds/routes.ts's own
 * doc comment: deliberately re-declared per module, not shared). */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

/**
 * F-1701 (T-1701): `POST /dags` — creates a DRAFT DAG after validating its
 * topology and budget arithmetic (service.ts). Does not create any real
 * on-chain task or lock any funds — that is `POST /dags/:dagId/activate`
 * (T-1702), a separate endpoint/Task per design.md's "延迟锁定" decision
 * (requirements.md v1.2's Q-1703 resolution).
 */
export function registerDagRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/dags", { preHandler: app.requireSession }, async (request, reply) => {
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) return;

    const parsed = createDagSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const result = await createDag(pool, sessionAddress, parsed.data);
    if (!result.ok) {
      return reply.status(400).send({ error: { code: result.reason, message: result.detail } });
    }

    return reply.status(201).send({
      id: result.dag.id,
      requesterAddress: result.dag.requesterAddress,
      title: result.dag.title,
      category: result.dag.category,
      status: result.dag.status,
      createdAt: result.dag.createdAt,
      nodes: result.dag.nodes.map((node) => ({
        id: node.id,
        role: node.role,
        status: node.status,
        title: node.title,
        description: node.description,
        subBudget: node.subBudget,
        expertType: node.expertType,
        deliveryDeadline: node.deliveryDeadline,
        skillTags: node.skillTags,
      })),
    });
  });

  /**
   * F-1707/F-1708/design.md 接口契约 (T-1707): `GET /dags/:dagId` — DAG
   * structure + every node's status + the budget projection (decision 1's
   * "N 个独立链上任务的预算做 API 层聚合投影"). See service.ts's
   * `getDagDetail`/`aggregateDagBudget` doc comments for the authorization
   * rule (requester OR admin) and exactly how the budget buckets are
   * derived.
   */
  app.get("/dags/:dagId", { preHandler: app.requireSession }, async (request, reply) => {
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) return;

    const parsedParams = dagIdParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsedParams.error) } });
    }

    const result = await getDagDetail(pool, sessionAddress, parsedParams.data.dagId);
    if (!result.ok) {
      if (result.reason === "NOT_FOUND") {
        return reply.status(404).send({ error: { message: "DAG 不存在。" } });
      }
      return reply
        .status(403)
        .send({ error: { message: "只有 DAG 的创建者或管理员可以查看该 DAG。" } });
    }

    return reply.send({
      id: result.dag.id,
      requesterAddress: result.dag.requesterAddress,
      title: result.dag.title,
      category: result.dag.category,
      status: result.dag.status,
      createdAt: result.dag.createdAt,
      nodes: result.dag.nodes.map((node) => ({
        id: node.id,
        role: node.role,
        nodeStatus: node.nodeStatus,
        title: node.title,
        subBudget: node.subBudget,
        expertType: node.expertType,
        taskId: node.taskId,
        taskStatus: node.taskStatus,
        taskBudget: node.taskBudget,
        selectedPredecessorIds: node.selectedPredecessorIds,
      })),
      edges: result.dag.edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
      })),
      budget: result.budget,
    });
  });

  /**
   * F-1701/T-1702: `POST /dags/:dagId/activate` — see service.ts's
   * `activateDag` doc comment for exactly what this does and does not do
   * (creates real `tasks` DRAFT rows for currently-ready nodes; does NOT
   * perform or wait for any on-chain transaction itself).
   */
  app.post("/dags/:dagId/activate", { preHandler: app.requireSession }, async (request, reply) => {
    const sessionAddress = requireSessionAddress(request, reply);
    if (!sessionAddress) return;

    const parsedParams = dagIdParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsedParams.error) } });
    }

    const result = await activateDag(pool, sessionAddress, parsedParams.data.dagId);
    if (!result.ok) {
      if (result.reason === "NOT_FOUND") {
        return reply.status(404).send({ error: { message: "DAG 不存在。" } });
      }
      if (result.reason === "FORBIDDEN") {
        return reply.status(403).send({ error: { message: "只有 DAG 的创建者可以激活它。" } });
      }
      return reply.status(409).send({ error: { code: result.reason, message: result.detail } });
    }

    return reply.status(200).send({ activatedNodeIds: result.activatedNodeIds });
  });

  /**
   * F-1705/design.md 接口契约 (T-1705): `POST /dags/:dagId/nodes/:nodeId/retry`
   * — see service.ts's `retryDagNode` doc comment for exactly which nodes
   * are eligible (terminally `FAILED`, any cause) and what this creates.
   */
  app.post(
    "/dags/:dagId/nodes/:nodeId/retry",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return;

      const parsedParams = dagNodeParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsedParams.error) } });
      }

      const result = await retryDagNode(
        pool,
        sessionAddress,
        parsedParams.data.dagId,
        parsedParams.data.nodeId,
      );
      if (!result.ok) {
        if (result.reason === "NOT_FOUND") {
          return reply.status(404).send({ error: { message: "DAG 或节点不存在。" } });
        }
        if (result.reason === "FORBIDDEN") {
          return reply.status(403).send({ error: { message: "只有 DAG 的创建者可以重试节点。" } });
        }
        return reply.status(409).send({ error: { code: result.reason, message: result.detail } });
      }

      return reply
        .status(200)
        .send({ activatedNodeId: result.activatedNodeId, taskId: result.taskId });
    },
  );

  /**
   * F-1705/design.md 接口契约 (T-1705): `POST
   * /dags/:dagId/nodes/:nodeId/manual-takeover` — see service.ts's
   * `manualTakeoverDagNode` doc comment. No request body: this is a pure
   * pause flag, no chain interaction.
   */
  app.post(
    "/dags/:dagId/nodes/:nodeId/manual-takeover",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return;

      const parsedParams = dagNodeParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsedParams.error) } });
      }

      const result = await manualTakeoverDagNode(
        pool,
        sessionAddress,
        parsedParams.data.dagId,
        parsedParams.data.nodeId,
      );
      if (!result.ok) {
        if (result.reason === "NOT_FOUND") {
          return reply.status(404).send({ error: { message: "DAG 或节点不存在。" } });
        }
        if (result.reason === "FORBIDDEN") {
          return reply
            .status(403)
            .send({ error: { message: "只有 DAG 的创建者可以人工接管节点。" } });
        }
        return reply.status(409).send({ error: { code: result.reason, message: result.detail } });
      }

      return reply.status(200).send({ status: "MANUAL_TAKEOVER" });
    },
  );

  /**
   * F-1705/design.md 接口契约 (T-1705): `POST
   * /dags/:dagId/nodes/:nodeId/cancel` — see service.ts's `cancelDagNode`
   * doc comment: the client must already have submitted a real, confirmed
   * `cancelTask` transaction for this node's own task (same two-step
   * "submit tx, then verify" shape as every other chain-verification
   * endpoint in this codebase, `fundingVerificationSchema`'s `{ txHash }`
   * body reused as-is).
   */
  app.post(
    "/dags/:dagId/nodes/:nodeId/cancel",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return;

      const parsedParams = dagNodeParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsedParams.error) } });
      }
      const parsedBody = fundingVerificationSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsedBody.error) } });
      }

      const rpc = createChainRpcClient();
      const result = await cancelDagNode(
        pool,
        rpc,
        sessionAddress,
        parsedParams.data.dagId,
        parsedParams.data.nodeId,
        parsedBody.data.txHash,
      );
      if (!result.ok) {
        if (result.reason === "DAG_NOT_FOUND" || result.reason === "NODE_NOT_FOUND") {
          return reply.status(404).send({ error: { message: "DAG 或节点不存在。" } });
        }
        if (result.reason === "FORBIDDEN") {
          return reply.status(403).send({ error: { message: "只有 DAG 的创建者可以取消节点。" } });
        }
        if (result.reason === "NODE_NOT_ACTIVE") {
          return reply
            .status(409)
            .send({ error: { message: "该节点尚无关联的链上任务，无法取消。" } });
        }
        if (result.reason === "not_found") {
          return reply.status(404).send({ error: { message: "未找到该节点关联的任务。" } });
        }
        if (result.reason === "conflict") {
          return reply.status(409).send({
            error: { message: `节点关联任务当前状态为 ${result.currentStatus}，无法取消。` },
          });
        }
        return reply.status(400).send({ error: { code: result.code, message: result.message } });
      }

      return reply.send({ status: result.status, confirmations: result.confirmations });
    },
  );

  /**
   * F-1706/design.md 接口契约 (T-1706): `POST
   * /dags/:dagId/nodes/:nodeId/select-result` — only valid on
   * `node_role = AGGREGATE` nodes. See service.ts's `selectDagNodeResult`
   * doc comment: this endpoint touches ONLY `task_dag_nodes.
   * selected_predecessor_ids`, never any `tasks` row — AC-1704's own
   * "未采纳交付仍正确结算" guarantee holds by construction, not by
   * convention.
   */
  app.post(
    "/dags/:dagId/nodes/:nodeId/select-result",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) return;

      const parsedParams = dagNodeParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsedParams.error) } });
      }
      const parsedBody = selectDagNodeResultSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({ error: { message: formatZodError(parsedBody.error) } });
      }

      const result = await selectDagNodeResult(
        pool,
        sessionAddress,
        parsedParams.data.dagId,
        parsedParams.data.nodeId,
        parsedBody.data.selectedNodeIds,
      );
      if (!result.ok) {
        if (result.reason === "NOT_FOUND") {
          return reply.status(404).send({ error: { message: "DAG 或节点不存在。" } });
        }
        if (result.reason === "FORBIDDEN") {
          return reply
            .status(403)
            .send({ error: { message: "只有 DAG 的创建者可以选择汇总节点的结果。" } });
        }
        return reply.status(409).send({ error: { code: result.reason, message: result.detail } });
      }

      return reply.status(200).send({ selectedNodeIds: result.selectedNodeIds });
    },
  );
}
