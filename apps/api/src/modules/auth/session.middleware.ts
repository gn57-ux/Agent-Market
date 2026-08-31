import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";
import { verifySession } from "./session.service.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Interface-freeze point (specs/04-wallet-identity/tasks.md's risk
     * note): Feature 5-10's protected routes attach this as their own
     * `preHandler` — `{ preHandler: app.requireSession }` — to require a
     * valid, non-revoked, non-expired session and get `request.address`
     * populated. Nothing about how a session is stored, hashed, or
     * verified is exposed here; only this one function and the resulting
     * `request.address` are the contract downstream Features build
     * against. Changing THIS signature after other Features depend on it
     * is exactly what the risk note says needs its own dedicated Task,
     * not a direct edit.
     */
    requireSession: preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** Set by `app.requireSession` once it has verified the request's
     * session cookie. Only present on routes that actually use
     * `requireSession` as a preHandler — routes that don't attach it must
     * not read this (it will be `undefined`). */
    address?: string;
  }
}

/** Exported so other modules that need a best-effort ("don't 401, just tell
 * me if there's a valid session") lookup can read the same cookie without
 * duplicating this name — see agents/routes.ts's `getOptionalSessionAddress`
 * for the one current consumer. This constant is not part of the
 * `requireSession`/`request.address` interface-freeze (this file's own
 * header doc comment) — it's just the cookie name, safe to reuse directly. */
export const SESSION_COOKIE_NAME = "session_token";

async function sessionMiddlewarePlugin(app: FastifyInstance, pool: Pool): Promise<void> {
  app.decorateRequest("address", undefined);

  app.decorate(
    "requireSession",
    async function requireSession(request: FastifyRequest, reply: FastifyReply) {
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
      request.address = verified.address;
    },
  );
}

/**
 * Registers the `app.requireSession` decorator (see its own doc comment
 * for the interface contract downstream Features depend on). Wrapped with
 * `fastify-plugin` so the decoration is visible on the root `app` instance
 * — Fastify's default plugin encapsulation would otherwise scope a
 * decorator to only this plugin's own children, making it invisible to
 * routes registered as siblings (which is exactly how every later
 * Feature's routes will be registered).
 */
export const registerSessionMiddleware = fp(
  async (app: FastifyInstance, opts: { pool: Pool }) => {
    await sessionMiddlewarePlugin(app, opts.pool);
  },
  { name: "session-middleware" },
);
