import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createAgent } from "./service.js";
import { createAgentSchema } from "./schema.js";

/**
 * Registers `POST /agents` (F-501). Must be added via `app.register(...)`
 * (see app.ts) rather than called directly after `buildApp()` returns:
 * `{ preHandler: app.requireSession }` depends on the `requireSession`
 * decorator that `registerSessionMiddleware` adds, and avvio only
 * guarantees that decorator exists once that plugin's own registration has
 * finished — the same boot-order constraint `session.middleware.ts`'s doc
 * comment describes.
 */
export function registerAgentsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/agents", { preHandler: app.requireSession }, async (request, reply) => {
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    // requireSession's preHandler already returned a 401 and short-circuited
    // the request if this weren't set — this check exists only to satisfy
    // the type system without a non-null assertion, not because it's
    // expected to trigger in practice.
    if (!request.address) {
      return reply.status(401).send({
        error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
      });
    }
    const agent = await createAgent(pool, request.address, parsed.data);

    return reply.status(201).send({
      agentId: agent.id,
      status: agent.status,
      createdAt: agent.createdAt.toISOString(),
      completedTaskCount: agent.completedTaskCount,
      qualityScore: agent.qualityScore,
    });
  });
}
