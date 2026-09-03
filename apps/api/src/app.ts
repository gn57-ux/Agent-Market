import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import { getPool } from "./db/pool.js";
import { registerAgentsRoutes } from "./modules/agents/routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerSessionMiddleware } from "./modules/auth/session.middleware.js";
import { registerDeliverablesRoutes } from "./modules/deliverables/routes.js";
import { registerDisputesRoutes } from "./modules/disputes/routes.js";
import { registerDispatchRoutes } from "./modules/dispatch/routes.js";
import { registerRatingsRoutes } from "./modules/ratings/routes.js";
import { registerTasksRoutes } from "./modules/tasks/routes.js";
import { registerOfficeRoutes } from "./modules/office/routes.js";
import type { OfficeFundsReader } from "./modules/office/funds-reader.js";

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
  officeFundsReader?: OfficeFundsReader;
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

  // Wrapped in its own app.register(...): GET /auth/session (Task E's whoami
  // restore) uses `app.requireSession` as a preHandler alongside /auth/nonce,
  // /auth/verify, and /auth/logout (which don't need it), and that decorator
  // is only guaranteed to exist once registerSessionMiddleware's own
  // registration above has finished — see session.middleware.ts's doc
  // comment. Calling registerAuthRoutes directly (un-deferred) would leave
  // `preHandler: app.requireSession` evaluating to `preHandler: undefined`
  // at the point this function runs synchronously, silently registering an
  // unprotected route.
  void app.register(async (instance) => {
    registerAuthRoutes(instance, pool);
  });

  // Same reasoning as the auth registration above: POST /agents uses
  // `app.requireSession` as a preHandler, and that decorator is only
  // guaranteed to exist once registerSessionMiddleware's own registration
  // above has finished — see session.middleware.ts's doc comment.
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

  // Same reasoning as the two registrations above: POST /tasks/:taskId/match
  // uses `app.requireSession` as a preHandler (T-705).
  void app.register(async (instance) => {
    registerDispatchRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: POST /tasks/:taskId/deliverables
  // uses `app.requireSession` as a preHandler (T-902).
  void app.register(async (instance) => {
    registerDeliverablesRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: POST /tasks/:taskId/disputes
  // uses `app.requireSession` as a preHandler (T-1002).
  void app.register(async (instance) => {
    registerDisputesRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: POST /tasks/:taskId/ratings
  // uses `app.requireSession` as a preHandler (T-1003).
  void app.register(async (instance) => {
    registerRatingsRoutes(instance, pool);
  });

  void app.register(async (instance) => {
    registerOfficeRoutes(instance, pool, options.officeFundsReader);
  });

  return app;
}
