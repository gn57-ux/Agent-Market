import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { normalizeAddress } from "../auth/nonce.store.js";
import { formatZodError } from "../../shared/zod-error.js";
import { grantAdminRole, revokeAdminRole } from "./repository.js";
import { adminAddressParamSchema, grantAdminRoleSchema } from "./schema.js";

/**
 * F-1606/T-1607: `POST`/`DELETE /admin/roles` — both require the CALLER to
 * already be an admin (`app.requireAdmin`), so only an existing admin can
 * mint another one. The very first admin can never come from this route
 * (an empty `admin_roles` table means every caller gets 403) — that
 * bootstrap gap is deliberately filled by
 * `apps/api/scripts/admin-bootstrap.ts` instead, a one-time offline CLI
 * step, never an HTTP path (design.md/T-1607's explicit decision: no env
 * var read at runtime for this, no unauthenticated bootstrap endpoint).
 */
export function registerAdminRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/admin/roles", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = grantAdminRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }
    // request.address is guaranteed set by app.requireAdmin (middleware.ts's
    // doc comment) — no non-null assertion needed since TS still sees it as
    // optional; a request that reached here always has it populated.
    const actorAddress = request.address;
    if (!actorAddress) {
      return reply.status(401).send({
        error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
      });
    }

    const targetAddress = normalizeAddress(parsed.data.address);
    const result = await grantAdminRole(pool, targetAddress, actorAddress);
    if (!result.ok) {
      return reply.status(409).send({ error: { message: "该地址已经是管理员。" } });
    }
    return reply.status(201).send({
      address: result.role.address,
      grantedBy: result.role.grantedBy,
      grantedAt: result.role.grantedAt.toISOString(),
    });
  });

  app.delete("/admin/roles/:address", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = adminAddressParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }
    const actorAddress = request.address;
    if (!actorAddress) {
      return reply.status(401).send({
        error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
      });
    }

    const targetAddress = normalizeAddress(parsed.data.address);
    const result = await revokeAdminRole(pool, targetAddress, actorAddress);
    if (!result.ok) {
      if (result.reason === "last_admin") {
        return reply.status(409).send({
          error: { message: "不能撤销最后一个管理员，会导致全部管理端点永久不可访问。" },
        });
      }
      return reply.status(404).send({ error: { message: "该地址不是管理员。" } });
    }
    return reply.status(204).send();
  });
}
