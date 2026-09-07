import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 20 (agent-evaluation-appeal-antifraud), T-2001 —
 * `POST /evaluation/tasks/:taskId/submit`'s real end-to-end proof (AC-2001
 * 前半, RULE_BASED path): ownership enforcement (`requireOwnedAgent`, the
 * SAME function F-503/F-504 already use), RULE_BASED tasks scored inline
 * with a real rubric, HUMAN_REQUIRED tasks left unscored for T-2002, and
 * (N4 real finding, P1, round 1) the submission+result write is atomic —
 * a failure writing the result must leave NO orphan submission behind.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

// Real `insertResult` by default (captured from the actual module below);
// individual tests can force it to throw once to prove the transaction
// rolls back the submission it was paired with, without needing a real
// constraint violation to trigger the failure.
let actualInsertResult: typeof import("./repository.js").insertResult;
const insertResultSpy = vi.fn((...args: Parameters<typeof actualInsertResult>) =>
  actualInsertResult(...args),
);
vi.mock("./repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repository.js")>();
  actualInsertResult = actual.insertResult;
  return {
    ...actual,
    insertResult: (...args: Parameters<typeof actual.insertResult>) => insertResultSpy(...args),
  };
});

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

runIfOptedIn("POST /evaluation/tasks/:taskId/submit (integration, T-2001)", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await app.close();
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    insertResultSpy.mockReset();
    insertResultSpy.mockImplementation((...args) => actualInsertResult(...args));
    await pool.query("DELETE FROM evaluation_appeals");
    await pool.query("DELETE FROM evaluation_results");
    await pool.query("DELETE FROM evaluation_submissions");
    await pool.query("DELETE FROM evaluation_tasks");
    await pool.query("DELETE FROM evaluation_rubrics");
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

  async function insertAgent(ownerAddress: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [ownerAddress],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertRuleBasedTask(requiredKeywords: string[]): Promise<string> {
    const {
      rows: [rubric],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
       VALUES ($1, 'writing', $2) RETURNING id`,
      [`rule-v-${Math.random()}`, JSON.stringify({ type: "KEYWORD_PRESENCE", requiredKeywords })],
    );
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_tasks (rubric_id, title, prompt, scoring_mode)
       VALUES ($1, 'Explain recursion', 'Explain recursion in your own words.', 'RULE_BASED')
       RETURNING id`,
      [rubric?.id],
    );
    return task?.id ?? "";
  }

  async function insertHumanRequiredTask(): Promise<string> {
    const {
      rows: [rubric],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
       VALUES ($1, 'writing', '{}') RETURNING id`,
      [`human-v-${Math.random()}`],
    );
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_tasks (rubric_id, title, prompt, scoring_mode)
       VALUES ($1, 'Open-ended essay', 'Write an essay.', 'HUMAN_REQUIRED') RETURNING id`,
      [rubric?.id],
    );
    return task?.id ?? "";
  }

  it("scores a RULE_BASED submission immediately and records a real evaluation_results row", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await login(account);
    const agentId = await insertAgent(account.address.toLowerCase());
    const evaluationTaskId = await insertRuleBasedTask(["recursion", "base case"]);

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/${evaluationTaskId}/submit`,
      cookies: { session_token: token },
      payload: {
        agentId,
        submittedContent: "Recursion needs a base case to terminate.",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("SCORED");
    expect(body.score).toBe(100);

    const { rows } = await pool.query<{ scored_by: string; score: string; rationale: string }>(
      `SELECT scored_by, score, rationale FROM evaluation_results WHERE id = $1`,
      [body.resultId],
    );
    expect(rows[0]?.scored_by).toBe("RULE");
    expect(Number(rows[0]?.score)).toBe(100);
    expect(rows[0]?.rationale).toContain("2/2");
  });

  it("T-2009 real path (用户 2026-09-06 Q-2001 决策): a RULE_BASED submission scoring >= 60 marks the Agent's baseline_evaluation_status PASSED", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await login(account);
    const agentId = await insertAgent(account.address.toLowerCase());
    const evaluationTaskId = await insertRuleBasedTask(["recursion", "base case"]);

    const before = await pool.query<{ baseline_evaluation_status: string }>(
      `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(before.rows[0]?.baseline_evaluation_status).toBe("NOT_STARTED");

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/${evaluationTaskId}/submit`,
      cookies: { session_token: token },
      payload: { agentId, submittedContent: "Recursion needs a base case to terminate." },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().score).toBeGreaterThanOrEqual(60);

    const after = await pool.query<{ baseline_evaluation_status: string }>(
      `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(after.rows[0]?.baseline_evaluation_status).toBe("PASSED");
  });

  it("T-2009 real path: a RULE_BASED submission scoring below 60 marks the Agent's baseline_evaluation_status FAILED", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await login(account);
    const agentId = await insertAgent(account.address.toLowerCase());
    const evaluationTaskId = await insertRuleBasedTask(["recursion", "base case"]);

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/${evaluationTaskId}/submit`,
      cookies: { session_token: token },
      payload: { agentId, submittedContent: "This answer mentions neither required term." },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().score).toBeLessThan(60);

    const { rows } = await pool.query<{ baseline_evaluation_status: string }>(
      `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.baseline_evaluation_status).toBe("FAILED");
  });

  it("N4 P1 fix: rolls back the submission if writing its result fails, leaving no orphan row", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await login(account);
    const agentId = await insertAgent(account.address.toLowerCase());
    const evaluationTaskId = await insertRuleBasedTask(["recursion"]);

    insertResultSpy.mockImplementationOnce(() => {
      throw new Error("simulated insertResult failure");
    });

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/${evaluationTaskId}/submit`,
      cookies: { session_token: token },
      payload: { agentId, submittedContent: "recursion needs a base case" },
    });

    // The route has no try/catch around the transaction block beyond
    // rollback+rethrow, so the request itself surfaces as a 500 — the
    // real assertion this test cares about is what's IN THE DATABASE.
    expect(response.statusCode).toBe(500);

    const { rows } = await pool.query(
      `SELECT id FROM evaluation_submissions WHERE evaluation_task_id = $1`,
      [evaluationTaskId],
    );
    expect(rows).toHaveLength(0);
  });

  it("leaves a HUMAN_REQUIRED submission unscored, pending T-2002's review queue (AC-2001 后半 precondition)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await login(account);
    const agentId = await insertAgent(account.address.toLowerCase());
    const evaluationTaskId = await insertHumanRequiredTask();

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/${evaluationTaskId}/submit`,
      cookies: { session_token: token },
      payload: { agentId, submittedContent: "my essay" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("PENDING_HUMAN_REVIEW");

    const { rows } = await pool.query(
      `SELECT er.id FROM evaluation_results er
         JOIN evaluation_submissions es ON es.id = er.submission_id
        WHERE es.evaluation_task_id = $1`,
      [evaluationTaskId],
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects submitting on behalf of an Agent the caller does not own (F-503's ownership rule reused, 403)", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    // Log the owner in first so `users` has their address (agents.owner_
    // address FK requirement), then attempt the submission as the STRANGER.
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const evaluationTaskId = await insertRuleBasedTask(["recursion"]);
    const strangerToken = await login(stranger);

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/${evaluationTaskId}/submit`,
      cookies: { session_token: strangerToken },
      payload: { agentId, submittedContent: "trying to submit for someone else's agent" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("returns 404 for a submission against a non-existent evaluation task", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const token = await login(account);
    const agentId = await insertAgent(account.address.toLowerCase());

    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/00000000-0000-0000-0000-000000000000/submit`,
      cookies: { session_token: token },
      payload: { agentId, submittedContent: "answer" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects an unauthenticated submission (401)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/evaluation/tasks/00000000-0000-0000-0000-000000000000/submit`,
      payload: { agentId: "00000000-0000-0000-0000-000000000000", submittedContent: "x" },
    });
    expect(response.statusCode).toBe(401);
  });

  describe("POST /evaluation/results/:id/appeal (T-2004, AC-2002)", () => {
    it("creates a real appeal against the caller's own Agent's result", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const token = await login(account);
      const agentId = await insertAgent(account.address.toLowerCase());
      const evaluationTaskId = await insertRuleBasedTask(["recursion"]);

      const submitResponse = await app.inject({
        method: "POST",
        url: `/evaluation/tasks/${evaluationTaskId}/submit`,
        cookies: { session_token: token },
        payload: { agentId, submittedContent: "no recursion mentioned here" },
      });
      const resultId = submitResponse.json().resultId;

      const response = await app.inject({
        method: "POST",
        url: `/evaluation/results/${resultId}/appeal`,
        cookies: { session_token: token },
        payload: { reason: "I did mention recursion indirectly" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe("PENDING");

      const { rows } = await pool.query<{
        status: string;
        reason: string;
        agent_owner_address: string;
      }>(`SELECT status, reason, agent_owner_address FROM evaluation_appeals WHERE id = $1`, [
        response.json().appealId,
      ]);
      expect(rows[0]?.status).toBe("PENDING");
      expect(rows[0]?.reason).toBe("I did mention recursion indirectly");
      expect(rows[0]?.agent_owner_address).toBe(account.address.toLowerCase());
    });

    it("rejects an appeal against a result belonging to someone else's Agent (403)", async () => {
      const owner = privateKeyToAccount(generatePrivateKey());
      const stranger = privateKeyToAccount(generatePrivateKey());
      const ownerToken = await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const evaluationTaskId = await insertRuleBasedTask(["recursion"]);
      const submitResponse = await app.inject({
        method: "POST",
        url: `/evaluation/tasks/${evaluationTaskId}/submit`,
        cookies: { session_token: ownerToken },
        payload: { agentId, submittedContent: "recursion base case" },
      });
      const resultId = submitResponse.json().resultId;

      const strangerToken = await login(stranger);
      const response = await app.inject({
        method: "POST",
        url: `/evaluation/results/${resultId}/appeal`,
        cookies: { session_token: strangerToken },
        payload: { reason: "trying to appeal someone else's result" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("returns 404 for an appeal against a non-existent result", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const token = await login(account);

      const response = await app.inject({
        method: "POST",
        url: `/evaluation/results/00000000-0000-0000-0000-000000000000/appeal`,
        cookies: { session_token: token },
        payload: { reason: "x" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("N4 P2 fix: rejects a second appeal against a result that already has one PENDING (409)", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const token = await login(account);
      const agentId = await insertAgent(account.address.toLowerCase());
      const evaluationTaskId = await insertRuleBasedTask(["recursion"]);
      const submitResponse = await app.inject({
        method: "POST",
        url: `/evaluation/tasks/${evaluationTaskId}/submit`,
        cookies: { session_token: token },
        payload: { agentId, submittedContent: "no recursion mentioned here" },
      });
      const resultId = submitResponse.json().resultId;

      const first = await app.inject({
        method: "POST",
        url: `/evaluation/results/${resultId}/appeal`,
        cookies: { session_token: token },
        payload: { reason: "first appeal" },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: `/evaluation/results/${resultId}/appeal`,
        cookies: { session_token: token },
        payload: { reason: "trying to appeal again" },
      });
      expect(second.statusCode).toBe(409);

      const { rows } = await pool.query(
        `SELECT id FROM evaluation_appeals WHERE evaluation_result_id = $1`,
        [resultId],
      );
      expect(rows).toHaveLength(1);
    });

    it("N4-lesson race: two truly concurrent appeals against the same result never both succeed", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const token = await login(account);
      const agentId = await insertAgent(account.address.toLowerCase());
      const evaluationTaskId = await insertRuleBasedTask(["recursion"]);
      const submitResponse = await app.inject({
        method: "POST",
        url: `/evaluation/tasks/${evaluationTaskId}/submit`,
        cookies: { session_token: token },
        payload: { agentId, submittedContent: "no recursion mentioned here" },
      });
      const resultId = submitResponse.json().resultId;

      const [first, second] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/evaluation/results/${resultId}/appeal`,
          cookies: { session_token: token },
          payload: { reason: "concurrent appeal A" },
        }),
        app.inject({
          method: "POST",
          url: `/evaluation/results/${resultId}/appeal`,
          cookies: { session_token: token },
          payload: { reason: "concurrent appeal B" },
        }),
      ]);

      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const { rows } = await pool.query(
        `SELECT id FROM evaluation_appeals WHERE evaluation_result_id = $1`,
        [resultId],
      );
      expect(rows).toHaveLength(1);
    });
  });
});
