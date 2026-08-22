import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import { getPool } from "./db/pool.js";
import { registerAgentsRoutes } from "./modules/agents/routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerSessionMiddleware } from "./modules/auth/session.middleware.js";
import { registerTasksRoutes } from "./modules/tasks/routes.js";

export interface BuildAppOptions {
  /** Test seam: pass a Pool bound to a throwaway test database instead of
   * the module-level singleton (which reads DATABASE_URL). Production
   * callers (server.ts) omit this and get `getPool()`. */
  pool?: Pool;
  /** Test seam (T-406, AC-405): override Fastify's `logger` option — e.g.
   * to point pino at a captured stream so a test can assert on the actual
   * log output (no signature/nonce/session-token content), rather than
   * only reasoning about it. Production callers omit this and get the
   * default `true`. */
  logger?: FastifyServerOptions["logger"];
}

/** The frontend origin allowed to call this API with credentials
 * (cross-origin cookies). Codex review (T-404 P1): without CORS support at
 * all, a browser blocks the frontend's JSON POST calls to /auth/nonce and
 * /auth/verify outright (Vite's dev server and this API listen on
 * different ports/origins), and even once allowed, a session cookie only
 * flows cross-origin if the response opts into `credentials: true` for a
 * SPECIFIC, non-wildcard origin (the two are mutually exclusive per the
 * Fetch spec: `Access-Control-Allow-Credentials: true` cannot be paired
 * with `Access-Control-Allow-Origin: *`). No default beyond local dev's
 * Vite port — a real deployment must set this explicitly. */
function webOrigin(): string {
  return process.env.WEB_ORIGIN ?? "http://localhost:5173";
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const pool = options.pool ?? getPool();

  void app.register(cors, { origin: webOrigin(), credentials: true });
  void app.register(cookie);
  void app.register(registerSessionMiddleware, { pool });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerAuthRoutes(app, pool);

  // Wrapped in its own app.register(...) (not called directly like
  // registerAuthRoutes above): POST /agents uses `app.requireSession` as a
  // preHandler, and that decorator is only guaranteed to exist once
  // registerSessionMiddleware's own registration above has finished — see
  // session.middleware.ts's doc comment.
  void app.register(async (instance) => {
    registerAgentsRoutes(instance, pool);
  });

  // Same reasoning as the agents registration above: POST /tasks/drafts and
  // PATCH /tasks/:taskId/draft both use `app.requireSession` as a
  // preHandler, so this needs its own `app.register(...)` after
  // registerSessionMiddleware has finished.
  void app.register(async (instance) => {
    registerTasksRoutes(instance, pool);
  });

  return app;
}
