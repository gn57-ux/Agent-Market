import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";

/**
 * Feature 22 (ai-customer-service), T-2205 (F-2210/AC-2203). tasks.md's own
 * "风险" section makes this a hard requirement: if any call path in this
 * module lacks an independent timeout/exception boundary, it must be FIXED
 * before this Task can be marked done, not merely documented as a known
 * gap.
 *
 * This is a REAL fault-injection test, not a code walkthrough: it points
 * `OLLAMA_BASE_URL` at a genuinely unreachable address (nothing listens on
 * `127.0.0.1:1`, so every `fetch()` this module makes fails with a real
 * `ECONNREFUSED`, not a mocked rejection) for the whole suite, then fires a
 * real batch of CONCURRENT `app.inject` requests mixing customer-service
 * message-sends (which now genuinely cannot reach Ollama) with real core
 * trading requests (`POST /tasks/drafts` — task creation, the most
 * representative core-path endpoint exercisable via `app.inject` without a
 * live blockchain; `PATCH /tasks/:taskId/draft`/acceptance/funding all
 * require on-chain verification this test setup cannot provide for real,
 * so draft creation is the substitute, exactly as T-2205's own instructions
 * anticipate).
 *
 * Two things must both be true for AC-2203 to actually hold:
 * 1. The core-trading requests complete successfully, and FAST — nowhere
 *    near `intent-classifier.ts`'s/`answer-generator.ts`'s own 30s
 *    `REQUEST_TIMEOUT_MS`. If a customer-service call ever blocked the
 *    event loop, or shared some resource (a DB pool slot, a global lock)
 *    with task creation, task creation would slow down or hang too.
 * 2. The customer-service requests THEMSELVES degrade to a real, honest,
 *    well-formed escalation response — never hang past a bounded time,
 *    never throw an unhandled rejection that would surface as a 500 or a
 *    crashed process. This proves F-2210's OTHER direction: the module's
 *    own failure handling is real, not just "task creation happens not to
 *    touch it."
 *
 * Gated by `RUN_DB_INTEGRATION_TESTS=1`, same convention as every other
 * `*.integration.test.ts` in this codebase (see
 * `customer-service/routes.integration.test.ts`'s identical header).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

// Same literal string every other integration test file in this codebase
// carries its own copy of (see routes.integration.test.ts's identical
// constant and its own comment on why: a shared drop-list, not a shared
// runtime import, so each test file's own migration/table state is fully
// self-contained).
const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

// Nothing listens on port 1 on loopback — a real, immediate TCP
// connection-refused, not a routable-but-silent address that would instead
// exercise the 30s `AbortSignal.timeout` path. Both are genuine
// "unreachable" failures per AC-2203's wording; this one keeps the test
// itself fast without weakening what it proves (every external call this
// module makes is still wrapped in its own try/catch + independent
// timeout regardless of which failure mode actually fires first).
const UNREACHABLE_OLLAMA_BASE_URL = "http://127.0.0.1:1";

const VALID_DRAFT_PAYLOAD = {
  category: "writing",
  skillTags: ["copywriting", "seo"],
  title: "Write a landing page",
  description: "Need 500 words of marketing copy.",
  budget: "125500000000000000000",
  deliveryDeadline: "2099-01-01T00:00:00.000Z",
  expertType: "CONTENT_GENERATION",
};

// Well under `intent-classifier.ts`'s/`answer-generator.ts`'s own 30s
// `REQUEST_TIMEOUT_MS` — a core-trading request stalling anywhere near
// this bound would mean customer-service's own Ollama unreachability is
// somehow propagating into task creation's request handling.
const CORE_TRADING_LATENCY_BOUND_MS = 3_000;

// A message-send request must degrade to the honest escalation answer
// without ever waiting anywhere near the 30s Ollama timeout(s) it may
// internally hit (classification alone can consume its own 30s budget) —
// a real connection-refused failure resolves in milliseconds, so this
// bound only needs to rule out "accidentally serialized/blocked", not
// "genuinely waited out a timeout".
const CUSTOMER_SERVICE_LATENCY_BOUND_MS = 5_000;

runIfOptedIn("customer-service fault isolation (integration, T-2205/AC-2203)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let originalOllamaBaseUrl: string | undefined;
  const requester = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);

    originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = UNREACHABLE_OLLAMA_BASE_URL;

    app = buildApp({ pool });
  });

  afterAll(async () => {
    // Restore, never leak into any other test file run in the same
    // process — matching this codebase's established per-file env-var
    // hygiene (see routes.integration.test.ts's own `delete
    // process.env.OLLAMA_BASE_URL` in its `afterAll`).
    if (originalOllamaBaseUrl === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    }
    await app.close();
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  async function login(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
    const nonceResponse = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address: account.address },
    });
    const { nonce, issuedAt, expiresAt } = nonceResponse.json();
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await account.signMessage({ message });
    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });
    const setCookie = verifyResponse.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = /session_token=([^;]+)/.exec(String(header));
    if (!match?.[1]) throw new Error("no session_token cookie in verify response");
    return match[1];
  }

  async function createAnonymousConversation(sessionId: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/customer-service/conversations",
      payload: { sessionId },
    });
    expect(response.statusCode).toBe(201);
    return (response.json() as { conversation: { id: string } }).conversation.id;
  }

  it(
    "real concurrent core-trading requests are unaffected in correctness AND latency while " +
      "customer-service requests themselves degrade to a bounded, honest escalation (Ollama genuinely unreachable)",
    async () => {
      const token = await login(requester);

      const CONCURRENCY = 10;
      const conversationIds = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          createAnonymousConversation(`fault-isolation-session-${i}`),
        ),
      );

      async function timedCoreTradingRequest(index: number) {
        const startedAt = Date.now();
        const response = await app.inject({
          method: "POST",
          url: "/tasks/drafts",
          cookies: { session_token: token },
          payload: { ...VALID_DRAFT_PAYLOAD, title: `${VALID_DRAFT_PAYLOAD.title} #${index}` },
        });
        return { response, latencyMs: Date.now() - startedAt };
      }

      async function timedCustomerServiceRequest(conversationId: string, index: number) {
        const startedAt = Date.now();
        const response = await app.inject({
          method: "POST",
          url: `/customer-service/conversations/${conversationId}/messages`,
          payload: { message: `Ollama 不可用场景下的真实消息 #${index}` },
        });
        return { response, latencyMs: Date.now() - startedAt };
      }

      const overallStartedAt = Date.now();
      const [coreTradingResults, customerServiceResults] = await Promise.all([
        Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => timedCoreTradingRequest(i))),
        Promise.all(
          conversationIds.map((conversationId, i) =>
            timedCustomerServiceRequest(conversationId, i),
          ),
        ),
      ]);
      const overallElapsedMs = Date.now() - overallStartedAt;

      // 1. Core trading (task creation) is completely unaffected: every
      // request succeeds, and none of them was ever slow.
      for (const { response, latencyMs } of coreTradingResults) {
        expect(response.statusCode).toBe(201);
        const body = response.json() as { status: string; taskId: string };
        expect(body.status).toBe("DRAFT");
        expect(typeof body.taskId).toBe("string");
        expect(latencyMs).toBeLessThan(CORE_TRADING_LATENCY_BOUND_MS);
      }

      // 2. Customer-service's OWN failure handling is real: every message
      // send still returns 200 with a well-formed, honest escalation
      // answer — never a 500, never a hang.
      for (const { response, latencyMs } of customerServiceResults) {
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          intent: string;
          answer: string;
          citedKbArticleIds: string[];
          escalated: boolean;
        };
        expect(body.escalated).toBe(true);
        expect(typeof body.answer).toBe("string");
        expect(body.answer.length).toBeGreaterThan(0);
        expect(body.citedKbArticleIds).toEqual([]);
        expect(latencyMs).toBeLessThan(CUSTOMER_SERVICE_LATENCY_BOUND_MS);
      }

      // 3. The whole concurrent batch (20 real requests) completes well
      // under any single request's own 30s Ollama timeout budget — proof
      // the two families of requests were never serialized behind one
      // another or behind a shared stuck resource.
      expect(overallElapsedMs).toBeLessThan(
        CORE_TRADING_LATENCY_BOUND_MS + CUSTOMER_SERVICE_LATENCY_BOUND_MS,
      );
    },
    // A generous outer test timeout independent of the in-body latency
    // assertions above — those assertions are what actually prove the
    // bound, this just stops the test file itself from hanging if they
    // fail in an unexpected way.
    20_000,
  );
});

/**
 * N4 real finding (round 1, T-2205, P2): the suite above only exercises an
 * immediate connection-refused failure — it would still pass even if a
 * regression silently removed the `AbortSignal.timeout` calls in
 * `intent-classifier.ts`/`answer-generator.ts`, since ECONNREFUSED fires
 * before any timeout logic is ever reached. This is the genuine TIMEOUT
 * path: a real local HTTP server that accepts the TCP connection but never
 * responds (never calls `res.end()`), so the request can only ever resolve
 * via `AbortSignal.timeout` actually firing — proving that boundary is
 * real, not just present in the source. Waiting out the real 30s default
 * would make this test impractically slow, so `OLLAMA_INTENT_TIMEOUT_MS`/
 * `OLLAMA_ANSWER_TIMEOUT_MS` (both added as part of this same fix, same
 * test-seam convention `ollama-provider.ts`'s own `timeoutMs` constructor
 * option already establishes) override the timeout to a real, short value
 * for this suite only.
 */
runIfOptedIn("customer-service fault isolation — real timeout path (integration, T-2205)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let hungServer: Server;
  let hungServerBaseUrl: string;
  let originalOllamaBaseUrl: string | undefined;
  let originalIntentTimeout: string | undefined;
  let originalAnswerTimeout: string | undefined;

  const SHORT_TIMEOUT_MS = 500;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  beforeEach(async () => {
    // Accepts the connection, never writes a response — a real hang, not
    // a simulated one.
    hungServer = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => hungServer.listen(0, "127.0.0.1", resolve));
    const address = hungServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind hung-server stand-in for Ollama");
    }
    hungServerBaseUrl = `http://127.0.0.1:${address.port}`;

    originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
    originalIntentTimeout = process.env.OLLAMA_INTENT_TIMEOUT_MS;
    originalAnswerTimeout = process.env.OLLAMA_ANSWER_TIMEOUT_MS;
    process.env.OLLAMA_BASE_URL = hungServerBaseUrl;
    process.env.OLLAMA_INTENT_TIMEOUT_MS = String(SHORT_TIMEOUT_MS);
    process.env.OLLAMA_ANSWER_TIMEOUT_MS = String(SHORT_TIMEOUT_MS);

    app = buildApp({ pool });
  });

  afterEach(async () => {
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalIntentTimeout === undefined) delete process.env.OLLAMA_INTENT_TIMEOUT_MS;
    else process.env.OLLAMA_INTENT_TIMEOUT_MS = originalIntentTimeout;
    if (originalAnswerTimeout === undefined) delete process.env.OLLAMA_ANSWER_TIMEOUT_MS;
    else process.env.OLLAMA_ANSWER_TIMEOUT_MS = originalAnswerTimeout;

    await app.close();
    await new Promise<void>((resolve) => hungServer.close(() => resolve()));
  });

  it("a message send degrades to the honest escalation answer within the SHORT overridden timeout, not by hanging", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/customer-service/conversations",
      payload: { sessionId: "hung-server-session" },
    });
    const conversationId = (createResponse.json() as { conversation: { id: string } }).conversation
      .id;

    const startedAt = Date.now();
    const response = await app.inject({
      method: "POST",
      url: `/customer-service/conversations/${conversationId}/messages`,
      payload: { message: "会真正超时的一条消息" },
    });
    const latencyMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    const body = response.json() as { escalated: boolean; answer: string };
    expect(body.escalated).toBe(true);
    expect(body.answer.length).toBeGreaterThan(0);
    // Real proof the AbortSignal.timeout actually fired: resolved well
    // above the short override (a genuine wait happened) but nowhere
    // near the real 30s default (it did NOT fall through to the
    // production timeout — the override actually took effect).
    expect(latencyMs).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS);
    expect(latencyMs).toBeLessThan(10_000);
  }, 15_000);
});
