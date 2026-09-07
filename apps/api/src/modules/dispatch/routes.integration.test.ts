import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

// Mocked BEFORE importing app.ts/routes.ts (vi.mock calls are hoisted to
// the top of the file by Vitest) — this suite proves the route's
// orchestration (ownership check, candidate assembly, persistence) end to
// end against a real database, WITHOUT starting a real Go dispatch service
// (T-705 capsule: "不需要真的启动 Go 服务 — 单测/集成测试用一个假的 Go 响应"). The
// real `DispatchServiceUnavailableError` class is preserved via
// importOriginal so routes.ts's `instanceof` check still works against
// whatever this mock throws.
const callMatchMock = vi.fn();
vi.mock("./dispatch.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatch.client.js")>();
  return {
    ...actual,
    callMatch: (...args: Parameters<typeof actual.callMatch>) => callMatchMock(...args),
  };
});

// T-1912: `matchTask` now also calls `runShadowRerank` after persisting
// the run — a REAL local `qwen3:8b` call (`services/dispatch-rerank`)
// measured tens of seconds in T-1911's own testing, which would make
// every ordinary test in this file (previously fast, Go-only tests) incur
// that real latency and risk vitest's own default 5s test timeout. Mocked
// to a no-op here for the same reason `callMatch` is mocked above; the
// REAL end-to-end chain (AC-1909) is proven separately in
// `shadow-rerank.integration.test.ts`, gated behind its own explicit
// opt-in env var, not inside this file's fast happy-path suite.
const runShadowRerankMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./shadow-rerank.js", () => ({
  runShadowRerank: (...args: unknown[]) => runShadowRerankMock(...args),
}));

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-705's end-to-end verification of
// POST /tasks/:taskId/match.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn("POST /tasks/:taskId/match (integration, T-705)", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const requester = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const signerPrivateKey = generatePrivateKey();
  const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";

  // T-803: `matchTask` now auto-issues+persists acceptance permits right
  // after persisting the run, so this suite needs the same permit-signing
  // env vars T-706's suite below already sets up — a successful `/match`
  // call in this suite would otherwise throw inside `issueAcceptancePermit`
  // (missing `ACCEPTANCE_PERMIT_SIGNER_KEY`).
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "ACCEPTANCE_PERMIT_SIGNER_KEY",
    "CHAIN_ID",
    "TASK_ESCROW_ADDRESS",
    "YD_TOKEN_ADDRESS",
    "YD_FAUCET_ADDRESS",
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });

    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = signerPrivateKey;
    process.env.CHAIN_ID = "31337";
    process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
    process.env.YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    process.env.YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  afterEach(async () => {
    callMatchMock.mockReset();
    runShadowRerankMock.mockReset();
    runShadowRerankMock.mockResolvedValue(undefined);
    await pool.query("DELETE FROM acceptance_permits");
    await pool.query("DELETE FROM recommendation_candidates");
    // dispatch_rerank_runs.run_id references recommendation_runs with no
    // ON DELETE CASCADE (T-1912's own migration) — must be cleared first,
    // even though `runShadowRerank` is mocked to a no-op above and never
    // actually inserts one in THIS file's own tests; kept for defense in
    // depth against a future test in this file exercising the real path.
    await pool.query("DELETE FROM dispatch_rerank_runs");
    await pool.query("DELETE FROM shadow_ranking_results");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
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

  async function insertOpenTask(
    requesterAddress: string,
    skillTags: string[] = [],
  ): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requesterAddress,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [requesterAddress, TOKEN_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertOpenTask: no id returned");
    for (const skillTag of skillTags) {
      await pool.query(`INSERT INTO task_skills (task_id, skill_tag) VALUES ($1, $2)`, [
        id,
        skillTag,
      ]);
    }
    return id;
  }

  async function insertActiveAgent(
    skillTags: string[] = [],
    overrides: { baselineEvaluationStatus?: string } = {},
  ): Promise<string> {
    const ownerAddress = "0x9983fefc63f0cd0e873a0000c6d07ef7b77e90d8";
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      ownerAddress,
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [ownerAddress],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertActiveAgent: no id returned");
    for (const skillTag of skillTags) {
      await pool.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, $2)`, [
        id,
        skillTag,
      ]);
    }
    // Feature 20/T-1913: defaults to the migration's own column default
    // (NOT_STARTED) when omitted — every existing test in this file never
    // sets `enforceBaselineEvaluationGate`, so this override only matters
    // for the dedicated gate-integration tests below.
    if (overrides.baselineEvaluationStatus) {
      await pool.query(`UPDATE agents SET baseline_evaluation_status = $1 WHERE id = $2`, [
        overrides.baselineEvaluationStatus,
        id,
      ]);
    }
    return id;
  }

  // T-1309 (Ollama migration): both embeddings tables were rebuilt to
  // vector(1024) — see 0017_ollama_embedding_dimension.sql. These fixtures
  // only exercise this file's own dispatch-routing logic (which never
  // interprets a vector's actual dimension itself, just passes it through
  // to a real cosine-distance query), so a synthetic 1024-dim vector is
  // exactly as valid a fixture here as the old 1536-dim one was.
  function fakeVector(seed: number): number[] {
    return Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) * 0.01);
  }

  function toVectorLiteral(vector: number[]): string {
    return `[${vector.join(",")}]`;
  }

  /** Feature 13/T-1303: inserts a real `task_embeddings` row — the one
   * signal `getTaskSimilarityByAgentId` reads to decide "v0.2" is even
   * possible for this task. */
  async function insertTaskEmbedding(taskId: string, seed: number): Promise<void> {
    await pool.query(
      `INSERT INTO task_embeddings (task_id, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v1')`,
      [taskId, toVectorLiteral(fakeVector(seed))],
    );
  }

  /** Same seed as the paired `insertTaskEmbedding` call produces a
   * near-identical vector (cosine similarity close to 1) — a different
   * seed produces a genuinely dissimilar one. */
  async function insertAgentEmbedding(agentId: string, seed: number): Promise<void> {
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v1')`,
      [agentId, toVectorLiteral(fakeVector(seed))],
    );
  }

  it("401s an unauthenticated request", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const response = await app.inject({ method: "POST", url: `/tasks/${taskId}/match` });
    expect(response.statusCode).toBe(401);
    expect(callMatchMock).not.toHaveBeenCalled();
  });

  it("404s a nonexistent task", async () => {
    const token = await login(requester);
    const response = await app.inject({
      method: "POST",
      url: `/tasks/00000000-0000-0000-0000-000000000000/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s (not 403) when the caller isn't the task's requester", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const token = await login(stranger);
    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(404);
    expect(callMatchMock).not.toHaveBeenCalled();
  });

  it("assembles candidates, calls the dispatch service, persists the run + candidates, and returns the fixed response shape", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配", "评分最高"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ taskId, algorithmVersion: "v0.1", recommendationCount: 1 });

    expect(callMatchMock).toHaveBeenCalledTimes(1);
    const [sentRequest] = callMatchMock.mock.calls[0] as [{ candidates: unknown[] }];
    expect(sentRequest.candidates).toHaveLength(1);

    const { rows: runRows } = await pool.query<{ candidate_count: number; task_id: string }>(
      `SELECT candidate_count, task_id FROM recommendation_runs WHERE task_id = $1`,
      [taskId],
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.candidate_count).toBe(1);

    const { rows: candidateRows } = await pool.query<{ agent_id: string; rank: number }>(
      `SELECT agent_id, rank FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
      [taskId],
    );
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]?.agent_id).toBe(agentId);
    expect(candidateRows[0]?.rank).toBe(1);

    // F-1901 (T-1901): a real EXPOSURE event is written to the outbox for
    // the one recommended candidate, atomically with the run itself.
    const outboxEvents = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE aggregate_type = 'task' AND aggregate_id = $1`,
      [taskId],
    );
    expect(outboxEvents.rows).toHaveLength(1);
    expect(outboxEvents.rows[0]?.event_type).toBe("EXPOSURE");
  });

  // --- Feature 13/T-1303: algorithmVersion decision + v0.2 enrichment ---

  it("uses algorithmVersion v0.2, attaches semanticSimilarity + reputationSignals, and persists v0.2 when the task has a real embedding", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    await insertTaskEmbedding(taskId, 1);
    await insertAgentEmbedding(agentId, 1); // same seed -> similarity close to 1
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.2",
      recommendations: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.5, reasons: [] }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ algorithmVersion: "v0.2" });

    expect(callMatchMock).toHaveBeenCalledTimes(1);
    const [sentRequest] = callMatchMock.mock.calls[0] as [
      {
        algorithmVersion: string;
        candidates: Array<{
          agentId: string;
          semanticSimilarity?: number;
          reputationSignals?: Record<string, number | null>;
        }>;
      },
    ];
    expect(sentRequest.algorithmVersion).toBe("v0.2");
    expect(sentRequest.candidates).toHaveLength(1);
    const candidate = sentRequest.candidates[0];
    expect(typeof candidate?.semanticSimilarity).toBe("number");
    // Same seed on both sides -> vectors are near-identical -> cosine
    // similarity close to 1 (not exactly 1, since float4 storage rounds).
    expect(candidate?.semanticSimilarity).toBeGreaterThan(0.99);
    // No settlement history for this brand-new agent -> every signal null,
    // but the object itself must still be present (not omitted).
    expect(candidate?.reputationSignals).toEqual({
      completionRate: null,
      qualityFeedback: null,
      communication: null,
      disputeSignal: null,
      historicalScale: null,
    });

    const { rows: runRows } = await pool.query<{ algorithm_version: string }>(
      `SELECT algorithm_version FROM recommendation_runs WHERE task_id = $1`,
      [taskId],
    );
    expect(runRows[0]?.algorithm_version).toBe("v0.2");

    // F-1313 (Feature 13, T-1307): the persisted row must carry the RICHER
    // digest (value + sampleSize per signal), not the flat wire shape sent
    // to Go above — this is what AC-1307's later-replay requirement
    // actually needs.
    const { rows: candidateRows } = await pool.query<{
      semantic_similarity: string;
      reputation_signals: Record<string, { value: number | null; sampleSize: number }>;
    }>(
      `SELECT rc.semantic_similarity, rc.reputation_signals
       FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
      [taskId],
    );
    expect(candidateRows).toHaveLength(1);
    expect(Number(candidateRows[0]?.semantic_similarity)).toBeGreaterThan(0.99);
    // AC-1307 (N6 QA): the persisted semanticSimilarity must be the EXACT
    // same number that was actually sent to Go for this run's real score —
    // not just independently "close to 1" — otherwise a later replay would
    // recompute against a different similarity than the one that actually
    // produced the persisted score. `pg`'s NUMERIC/float8 round-trip
    // through `Number(...)` matches the JS number `candidate.
    // semanticSimilarity` was built from bit-for-bit (both originate from
    // the same real `1 - (a <=> b)` pgvector computation).
    expect(Number(candidateRows[0]?.semantic_similarity)).toBe(candidate?.semanticSimilarity);
    // Same cross-check for reputationSignals: every persisted digest
    // entry's `value` must equal the corresponding flat value Go actually
    // scored against (candidate.reputationSignals, asserted above to be
    // all-null for this brand-new agent) — proving the persisted digest,
    // once projected through toReputationSignalsWire, reproduces exactly
    // what ScoreV2 saw, which combined with ScoreV2's already-proven
    // determinism (T-1305's TestScoreV2_RepeatedCallsAreIdentical) is what
    // makes AC-1307's "sufficient to replay the same final score" true.
    for (const signal of [
      "completionRate",
      "qualityFeedback",
      "communication",
      "disputeSignal",
      "historicalScale",
    ] as const) {
      expect(candidateRows[0]?.reputation_signals[signal]?.value).toBe(
        candidate?.reputationSignals?.[signal],
      );
    }
    expect(candidateRows[0]?.reputation_signals).toEqual({
      completionRate: { value: null, sampleSize: 0 },
      qualityFeedback: { value: null, sampleSize: 0 },
      communication: { value: null, sampleSize: 0 },
      disputeSignal: { value: null, sampleSize: 0 },
      historicalScale: { value: null, sampleSize: 0 },
    });
  });

  it("persists NULL semantic_similarity/reputation_signals for a v0.1 recommendation_candidates row", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    // No insertTaskEmbedding call — this run stays v0.1.
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.5, reasons: [] }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(200);

    const { rows: candidateRows } = await pool.query<{
      semantic_similarity: string | null;
      reputation_signals: unknown;
    }>(
      `SELECT rc.semantic_similarity, rc.reputation_signals
       FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
      [taskId],
    );
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]?.semantic_similarity).toBeNull();
    expect(candidateRows[0]?.reputation_signals).toBeNull();
  });

  it("falls back to algorithmVersion v0.1 (candidates unmodified) when the task has no embedding", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    await insertActiveAgent();
    // No insertTaskEmbedding call — this task has never been embedded.
    const token = await login(requester);

    callMatchMock.mockResolvedValue({ taskId, algorithmVersion: "v0.1", recommendations: [] });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ algorithmVersion: "v0.1" });

    const [sentRequest] = callMatchMock.mock.calls[0] as [
      { algorithmVersion: string; candidates: Array<Record<string, unknown>> },
    ];
    expect(sentRequest.algorithmVersion).toBe("v0.1");
    expect(sentRequest.candidates[0]?.semanticSimilarity).toBeUndefined();
    expect(sentRequest.candidates[0]?.reputationSignals).toBeUndefined();
  });

  it("reports the existing run's real algorithmVersion on an idempotent replay (unexpired outstanding permits)", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    await insertTaskEmbedding(taskId, 2);
    await insertAgentEmbedding(agentId, 2);
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.2",
      recommendations: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.5, reasons: [] }],
    });

    const first = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ algorithmVersion: "v0.2" });

    // Second call: hasUnexpiredOutstandingPermits' pre-check short-circuits
    // before ever calling callMatch again — proves this path reads the
    // EXISTING run's real algorithm_version back from the database rather
    // than defaulting to "v0.1" or recomputing a fresh (possibly
    // different) decision.
    const second = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ algorithmVersion: "v0.2" });
    expect(callMatchMock).toHaveBeenCalledTimes(1);
  });

  it("assembles the task's real skillTags and the ACTIVE agent's real skillTags into the match request (P1 regression: real Python-tagged task + real Python-skilled agent)", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase(), ["python"]);
    const agentId = await insertActiveAgent(["python"]);
    const token = await login(requester);

    callMatchMock.mockResolvedValue({ taskId, algorithmVersion: "v0.1", recommendations: [] });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(200);

    expect(callMatchMock).toHaveBeenCalledTimes(1);
    const [sentRequest] = callMatchMock.mock.calls[0] as [
      {
        category: string;
        skillTags: string[];
        candidates: { agentId: string; skillTags: string[] }[];
      },
    ];
    // The task's own real skillTags (from a real task_skills row, not empty).
    expect(sentRequest.skillTags).toEqual(["python"]);
    // The real ACTIVE agent is assembled as a candidate at all (category
    // matched — assembleCandidateSnapshots' own filter), carrying its real
    // agent_skills, not an empty array. Actual accept/reject on skill match
    // is the Go dispatch service's job (out of this apps/api layer's
    // scope — its own doc comment: "只负责收集数据、发一次 HTTP 调用"), but this
    // proves apps/api hands it the real data needed to decide, which is
    // exactly the P1 report: the task's tags were never reaching this
    // point in a usable form.
    expect(sentRequest.candidates).toHaveLength(1);
    expect(sentRequest.candidates[0]?.agentId).toBe(agentId);
    expect(sentRequest.candidates[0]?.skillTags).toEqual(["python"]);
  });

  // T-803 (Feature 8, confirmed scope decision #1): a successful `/match`
  // run must auto-issue+persist one `acceptance_permits` row per recommended
  // candidate — without any separate call to
  // `POST /tasks/:taskId/acceptance-permits`.
  it("auto-issues and persists one acceptance_permits row per recommended candidate, without a separate /acceptance-permits call", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(200);

    const { rows } = await pool.query<{
      agent_id: string;
      task_id: string;
      status: string;
      accepting_address: string;
      signature: string;
    }>(
      `SELECT agent_id, task_id, status, accepting_address, signature FROM acceptance_permits WHERE task_id = $1`,
      [taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toBe(agentId);
    expect(rows[0]?.status).toBe("OUTSTANDING");
    expect(rows[0]?.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  // T-806 (human N6 BLOCK fix): direct reversal of T-803 round 2's
  // "dedupe by wallet, skip lower-ranked candidates" design, which the
  // human reviewer rejected — every recommended candidate now gets its own
  // independent permit, even when two candidates share a wallet.
  // Attribution is resolved later by decoding the exact nonce the on-chain
  // transaction's calldata used (acceptance-tx-verifier.ts), not by
  // limiting issuance up front.
  it("issues one independent acceptance_permits row per candidate — including BOTH, when two recommended candidates share a wallet", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    // Both share `insertActiveAgent()`'s single hardcoded owner address.
    const higherRankedAgentId = await insertActiveAgent();
    const lowerRankedAgentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        {
          agentId: higherRankedAgentId,
          rank: 1,
          slotType: "TOP_SCORE",
          score: 0.92,
          reasons: ["x"],
        },
        {
          agentId: lowerRankedAgentId,
          rank: 2,
          slotType: "EXPLORATION",
          score: 0.5,
          reasons: ["y"],
        },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(200);

    const { rows } = await pool.query<{ agent_id: string; nonce: string }>(
      `SELECT agent_id, nonce FROM acceptance_permits WHERE task_id = $1 ORDER BY agent_id`,
      [taskId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.agent_id).sort()).toEqual(
      [higherRankedAgentId, lowerRankedAgentId].sort(),
    );
    // Every row gets its OWN independently-generated nonce — no sharing.
    expect(new Set(rows.map((r) => r.nonce)).size).toBe(2);
  });

  // T-806, user's item #1: fault injection at the route/HTTP level — a
  // failure during signing (before any DB write) must leave zero rows in
  // run/candidates/permits, proving matchTask's "sign everything first,
  // write everything atomically" ordering end to end.
  it("persists nothing (run, candidates, or permits) when signing fails partway through — the whole /match call fails", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["x"] }],
    });

    const savedKey = process.env.ACCEPTANCE_PERMIT_SIGNER_KEY;
    delete process.env.ACCEPTANCE_PERMIT_SIGNER_KEY; // issueAcceptancePermit throws
    try {
      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: token },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = savedKey;
    }

    const runRows = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    const permitRows = await pool.query(`SELECT id FROM acceptance_permits WHERE task_id = $1`, [
      taskId,
    ]);
    expect(runRows.rows).toHaveLength(0);
    expect(permitRows.rows).toHaveLength(0);
  });

  // T-806, user's item #1's last sentence: two concurrent /match calls for
  // the SAME task each complete their own write as an uninterrupted unit —
  // no interleaving. Feature 7 sync (T-709) changes the OUTCOME for a
  // permit-free task: a new round can only be created once the current
  // one's permits have expired, so of two genuinely concurrent first-ever
  // /match calls, exactly one creates the task's one allowed round and the
  // other loses the race inside insertRecommendationRunWithPermits — caught
  // as PermitsStillOutstandingError and turned into the SAME idempotent 200
  // response describing the winner's round (matchTask's own fallback), not
  // an error and not a second independent run.
  it("real concurrency: of two genuinely simultaneous /match calls for the same (permit-free) task, both respond 200 but only one round is ever persisted", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentA = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
      ],
    });

    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: token },
      }),
      app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: token },
      }),
    ]);
    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
    // Both requests describe the same (winning) round.
    expect(responseA.json()).toEqual(responseB.json());

    const { rows: runRows } = await pool.query<{ id: string }>(
      `SELECT id FROM recommendation_runs WHERE task_id = $1`,
      [taskId],
    );
    expect(runRows).toHaveLength(1);

    const { rows: candidateRows } = await pool.query<{ run_id: string }>(
      `SELECT rc.run_id FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
      [taskId],
    );
    expect(candidateRows).toHaveLength(1);

    const { rows: permitRows } = await pool.query<{ id: string; nonce: string }>(
      `SELECT id, nonce FROM acceptance_permits WHERE task_id = $1`,
      [taskId],
    );
    expect(permitRows).toHaveLength(1);
  });

  it("returns 502 when the dispatch service is unavailable, without persisting a run", async () => {
    const { DispatchServiceUnavailableError } = await import("./dispatch.client.js");
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const token = await login(requester);

    callMatchMock.mockRejectedValue(new DispatchServiceUnavailableError("boom"));

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // Regression for Codex round 2 P2: a schema-valid response that isn't
  // actually FOR this task/algorithmVersion, or that recommends an agentId
  // never among this run's candidates, must be rejected rather than
  // persisted — a database FK alone can't catch this (the agentId being a
  // real agent somewhere doesn't mean it was a candidate for THIS run).
  it("returns 502 and persists nothing when the response's taskId doesn't match the request", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const otherTaskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId: otherTaskId, // wrong task
      algorithmVersion: "v0.1",
      recommendations: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("returns 502 and persists nothing when a recommendation names an agent that wasn't a candidate for this run", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    // A real agent that exists in the database but was never fetched as a
    // candidate for THIS run (no agent was inserted before this call, so
    // assembleCandidateSnapshots sees zero candidates) — the response
    // claims a recommendation for it anyway.
    const foreignAgentId = "00000000-0000-0000-0000-000000000000";
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId: foreignAgentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // Regression for Codex round 1 P2: a schema-valid response can still
  // repeat the same agentId or rank across slots, which would let one agent
  // be issued more than one acceptance permit for the same task — must be
  // rejected before persistence, not just checked against candidate
  // membership.
  it("returns 502 and persists nothing when the response repeats the same agentId across recommendations", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const agentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        { agentId, rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("returns 502 and persists nothing when the response repeats the same rank across recommendations", async () => {
    const taskId = await insertOpenTask(requester.address.toLowerCase());
    const firstAgentId = await insertActiveAgent();
    const secondAgentId = await insertActiveAgent();
    const token = await login(requester);

    callMatchMock.mockResolvedValue({
      taskId,
      algorithmVersion: "v0.1",
      recommendations: [
        { agentId: firstAgentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        { agentId: secondAgentId, rank: 1, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/match`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(502);
    const { rows } = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // --- Feature 20/T-1913 (AC-1911): Feature 20 admission-gate integration ---

  describe("Feature 20 admission-gate integration (T-1913, AC-1911)", () => {
    const savedGateEnv: { value: string | undefined } = { value: undefined };

    beforeAll(() => {
      savedGateEnv.value = process.env.BASELINE_EVALUATION_GATE_ENABLED;
      process.env.BASELINE_EVALUATION_GATE_ENABLED = "1";
    });

    afterAll(() => {
      if (savedGateEnv.value === undefined) {
        delete process.env.BASELINE_EVALUATION_GATE_ENABLED;
      } else {
        process.env.BASELINE_EVALUATION_GATE_ENABLED = savedGateEnv.value;
      }
    });

    it(
      "sends enforceBaselineEvaluationGate=true to Go once the operator flag is on, and never forwards a " +
        "gate-excluded candidate to the real Python shadow-rerank call — proven by composing two already-" +
        "independently-verified real boundaries: Go's own eligibility.Filter really excludes a NOT_STARTED " +
        "candidate when this flag is true (services/dispatch's TestFilter_BaselineEvaluationStatus_GateOn_* " +
        "and TestHandleMatch_BaselineEvaluationGate_EndToEnd, real HTTP, no mocking), and this test proves " +
        "Node's own wiring never re-includes a candidate Go excluded when it later calls runShadowRerank — " +
        "so the mocked Go response below deliberately mirrors real Go's actual documented behavior for this " +
        "exact input, not an arbitrary fixture",
      async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const passedAgentId = await insertActiveAgent([], { baselineEvaluationStatus: "PASSED" });
        const notStartedAgentId = await insertActiveAgent([], {
          baselineEvaluationStatus: "NOT_STARTED",
        });
        const token = await login(requester);

        // Real Go, given enforceBaselineEvaluationGate=true, excludes the
        // NOT_STARTED candidate entirely from its response (proven at the
        // Go level, cited above) — this mock returns exactly that already-
        // filtered shape, never re-deriving it from the full candidate list
        // itself.
        callMatchMock.mockResolvedValue({
          taskId,
          algorithmVersion: "v0.1",
          recommendations: [
            {
              agentId: passedAgentId,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.9,
              reasons: ["技能匹配", "评分最高"],
            },
          ],
        });

        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/match`,
          cookies: { session_token: token },
        });

        expect(response.statusCode).toBe(200);

        // Node sent BOTH candidates to Go, along with the real flag value
        // — Go is the one deciding admission, not Node pre-filtering (F-2012's
        // own design: the hard filter lives in eligibility.Filter alone).
        expect(callMatchMock).toHaveBeenCalledTimes(1);
        const [sentRequest] = callMatchMock.mock.calls[0] as [
          {
            candidates: Array<{ agentId: string; baselineEvaluationStatus: string }>;
            enforceBaselineEvaluationGate: boolean;
          },
        ];
        expect(sentRequest.enforceBaselineEvaluationGate).toBe(true);
        const sentAgentIds = sentRequest.candidates.map((c) => c.agentId).sort();
        expect(sentAgentIds).toEqual([notStartedAgentId, passedAgentId].sort());
        // N4 P2 fix (round 1): asserting the two agentIds alone doesn't
        // prove which STATUS each one carries — a swapped or dropped
        // `baselineEvaluationStatus` field would still pass the assertion
        // above while making real Go's admission filter act on the wrong
        // Agent entirely.
        const statusByAgentId = new Map(
          sentRequest.candidates.map((c) => [c.agentId, c.baselineEvaluationStatus]),
        );
        expect(statusByAgentId.get(passedAgentId)).toBe("PASSED");
        expect(statusByAgentId.get(notStartedAgentId)).toBe("NOT_STARTED");

        // AC-1911's literal requirement: the excluded candidate never
        // reaches the call that would forward it to Python.
        expect(runShadowRerankMock).toHaveBeenCalledTimes(1);
        const [, shadowInput] = runShadowRerankMock.mock.calls[0] as [
          unknown,
          { recommendations: Array<{ agentId: string }> },
        ];
        const shadowAgentIds = shadowInput.recommendations.map((r) => r.agentId);
        expect(shadowAgentIds).toEqual([passedAgentId]);
        expect(shadowAgentIds).not.toContain(notStartedAgentId);

        // And the persisted candidate set matches what Go actually
        // returned — the excluded Agent was never a candidate for this run
        // at all, not merely "recommended but hidden."
        const { rows: candidateRows } = await pool.query<{ agent_id: string }>(
          `SELECT agent_id FROM recommendation_candidates rc
           JOIN recommendation_runs rr ON rr.id = rc.run_id
           WHERE rr.task_id = $1`,
          [taskId],
        );
        expect(candidateRows.map((r) => r.agent_id)).toEqual([passedAgentId]);
      },
    );

    // N4 P2 fix (round 1): the test above only ever exercised
    // BASELINE_EVALUATION_GATE_ENABLED="1" — nothing in this file proved
    // the gate actually stays OFF (the documented, safe default) when the
    // env var is unset or set to anything else. A regression that made
    // `resolveEnforceBaselineEvaluationGate` always return `true` would
    // have passed every existing test in this suite while silently
    // excluding every pre-existing NOT_STARTED Agent from real matching.
    it("sends enforceBaselineEvaluationGate=false to Go when the operator flag is unset (the safe default)", async () => {
      delete process.env.BASELINE_EVALUATION_GATE_ENABLED;

      const taskId = await insertOpenTask(requester.address.toLowerCase());
      const notStartedAgentId = await insertActiveAgent([], {
        baselineEvaluationStatus: "NOT_STARTED",
      });
      const token = await login(requester);

      callMatchMock.mockResolvedValue({
        taskId,
        algorithmVersion: "v0.1",
        recommendations: [
          {
            agentId: notStartedAgentId,
            rank: 1,
            slotType: "TOP_SCORE",
            score: 0.9,
            reasons: ["技能匹配"],
          },
        ],
      });

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: token },
      });

      expect(response.statusCode).toBe(200);
      const [sentRequest] = callMatchMock.mock.calls[0] as [
        { enforceBaselineEvaluationGate: boolean },
      ];
      expect(sentRequest.enforceBaselineEvaluationGate).toBe(false);
    });

    it('sends enforceBaselineEvaluationGate=false to Go when the operator flag is set to anything other than "1"', async () => {
      process.env.BASELINE_EVALUATION_GATE_ENABLED = "true";

      const taskId = await insertOpenTask(requester.address.toLowerCase());
      const notStartedAgentId = await insertActiveAgent([], {
        baselineEvaluationStatus: "NOT_STARTED",
      });
      const token = await login(requester);

      callMatchMock.mockResolvedValue({
        taskId,
        algorithmVersion: "v0.1",
        recommendations: [
          {
            agentId: notStartedAgentId,
            rank: 1,
            slotType: "TOP_SCORE",
            score: 0.9,
            reasons: ["技能匹配"],
          },
        ],
      });

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: token },
      });

      expect(response.statusCode).toBe(200);
      const [sentRequest] = callMatchMock.mock.calls[0] as [
        { enforceBaselineEvaluationGate: boolean },
      ];
      expect(sentRequest.enforceBaselineEvaluationGate).toBe(false);
    });
  });
});

// T-706: GET /tasks/:taskId/recommendations and
// POST /tasks/:taskId/acceptance-permits — a separate top-level describe
// (its own pool/app/env setup) rather than folding into the T-705 suite
// above: these two routes never call the Go dispatch service (no
// `callMatchMock` involved), and acceptance-permits needs
// ACCEPTANCE_PERMIT_SIGNER_KEY/CHAIN_ID/TASK_ESCROW_ADDRESS env vars the
// T-705 suite has no reason to set.
runIfOptedIn(
  "GET /tasks/:taskId/recommendations, POST /tasks/:taskId/acceptance-permits (integration, T-706)",
  () => {
    let pool: Pool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    const requester = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const signerPrivateKey = generatePrivateKey();
    const signerAccount = privateKeyToAccount(signerPrivateKey);
    const TASK_ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";

    const savedEnv: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      "ACCEPTANCE_PERMIT_SIGNER_KEY",
      "CHAIN_ID",
      "TASK_ESCROW_ADDRESS",
      "YD_TOKEN_ADDRESS",
      "YD_FAUCET_ADDRESS",
    ];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });

      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
      }
      process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = signerPrivateKey;
      process.env.CHAIN_ID = "31337";
      process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
      process.env.YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
      process.env.YD_FAUCET_ADDRESS = "0x9876543210987654321098765432109876543210";
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    afterEach(async () => {
      await pool.query("DELETE FROM recommendation_candidates");
      await pool.query("DELETE FROM recommendation_runs");
      await pool.query("DELETE FROM acceptance_permits");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM agent_skills");
      await pool.query("DELETE FROM agents");
      await pool.query("DELETE FROM sessions");
      await pool.query("DELETE FROM auth_nonces");
      await pool.query("DELETE FROM users");
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

    async function insertOpenTask(requesterAddress: string): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        requesterAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks
           (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
         VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
         RETURNING id`,
        [requesterAddress, TOKEN_ADDRESS],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertOpenTask: no id returned");
      return id;
    }

    async function insertActiveAgent(ownerAddress: string): Promise<string> {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        ownerAddress,
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
        [ownerAddress],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("insertActiveAgent: no id returned");
      return id;
    }

    /** Bypasses insertRecommendationRun/POST /match entirely (no Go service
     * involved in this suite) — direct SQL insert of exactly the run +
     * candidate rows GET /recommendations and POST /acceptance-permits both
     * read back via getLatestRecommendationCandidates. */
    async function insertRecommendationRunDirect(
      taskId: string,
      candidates: Array<{
        agentId: string;
        rank: number;
        slotType: string;
        score: number;
        reasons: string[];
      }>,
      requestedAt?: Date,
    ): Promise<void> {
      const { rows } = await pool.query<{ id: string }>(
        requestedAt
          ? `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest, requested_at)
             VALUES ($1, 'v0.1', $2, 'test-digest', $3) RETURNING id`
          : `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
             VALUES ($1, 'v0.1', $2, 'test-digest') RETURNING id`,
        requestedAt ? [taskId, candidates.length, requestedAt] : [taskId, candidates.length],
      );
      const runId = rows[0]?.id;
      if (!runId) throw new Error("insertRecommendationRunDirect: no id returned");
      for (const candidate of candidates) {
        await pool.query(
          `INSERT INTO recommendation_candidates (run_id, agent_id, rank, slot_type, score, reasons)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            runId,
            candidate.agentId,
            candidate.rank,
            candidate.slotType,
            candidate.score,
            JSON.stringify(candidate.reasons),
          ],
        );
      }
    }

    describe("GET /tasks/:taskId/recommendations", () => {
      it("404s a nonexistent task", async () => {
        const response = await app.inject({
          method: "GET",
          url: `/tasks/00000000-0000-0000-0000-000000000000/recommendations`,
        });
        expect(response.statusCode).toBe(404);
      });

      it("returns an empty array (200, not 404) when no run exists yet", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ recommendations: [] });
      });

      it("is public — no session cookie required", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentId = await insertActiveAgent("0x1183fefc63f0cd0e873a0000c6d07ef7b77e90e1");
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配"] },
        ]);

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          recommendations: [
            { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.92, reasons: ["技能匹配"] },
          ],
        });
      });

      it("returns candidates ordered by rank ascending, from only the latest run", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentA = await insertActiveAgent("0x2283fefc63f0cd0e873a0000c6d07ef7b77e90e2");
        const agentB = await insertActiveAgent("0x3383fefc63f0cd0e873a0000c6d07ef7b77e90e3");
        const agentC = await insertActiveAgent("0x4483fefc63f0cd0e873a0000c6d07ef7b77e90e4");

        // Older run — must NOT appear in the response.
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.5, reasons: ["旧一轮"] },
        ]);
        // Latest run, inserted with ranks out of order to prove the ORDER BY.
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.6, reasons: ["探索位"] },
          { agentId: agentC, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["最新一轮"] },
        ]);

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          recommendations: Array<{ agentId: string; rank: number }>;
        };
        expect(body.recommendations.map((r) => r.agentId)).toEqual([agentC, agentB]);
        expect(body.recommendations.map((r) => r.rank)).toEqual([1, 2]);
      });

      // Regression for Codex round 1 P2: `requested_at` (TIMESTAMPTZ) is not
      // a uniqueness guarantee — two runs landing at the identical instant
      // must still resolve to a single deterministic "latest" via
      // `sequence_no`, not whichever row Postgres happens to return first.
      it("resolves ties deterministically via sequence_no when two runs share the same requested_at", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentOlder = await insertActiveAgent("0x7783fefc63f0cd0e873a0000c6d07ef7b77e90e7");
        const agentNewer = await insertActiveAgent("0x8883fefc63f0cd0e873a0000c6d07ef7b77e90e8");
        const tiedTimestamp = new Date("2026-01-01T00:00:00Z");

        await insertRecommendationRunDirect(
          taskId,
          [
            {
              agentId: agentOlder,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.5,
              reasons: ["先插入"],
            },
          ],
          tiedTimestamp,
        );
        await insertRecommendationRunDirect(
          taskId,
          [
            {
              agentId: agentNewer,
              rank: 1,
              slotType: "TOP_SCORE",
              score: 0.9,
              reasons: ["后插入"],
            },
          ],
          tiedTimestamp,
        );

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/recommendations`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as { recommendations: Array<{ agentId: string }> };
        // sequence_no is a BIGSERIAL, so the run inserted second (higher
        // sequence_no) is unambiguously "latest" despite the identical
        // requested_at.
        expect(body.recommendations.map((r) => r.agentId)).toEqual([agentNewer]);
      });
    });

    describe("POST /tasks/:taskId/acceptance-permits", () => {
      it("401s an unauthenticated request", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
        });
        expect(response.statusCode).toBe(401);
      });

      it("404s (not 403) when the caller isn't the task's requester", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const token = await login(stranger);
        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });
        expect(response.statusCode).toBe(404);
      });

      it("400s when no recommendation run exists yet", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const token = await login(requester);
        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });
        expect(response.statusCode).toBe(400);
      });

      // Regression for Codex round 1 P2: a task that has left OPEN (e.g.
      // already ACCEPTED, or cancelled) must reject manual re-issuance —
      // otherwise this endpoint would happily mint new OUTSTANDING permits
      // for a task no candidate can actually use `acceptTask` on anymore.
      it("409s when the task is no longer OPEN, even though a recommendation run exists", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentId = await insertActiveAgent("0x1283fefc63f0cd0e873a0000c6d07ef7b77e90f9");
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        await pool.query(`UPDATE tasks SET status = 'ACCEPTED' WHERE id = $1`, [taskId]);
        const token = await login(requester);

        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });

        expect(response.statusCode).toBe(409);
        const { rows } = await pool.query(`SELECT id FROM acceptance_permits WHERE task_id = $1`, [
          taskId,
        ]);
        expect(rows).toHaveLength(0);
      });

      it("issues one permit per candidate from the latest run, each matching the candidate's owner_address and the task's derived bytes32 id", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const ownerA = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90e5";
        const ownerB = "0x6683fefc63f0cd0e873a0000c6d07ef7b77e90e6";
        const agentA = await insertActiveAgent(ownerA);
        const agentB = await insertActiveAgent(ownerB);
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.6, reasons: ["y"] },
        ]);
        const token = await login(requester);

        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          permits: Array<{
            agentId: string;
            taskId: string;
            agentWalletAddress: string;
            nonce: string;
            expiry: number;
            chainId: number;
            verifyingContract: string;
            signature: string;
          }>;
        };
        expect(body.permits).toHaveLength(2);

        const { deriveOnChainTaskId } = await import("../tasks/onchain-task-id.js");
        const expectedTaskIdOnChain = deriveOnChainTaskId(taskId);

        const byAgent = new Map(body.permits.map((p) => [p.agentId, p]));
        expect(byAgent.get(agentA)?.agentWalletAddress.toLowerCase()).toBe(ownerA);
        expect(byAgent.get(agentB)?.agentWalletAddress.toLowerCase()).toBe(ownerB);

        for (const permit of body.permits) {
          expect(permit.taskId).toBe(taskId);
          expect(permit.chainId).toBe(31337);
          expect(permit.verifyingContract.toLowerCase()).toBe(TASK_ESCROW_ADDRESS.toLowerCase());
          expect(permit.signature).toMatch(/^0x[0-9a-fA-F]+$/);
          expect(typeof permit.nonce).toBe("string");
          expect(BigInt(permit.nonce)).toBeGreaterThan(0n);
        }

        // Every permit's signature verifies back to the configured
        // ACCEPTANCE_PERMIT_SIGNER_KEY's address — proves the route wired
        // permit.service.ts's actual signature into the response, not a
        // placeholder.
        const { verifyTypedData } = await import("viem");
        const { ACCEPTANCE_PERMIT_TYPES } = await import("./permit.service.js");
        for (const permit of body.permits) {
          const valid = await verifyTypedData({
            address: signerAccount.address,
            domain: {
              name: "AgentMarketTaskEscrow",
              version: "1",
              chainId: permit.chainId,
              verifyingContract: permit.verifyingContract as `0x${string}`,
            },
            types: ACCEPTANCE_PERMIT_TYPES,
            primaryType: "AcceptancePermit",
            message: {
              taskId: expectedTaskIdOnChain,
              agent: permit.agentWalletAddress as `0x${string}`,
              nonce: BigInt(permit.nonce),
              expiry: BigInt(permit.expiry),
              chainId: BigInt(permit.chainId),
              verifyingContract: permit.verifyingContract as `0x${string}`,
            },
            signature: permit.signature as `0x${string}`,
          });
          expect(valid).toBe(true);
        }
      });

      // Human review finding (T-806, post-cap), required regression #2:
      // real Promise.all concurrency over the full HTTP route — two
      // genuinely simultaneous POST calls for a run with no existing
      // permits must not both sign+persist independently; the loser must
      // observe the winner's freshly-committed permits and return those
      // unchanged (insertPermitsForRunIfAbsent's idempotency, exercised
      // here through the real route, not called directly).
      it("real concurrency: two genuinely simultaneous POST /tasks/:taskId/acceptance-permits calls return identical nonce/signature, and the database holds only one permit per candidate", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentId = await insertActiveAgent("0x1283fefc63f0cd0e873a0000c6d07ef7b77e90fb");
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        const token = await login(requester);

        const [responseA, responseB] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/tasks/${taskId}/acceptance-permits`,
            cookies: { session_token: token },
          }),
          app.inject({
            method: "POST",
            url: `/tasks/${taskId}/acceptance-permits`,
            cookies: { session_token: token },
          }),
        ]);

        expect(responseA.statusCode).toBe(200);
        expect(responseB.statusCode).toBe(200);
        const bodyA = responseA.json() as { permits: Array<{ nonce: string; signature: string }> };
        const bodyB = responseB.json() as { permits: Array<{ nonce: string; signature: string }> };
        expect(bodyA.permits).toHaveLength(1);
        expect(bodyB.permits).toHaveLength(1);
        expect(bodyB.permits[0]?.nonce).toBe(bodyA.permits[0]?.nonce);
        expect(bodyB.permits[0]?.signature).toBe(bodyA.permits[0]?.signature);

        const { rows } = await pool.query(
          `SELECT id, nonce FROM acceptance_permits WHERE task_id = $1 AND agent_id = $2`,
          [taskId, agentId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.nonce).toBe(bodyA.permits[0]?.nonce);
      });

      // T-801 (Feature 8): as of that Task, this route persists a row per
      // issued permit (`insertAcceptancePermit`, dispatch/repository.ts) —
      // Feature 7's original implementation deliberately did not (see the
      // now-corrected doc comment on `issuePermitsForTask`, routes.ts).
      // This asserts that persistence actually happens end to end through
      // the real HTTP endpoint, not just at the repository-function level.
      it("persists one acceptance_permits row per candidate, all initially unconsumed, matching the response body's nonce/signature (T-801)", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const ownerA = "0x2183fefc63f0cd0e873a0000c6d07ef7b77e90f1";
        const ownerB = "0x3283fefc63f0cd0e873a0000c6d07ef7b77e90f2";
        const agentA = await insertActiveAgent(ownerA);
        const agentB = await insertActiveAgent(ownerB);
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.6, reasons: ["y"] },
        ]);
        const token = await login(requester);

        const response = await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: token },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          permits: Array<{ agentId: string; nonce: string; signature: string }>;
        };
        expect(body.permits).toHaveLength(2);

        const { rows } = await pool.query<{
          agent_id: string;
          nonce: string;
          signature: string;
          status: string;
        }>(`SELECT agent_id, nonce, signature, status FROM acceptance_permits WHERE task_id = $1`, [
          taskId,
        ]);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === "OUTSTANDING")).toBe(true);

        const byAgent = new Map(rows.map((row) => [row.agent_id, row]));
        for (const permit of body.permits) {
          const persisted = byAgent.get(permit.agentId);
          expect(persisted?.nonce).toBe(permit.nonce);
          expect(persisted?.signature).toBe(permit.signature);
        }
      });
    });

    // T-806 (human N6 BLOCK fix): replaces T-803's
    // `GET /tasks/:taskId/my-acceptance-permit` — a single wallet can now
    // hold outstanding permits for more than one candidate Agent, so the
    // caller must name which `agentId` it means.
    describe("GET /tasks/:taskId/agents/:agentId/acceptance-permit (T-806)", () => {
      it("401s an unauthenticated request", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const agentId = await insertActiveAgent("0x1183fefc63f0cd0e873a0000c6d07ef7b77e90e1");
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
        });
        expect(response.statusCode).toBe(401);
      });

      it("returns the caller's own outstanding, unexpired permit for a specific agentId", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        // The candidate itself (not the requester) is who calls this route
        // for its own wallet — its Agent is registered directly under a
        // freshly generated account this test can also sign in as.
        const candidateAccount = privateKeyToAccount(generatePrivateKey());
        const agentId = await insertActiveAgent(candidateAccount.address.toLowerCase());
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        const requesterToken = await login(requester);
        await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: requesterToken },
        });

        const candidateToken = await login(candidateAccount);

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
          cookies: { session_token: candidateToken },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json() as {
          agentId: string;
          taskId: string;
          agentWalletAddress: string;
          nonce: string;
          expiry: number;
          chainId: number;
          verifyingContract: string;
          signature: string;
        };
        expect(body.agentId).toBe(agentId);
        expect(body.taskId).toBe(taskId);
        expect(body.agentWalletAddress).toBe(candidateAccount.address.toLowerCase());
        expect(typeof body.nonce).toBe("string");
        expect(BigInt(body.nonce)).toBeGreaterThan(0n);
      });

      // T-806, user's item #2: the whole point of this route change — a
      // wallet with TWO recommended candidate Agents can fetch EACH one's
      // own independent permit, by agentId, without either being skipped.
      it("returns each candidate's own independent permit when the same wallet owns two recommended candidates", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const candidateAccount = privateKeyToAccount(generatePrivateKey());
        const agentA = await insertActiveAgent(candidateAccount.address.toLowerCase());
        const agentB = await insertActiveAgent(candidateAccount.address.toLowerCase());
        await insertRecommendationRunDirect(taskId, [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
        ]);
        const requesterToken = await login(requester);
        await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: requesterToken },
        });

        const candidateToken = await login(candidateAccount);
        const [responseA, responseB] = await Promise.all([
          app.inject({
            method: "GET",
            url: `/tasks/${taskId}/agents/${agentA}/acceptance-permit`,
            cookies: { session_token: candidateToken },
          }),
          app.inject({
            method: "GET",
            url: `/tasks/${taskId}/agents/${agentB}/acceptance-permit`,
            cookies: { session_token: candidateToken },
          }),
        ]);
        expect(responseA.statusCode).toBe(200);
        expect(responseB.statusCode).toBe(200);
        const bodyA = responseA.json() as { agentId: string; nonce: string };
        const bodyB = responseB.json() as { agentId: string; nonce: string };
        expect(bodyA.agentId).toBe(agentA);
        expect(bodyB.agentId).toBe(agentB);
        expect(bodyA.nonce).not.toBe(bodyB.nonce);
      });

      it("404s when the caller does not own agentId (even if agentId IS a candidate for this task)", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const candidateAccount = privateKeyToAccount(generatePrivateKey());
        const agentId = await insertActiveAgent(candidateAccount.address.toLowerCase());
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        const requesterToken = await login(requester);
        await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: requesterToken },
        });

        const strangerToken = await login(stranger);
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
          cookies: { session_token: strangerToken },
        });
        expect(response.statusCode).toBe(404);
      });

      it("404s when agentId is not a candidate for this task", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const token = await login(stranger);
        const notACandidateAgentId = await insertActiveAgent(stranger.address.toLowerCase());

        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${notACandidateAgentId}/acceptance-permit`,
          cookies: { session_token: token },
        });
        expect(response.statusCode).toBe(404);
      });

      it("404s when the permit has already been consumed", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const candidateAccount = privateKeyToAccount(generatePrivateKey());
        const agentId = await insertActiveAgent(candidateAccount.address.toLowerCase());
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        const requesterToken = await login(requester);
        await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: requesterToken },
        });
        await pool.query(
          `UPDATE acceptance_permits SET status = 'CONSUMED', consumed_at = now() WHERE task_id = $1 AND agent_id = $2`,
          [taskId, agentId],
        );

        const candidateToken = await login(candidateAccount);
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
          cookies: { session_token: candidateToken },
        });
        expect(response.statusCode).toBe(404);
      });

      it("404s when the permit has already been invalidated", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const candidateAccount = privateKeyToAccount(generatePrivateKey());
        const agentId = await insertActiveAgent(candidateAccount.address.toLowerCase());
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        const requesterToken = await login(requester);
        await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: requesterToken },
        });
        await pool.query(
          `UPDATE acceptance_permits SET status = 'INVALIDATED', consumed_at = now() WHERE task_id = $1 AND agent_id = $2`,
          [taskId, agentId],
        );

        const candidateToken = await login(candidateAccount);
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
          cookies: { session_token: candidateToken },
        });
        expect(response.statusCode).toBe(404);
      });

      // Regression for Codex round 1 P1 (T-803): a permit whose row still
      // reads as OUTSTANDING/unexpired must still 404 once the TASK itself
      // has left OPEN via some path other than this candidate's own
      // acceptance (cancellation, or a different candidate already
      // accepted) — letting them pay for a doomed `approve` first would
      // otherwise be possible.
      it("404s once the task itself has left OPEN, even though this candidate's own permit row is still OUTSTANDING and unexpired", async () => {
        const taskId = await insertOpenTask(requester.address.toLowerCase());
        const candidateAccount = privateKeyToAccount(generatePrivateKey());
        const agentId = await insertActiveAgent(candidateAccount.address.toLowerCase());
        await insertRecommendationRunDirect(taskId, [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ]);
        const requesterToken = await login(requester);
        await app.inject({
          method: "POST",
          url: `/tasks/${taskId}/acceptance-permits`,
          cookies: { session_token: requesterToken },
        });
        // Task leaves OPEN by a path that never touches this candidate's
        // own permit row (e.g. a different candidate's acceptance,
        // simulated directly here rather than another full acceptTask
        // flow).
        await pool.query(`UPDATE tasks SET status = 'ACCEPTED' WHERE id = $1`, [taskId]);

        const candidateToken = await login(candidateAccount);
        const response = await app.inject({
          method: "GET",
          url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
          cookies: { session_token: candidateToken },
        });
        expect(response.statusCode).toBe(404);
      });
    });
  },
);
