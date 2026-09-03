import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";
import { SESSION_COOKIE_NAME } from "../auth/session.middleware.js";
import { verifySession } from "../auth/session.service.js";
import { isAdminAddress } from "./repository.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * F-1606/design.md: "管理员端点统一挂一个 app.requireAdmin 中间件
     * ...复用 app.requireSession 的模式，在其基础上叠加 isAdminAddress
     * 检查，不在每个路由里重复判断逻辑". Every `admin_roles`-gated route
     * attaches this as its own `preHandler` and gets `request.address`
     * populated exactly like `app.requireSession` does (same contract,
     * same field) — a handler that needs "which admin is this" reads
     * `request.address`, never re-verifies the session itself.
     *
     * Deliberately its OWN preHandler (reusing `verifySession` internally,
     * not literally chaining `[app.requireSession, app.requireAdmin]`) so
     * this decorator alone is a complete, self-sufficient authorization
     * check — a route that forgets to also list `app.requireSession`
     * can't accidentally end up admin-gated-but-not-session-gated.
     */
    requireAdmin: preHandlerHookHandler;
  }
}

async function adminMiddlewarePlugin(app: FastifyInstance, pool: Pool): Promise<void> {
  app.decorate(
    "requireAdmin",
    async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (!token) {
        return reply.status(401).send({
          error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" },
        });
      }
      const verified = await verifySession(pool, token);
      if (!verified) {
        return reply.status(401).send({
          error: { message: "会话无效、已过期或已登出。" },
        });
      }
      // 运行时查表校验（design.md："不信任前端声明"）——即使调用方在会话中
      // 曾是管理员，撤销后必须立刻反映在下一次请求上，不缓存判定结果。
      const isAdmin = await isAdminAddress(pool, verified.address);
      if (!isAdmin) {
        return reply.status(403).send({
          error: { message: "该操作仅限管理员执行。" },
        });
      }
      request.address = verified.address;
    },
  );
}

/**
 * Registers the `app.requireAdmin` decorator. Wrapped with `fastify-plugin`
 * for the same reason `registerSessionMiddleware` is (session.middleware.ts's
 * doc comment): without it, Fastify's default plugin encapsulation would
 * scope the decorator to only this plugin's own children, invisible to
 * routes registered as siblings.
 */
export const registerAdminMiddleware = fp(
  async (app: FastifyInstance, opts: { pool: Pool }) => {
    await adminMiddlewarePlugin(app, opts.pool);
  },
  { name: "admin-middleware" },
);
