import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import { getPool } from "./db/pool.js";
import { registerAdminDashboardRoutes } from "./modules/admin/dashboard-routes.js";
import { registerAnalyticsRoutes } from "./modules/analytics/routes.js";
import { registerAdminMiddleware } from "./modules/admin/middleware.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { registerAdminAgentReviewRoutes } from "./modules/agents/admin-review-routes.js";
import { registerAgentsRoutes } from "./modules/agents/routes.js";
import type { IdentityProvider } from "./modules/auth/identity-provider.js";
import { createPrivyIdentityProvider } from "./modules/auth/privy-identity-provider.js";
import { registerPrivyAuthRoutes } from "./modules/auth/privy-routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerSessionMiddleware } from "./modules/auth/session.middleware.js";
import { createSiweIdentityProvider } from "./modules/auth/siwe-identity-provider.js";
import { registerDeliverablesRoutes } from "./modules/deliverables/routes.js";
import { registerDisputesRoutes } from "./modules/disputes/routes.js";
import { registerDispatchRoutes } from "./modules/dispatch/routes.js";
import { registerFundsRoutes } from "./modules/funds/routes.js";
import { registerRatingsRoutes } from "./modules/ratings/routes.js";
import { registerTasksRoutes } from "./modules/tasks/routes.js";
import { registerOfficeRoutes } from "./modules/office/routes.js";
import { registerDagRoutes } from "./modules/dag/routes.js";
import { registerEvaluationAdminRoutes } from "./modules/evaluation/admin-routes.js";
import { registerEvaluationRoutes } from "./modules/evaluation/routes.js";
import { registerAntifraudAdminRoutes } from "./modules/antifraud/admin-routes.js";
import { registerRiskHoldAdminRoutes } from "./modules/risk-hold/admin-routes.js";
import { registerArbitrationCommitteeAdminRoutes } from "./modules/arbitration/admin-routes.js";
import { registerCustomerServiceRoutes } from "./modules/customer-service/routes.js";
import type { OfficeFundsReader } from "./modules/office/funds-reader.js";
import { httpRequestDuration, metricsContentType, renderMetrics } from "./observability/metrics.js";

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
  /** F-1601 (Feature 16, T-1600) composition-root seam: which
   * `IdentityProvider` implementation `/auth/verify` verifies logins
   * against. Production callers omit this and get
   * `createSiweIdentityProvider()` (today's only real implementation);
   * F-1603's rollback capability is exactly "pass a different
   * implementation here," and tests can inject a fake to exercise
   * `completeLogin`'s own transaction-atomicity logic without a real
   * signature. */
  identityProvider?: IdentityProvider;
  /** F-1601 (Feature 16, T-1601) composition-root seam: which
   * `IdentityProvider` implementation `/auth/verify/privy` verifies
   * logins against. Production callers omit this and get
   * `createPrivyIdentityProvider()`, which itself returns `undefined`
   * when `PRIVY_APP_ID`/`PRIVY_APP_SECRET` aren't set — in that case this
   * route simply isn't registered (decision 4: missing Privy credentials
   * must degrade gracefully, not crash startup or block the still
   * fully-independent SIWE path). Separate from `identityProvider` above
   * (SIWE stays the default for `/auth/verify`; the two providers/routes
   * coexist, this is not a single either/or switch) — see design decision
   * 5. */
  privyIdentityProvider?: IdentityProvider;
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
  // F-1606 (T-1607): registered right after session middleware — like
  // `app.requireSession`, `app.requireAdmin` must exist before any route
  // below references it as a `preHandler` (same ordering reasoning as
  // registerSessionMiddleware's own comment on the line above).
  void app.register(registerAdminMiddleware, { pool });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // N4 real finding (round 1, T-2305, P1): this route shares the SAME
  // listening port/host (`0.0.0.0`) as every public API route — the
  // original comment here claimed network-level isolation the code never
  // actually implemented, meaning any client reaching the public API could
  // also scrape internal metrics (information disclosure) and trigger this
  // route's two DB queries on demand (resource exhaustion). A shared
  // bearer token (Prometheus's own standard `bearer_token`/
  // `bearer_token_file` scrape-config field, not a bespoke scheme) is real,
  // enforceable defense-in-depth regardless of whatever network topology a
  // given deployment does or doesn't also add — session/admin middleware
  // is deliberately NOT reused here (this is a machine-to-machine scrape
  // credential, not a user session). No token configured means this route
  // refuses every request (fail closed) rather than silently falling back
  // to "no protection" the way a missing PRIVY_APP_SECRET gracefully
  // degrades — metrics exposure has no equivalent safe default.
  app.get("/internal/metrics", async (request, reply) => {
    const expectedToken = process.env.METRICS_SCRAPE_TOKEN;
    const authHeader = request.headers.authorization;
    const providedToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!expectedToken || providedToken !== expectedToken) {
      return reply.status(401).send({ error: { message: "unauthorized" } });
    }
    const body = await renderMetrics(pool);
    return reply.header("content-type", metricsContentType).send(body);
  });

  // Observes every request's duration — registered as an onResponse hook
  // (not per-route) so no existing route needs to change to be measured;
  // `/internal/metrics` itself is deliberately excluded (a scrape endpoint
  // counting its own scrapes would be a confusing, self-referential series
  // with no real observability value).
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url === "/internal/metrics") {
      return;
    }
    httpRequestDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
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
    registerAuthRoutes(instance, pool, options.identityProvider ?? createSiweIdentityProvider());
  });

  // F-1601 (T-1601): registers POST /auth/verify/privy alongside (not
  // instead of) the SIWE routes above — decision 5, both providers must be
  // simultaneously available, not a single default swapped out. Skipped
  // entirely (not a startup failure) when no Privy provider was injected
  // and none can be constructed from env (missing PRIVY_APP_ID/
  // PRIVY_APP_SECRET) — decision 4's graceful-degradation requirement.
  const privyProvider = options.privyIdentityProvider ?? createPrivyIdentityProvider();
  if (privyProvider) {
    void app.register(async (instance) => {
      registerPrivyAuthRoutes(instance, pool, privyProvider);
    });
  } else {
    app.log.info(
      "Privy identity provider not configured (PRIVY_APP_ID/PRIVY_APP_SECRET unset) — " +
        "/auth/verify/privy not registered; SIWE login remains available.",
    );
  }

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

  // Same reasoning as the registrations above: POST /dags uses
  // `app.requireSession` as a preHandler (T-1701).
  void app.register(async (instance) => {
    registerDagRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: POST /admin/roles and
  // DELETE /admin/roles/:address use `app.requireAdmin` (itself only
  // guaranteed to exist once registerAdminMiddleware's own registration
  // above has finished — see admin/middleware.ts's doc comment) (T-1607).
  void app.register(async (instance) => {
    registerAdminRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: GET /admin/agents/review-queue
  // and POST /admin/agents/:agentId/{approve,reject,suspend} use
  // `app.requireAdmin` as a preHandler (T-1605).
  void app.register(async (instance) => {
    registerAdminAgentReviewRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: GET /funds/requester/...
  // and GET /funds/agent/... use `app.requireSession`, GET /funds/platform
  // uses `app.requireAdmin` (T-1608).
  void app.register(async (instance) => {
    registerFundsRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: GET /admin/dashboard uses
  // `app.requireAdmin` (T-1608b).
  void app.register(async (instance) => {
    registerAdminDashboardRoutes(instance, pool);
  });

  // F-1901/F-1902 (T-1901): `POST /analytics/events` deliberately does NOT
  // use `app.requireSession` — it must stay reachable from an anonymous
  // browsing session (VIEW/CLICK happen before a wallet is ever connected)
  // — so, unlike every registration above, it does not need to wait for
  // `registerSessionMiddleware` to have attached that decorator first.
  registerAnalyticsRoutes(app, pool);

  // Same reasoning as the registrations above: POST /evaluation/tasks/
  // :taskId/submit uses `app.requireSession` (Feature 20, T-2001).
  void app.register(async (instance) => {
    registerEvaluationRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: GET /admin/evaluation/
  // pending-review and POST /admin/evaluation/results/:id/review use
  // `app.requireAdmin` (Feature 20, T-2002).
  void app.register(async (instance) => {
    registerEvaluationAdminRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: GET /admin/risk-signals and
  // POST /admin/risk-signals/:id/{confirm,dismiss} use `app.requireAdmin`
  // (Feature 20, T-2008 — `confirm` on SCORE_MANIPULATION/COLLUSION/
  // FAKE_DELIVERY now orchestrates a real HOLD via the independent
  // risk-hold module, 用户 2026-09-06 Q-2003 决策; see admin-routes.ts's
  // own doc comment).
  void app.register(async (instance) => {
    registerAntifraudAdminRoutes(instance, pool);
  });

  // Same reasoning as the registrations above: GET /admin/agents/:agentId/
  // risk-hold/audit-log and POST .../risk-hold/release use
  // `app.requireAdmin` (Feature 20, T-2008 — the ONLY way an Agent's
  // `risk_hold_status` ever moves back to NONE, always its own explicit
  // admin action, never implicit).
  void app.register(async (instance) => {
    registerRiskHoldAdminRoutes(instance, pool);
  });

  // Feature 21 (arbitration-committee), T-2106.
  void app.register(async (instance) => {
    registerArbitrationCommitteeAdminRoutes(instance, pool);
  });

  // Feature 22 (ai-customer-service), T-2204: `GET
  // /admin/customer-service/conversations` and its `/messages` sibling use
  // `app.requireAdmin`; `POST /customer-service/conversations` and its
  // `/messages`/`/escalate` siblings read the session cookie via their own
  // best-effort (non-401ing) helper, not `app.requireSession` — same
  // ordering reasoning as every registration above (the relevant decorator
  // must already exist).
  void app.register(async (instance) => {
    await registerCustomerServiceRoutes(instance, pool);
  });

  return app;
}
