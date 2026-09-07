import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 20 (agent-evaluation-appeal-antifraud), T-2002 —
 * `GET /admin/evaluation/pending-review` / `POST /admin/evaluation/results/
 * :id/review`'s real end-to-end proof (AC-2001 后半, AC-2005): only
 * `HUMAN_REQUIRED` + unscored submissions appear in the queue; a real
 * admin review creates a `scored_by = 'HUMAN'` result with a real
 * `reviewer_address` (AC-2005's "两者在展示层可区分" — distinguishable
 * from T-2001's `scored_by = 'RULE'` rows, already covered there);
 * double-review and wrong-scoring-mode misuse are rejected. T-2003's
 * `ai-scorer.ts` is mocked (not a fake HTTP server) — `ai-scorer.test.ts`
 * already proves the real Ollama HTTP protocol works; this file only needs
 * to prove the ENDPOINT's own logic (validation, DB write, queue-exit
 * scoping), independent of a running local model.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const generateAiScoreSuggestionMock = vi.fn();
vi.mock("./ai-scorer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-scorer.js")>();
  return { ...actual, generateAiScoreSuggestion: generateAiScoreSuggestionMock };
});

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("evaluation admin routes (integration, T-2002)", () => {
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
    generateAiScoreSuggestionMock.mockReset();
    await pool.query("DELETE FROM evaluation_appeals");
    await pool.query("DELETE FROM evaluation_results");
    await pool.query("DELETE FROM evaluation_submissions");
    await pool.query("DELETE FROM evaluation_tasks");
    await pool.query("DELETE FROM evaluation_rubrics");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM admin_roles");
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

  async function seedAdmin(address: string): Promise<void> {
    await pool.query(`INSERT INTO admin_roles (address, granted_by) VALUES ($1, $1)`, [
      address.toLowerCase(),
    ]);
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

  async function insertTaskAndSubmission(
    agentId: string,
    scoringMode: "RULE_BASED" | "HUMAN_REQUIRED",
  ): Promise<{ evaluationTaskId: string; submissionId: string }> {
    const {
      rows: [rubric],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
       VALUES ($1, 'writing', '{}') RETURNING id`,
      [`v-${Math.random()}`],
    );
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_tasks (rubric_id, title, prompt, scoring_mode)
       VALUES ($1, 'Essay', 'Write an essay.', $2) RETURNING id`,
      [rubric?.id, scoringMode],
    );
    const evaluationTaskId = task?.id ?? "";
    const {
      rows: [submission],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_submissions (evaluation_task_id, agent_id, submitted_content)
       VALUES ($1, $2, 'my essay content') RETURNING id`,
      [evaluationTaskId, agentId],
    );
    return { evaluationTaskId, submissionId: submission?.id ?? "" };
  }

  it("lists only HUMAN_REQUIRED, unscored submissions in the pending-review queue", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());

    const { submissionId: pendingSubmissionId } = await insertTaskAndSubmission(
      agentId,
      "HUMAN_REQUIRED",
    );
    // A RULE_BASED submission must never appear in the human queue.
    await insertTaskAndSubmission(agentId, "RULE_BASED");
    // An already-scored HUMAN_REQUIRED submission must not reappear either.
    const { submissionId: scoredSubmissionId } = await insertTaskAndSubmission(
      agentId,
      "HUMAN_REQUIRED",
    );
    await pool.query(
      `INSERT INTO evaluation_results (submission_id, scored_by, reviewer_address, score, rationale)
       VALUES ($1, 'HUMAN', $2, 80, 'already reviewed')`,
      [scoredSubmissionId, admin.address.toLowerCase()],
    );

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "GET",
      url: "/admin/evaluation/pending-review",
      cookies: { session_token: adminToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.submissions.map((s: { submissionId: string }) => s.submissionId)).toEqual([
      pendingSubmissionId,
    ]);
  });

  it("a real admin review creates a HUMAN-scored result with a real reviewer_address (AC-2005)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/evaluation/results/${submissionId}/review`,
      cookies: { session_token: adminToken },
      payload: { score: 92, rationale: "well-structured essay" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.scoredBy).toBe("HUMAN");
    expect(body.reviewerAddress).toBe(admin.address.toLowerCase());

    const { rows } = await pool.query<{
      scored_by: string;
      reviewer_address: string;
      score: string;
    }>(`SELECT scored_by, reviewer_address, score FROM evaluation_results WHERE id = $1`, [
      body.resultId,
    ]);
    expect(rows[0]?.scored_by).toBe("HUMAN");
    expect(rows[0]?.reviewer_address).toBe(admin.address.toLowerCase());
    expect(Number(rows[0]?.score)).toBe(92);
  });

  it("T-2009 real path (用户 2026-09-06 Q-2001 决策): a passing HUMAN review marks the Agent's baseline_evaluation_status PASSED", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/evaluation/results/${submissionId}/review`,
      cookies: { session_token: adminToken },
      payload: { score: 92, rationale: "well-structured essay" },
    });
    expect(response.statusCode).toBe(201);

    const { rows } = await pool.query<{ baseline_evaluation_status: string }>(
      `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.baseline_evaluation_status).toBe("PASSED");
  });

  it("T-2009 real path: a failing HUMAN review marks the Agent's baseline_evaluation_status FAILED", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/evaluation/results/${submissionId}/review`,
      cookies: { session_token: adminToken },
      payload: { score: 30, rationale: "does not meet the bar" },
    });
    expect(response.statusCode).toBe(201);

    const { rows } = await pool.query<{ baseline_evaluation_status: string }>(
      `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.baseline_evaluation_status).toBe("FAILED");
  });

  it("rejects a second review of the same submission (409)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
    const adminToken = await login(admin);

    const first = await app.inject({
      method: "POST",
      url: `/admin/evaluation/results/${submissionId}/review`,
      cookies: { session_token: adminToken },
      payload: { score: 80, rationale: "first review" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/admin/evaluation/results/${submissionId}/review`,
      cookies: { session_token: adminToken },
      payload: { score: 90, rationale: "trying to review again" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("N4 P1 fix: two truly concurrent reviews of the same submission never both succeed (real race, not simulated)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
    const adminToken = await login(admin);

    // Fired with Promise.all (no await between them) — both requests reach
    // the handler before either has committed, the same real race the
    // FOR UPDATE row lock (not this test's own timing) must resolve.
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/admin/evaluation/results/${submissionId}/review`,
        cookies: { session_token: adminToken },
        payload: { score: 80, rationale: "concurrent review A" },
      }),
      app.inject({
        method: "POST",
        url: `/admin/evaluation/results/${submissionId}/review`,
        cookies: { session_token: adminToken },
        payload: { score: 90, rationale: "concurrent review B" },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([201, 409]);

    const { rows } = await pool.query(
      `SELECT id FROM evaluation_results WHERE submission_id = $1`,
      [submissionId],
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects reviewing a RULE_BASED submission through the human-review endpoint (409)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { submissionId } = await insertTaskAndSubmission(agentId, "RULE_BASED");
    const adminToken = await login(admin);

    const response = await app.inject({
      method: "POST",
      url: `/admin/evaluation/results/${submissionId}/review`,
      cookies: { session_token: adminToken },
      payload: { score: 80, rationale: "trying to hand-score a rule task" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects a non-admin caller (403)", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const strangerToken = await login(stranger);

    const response = await app.inject({
      method: "GET",
      url: "/admin/evaluation/pending-review",
      cookies: { session_token: strangerToken },
    });
    expect(response.statusCode).toBe(403);
  });

  async function insertResultAndAppeal(
    submissionId: string,
    ownerAddress: string,
  ): Promise<{ resultId: string; appealId: string }> {
    const {
      rows: [result],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_results (submission_id, scored_by, reviewer_address, score, rationale)
       VALUES ($1, 'RULE', NULL, 40, 'initial score') RETURNING id`,
      [submissionId],
    );
    const resultId = result?.id ?? "";
    const {
      rows: [appeal],
    } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_appeals (submission_id, evaluation_result_id, agent_owner_address, reason)
       VALUES ($1, $2, $3, 'I disagree with this score') RETURNING id`,
      [submissionId, resultId, ownerAddress.toLowerCase()],
    );
    return { resultId, appealId: appeal?.id ?? "" };
  }

  describe("POST /admin/evaluation/appeals/:appealId/resolve (T-2004, AC-2002)", () => {
    it("a real admin re-review creates a new HUMAN result and marks the appeal RE_REVIEWED", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "RULE_BASED");
      const { resultId: originalResultId, appealId } = await insertResultAndAppeal(
        submissionId,
        owner.address,
      );

      const adminToken = await login(admin);
      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/appeals/${appealId}/resolve`,
        cookies: { session_token: adminToken },
        payload: { score: 85, rationale: "re-reviewed, deserves a higher score" },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.status).toBe("RE_REVIEWED");
      expect(body.scoredBy).toBe("HUMAN");
      expect(body.reviewerAddress).toBe(admin.address.toLowerCase());
      expect(body.resultId).not.toBe(originalResultId);

      const { rows } = await pool.query<{
        status: string;
        resulting_evaluation_result_id: string;
      }>(`SELECT status, resulting_evaluation_result_id FROM evaluation_appeals WHERE id = $1`, [
        appealId,
      ]);
      expect(rows[0]?.status).toBe("RE_REVIEWED");
      expect(rows[0]?.resulting_evaluation_result_id).toBe(body.resultId);

      const { rows: resultRows } = await pool.query<{ scored_by: string; score: string }>(
        `SELECT scored_by, score FROM evaluation_results WHERE id = $1`,
        [body.resultId],
      );
      expect(resultRows[0]?.scored_by).toBe("HUMAN");
      expect(Number(resultRows[0]?.score)).toBe(85);
    });

    it("rejects resolving an already-resolved appeal (409)", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "RULE_BASED");
      const { appealId } = await insertResultAndAppeal(submissionId, owner.address);
      const adminToken = await login(admin);

      const first = await app.inject({
        method: "POST",
        url: `/admin/evaluation/appeals/${appealId}/resolve`,
        cookies: { session_token: adminToken },
        payload: { score: 85, rationale: "first resolution" },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: `/admin/evaluation/appeals/${appealId}/resolve`,
        cookies: { session_token: adminToken },
        payload: { score: 90, rationale: "trying to resolve again" },
      });
      expect(second.statusCode).toBe(409);
    });

    it("N4-lesson race: two truly concurrent resolutions of the same appeal never both succeed", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "RULE_BASED");
      const { appealId } = await insertResultAndAppeal(submissionId, owner.address);
      const adminToken = await login(admin);

      const [first, second] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/admin/evaluation/appeals/${appealId}/resolve`,
          cookies: { session_token: adminToken },
          payload: { score: 80, rationale: "concurrent resolve A" },
        }),
        app.inject({
          method: "POST",
          url: `/admin/evaluation/appeals/${appealId}/resolve`,
          cookies: { session_token: adminToken },
          payload: { score: 90, rationale: "concurrent resolve B" },
        }),
      ]);

      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const { rows } = await pool.query(
        `SELECT resulting_evaluation_result_id FROM evaluation_appeals WHERE id = $1`,
        [appealId],
      );
      expect(rows[0]?.resulting_evaluation_result_id).not.toBeNull();
    });

    it("returns 404 for resolving a non-existent appeal", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/appeals/00000000-0000-0000-0000-000000000000/resolve`,
        cookies: { session_token: adminToken },
        payload: { score: 80, rationale: "x" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects a non-admin caller (403)", async () => {
      const owner = privateKeyToAccount(generatePrivateKey());
      const stranger = privateKeyToAccount(generatePrivateKey());
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "RULE_BASED");
      const { appealId } = await insertResultAndAppeal(submissionId, owner.address);

      const strangerToken = await login(stranger);
      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/appeals/${appealId}/resolve`,
        cookies: { session_token: strangerToken },
        payload: { score: 80, rationale: "x" },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("POST /admin/evaluation/submissions/:id/ai-suggestion (T-2003)", () => {
    it("creates a real scored_by = 'AI' result and never touches baseline_evaluation_status", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
      generateAiScoreSuggestionMock.mockResolvedValueOnce({ score: 65, rationale: "结构合理" });

      const before = await pool.query<{ baseline_evaluation_status: string }>(
        `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
        [agentId],
      );

      const adminToken = await login(admin);
      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/${submissionId}/ai-suggestion`,
        cookies: { session_token: adminToken },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.scoredBy).toBe("AI");
      expect(body.score).toBe(65);
      expect(generateAiScoreSuggestionMock).toHaveBeenCalledWith(
        "Write an essay.",
        "my essay content",
      );

      const { rows } = await pool.query<{ scored_by: string; reviewer_address: string | null }>(
        `SELECT scored_by, reviewer_address FROM evaluation_results WHERE id = $1`,
        [body.resultId],
      );
      expect(rows[0]?.scored_by).toBe("AI");
      expect(rows[0]?.reviewer_address).toBeNull();

      // F-2012's admission gate must only ever move on a RULE/HUMAN result.
      const after = await pool.query<{ baseline_evaluation_status: string }>(
        `SELECT baseline_evaluation_status FROM agents WHERE id = $1`,
        [agentId],
      );
      expect(after.rows).toEqual(before.rows);
    });

    it("an AI suggestion does NOT remove the submission from the human-review queue", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
      generateAiScoreSuggestionMock.mockResolvedValueOnce({ score: 65, rationale: "结构合理" });

      const adminToken = await login(admin);
      await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/${submissionId}/ai-suggestion`,
        cookies: { session_token: adminToken },
      });

      const pendingResponse = await app.inject({
        method: "GET",
        url: "/admin/evaluation/pending-review",
        cookies: { session_token: adminToken },
      });
      const pendingIds = pendingResponse
        .json()
        .submissions.map((s: { submissionId: string }) => s.submissionId);
      expect(pendingIds).toContain(submissionId);
    });

    it("rejects a RULE_BASED submission (409)", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "RULE_BASED");

      const adminToken = await login(admin);
      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/${submissionId}/ai-suggestion`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(409);
      expect(generateAiScoreSuggestionMock).not.toHaveBeenCalled();
    });

    it("rejects a submission that has already been reviewed by a human (409)", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
      const adminToken = await login(admin);
      await app.inject({
        method: "POST",
        url: `/admin/evaluation/results/${submissionId}/review`,
        cookies: { session_token: adminToken },
        payload: { score: 80, rationale: "already reviewed" },
      });

      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/${submissionId}/ai-suggestion`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(409);
    });

    it("returns 502 when the local model call fails", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
      const { AiScorerError } = await import("./ai-scorer.js");
      generateAiScoreSuggestionMock.mockRejectedValueOnce(new AiScorerError("本地模型不可用"));

      const adminToken = await login(admin);
      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/${submissionId}/ai-suggestion`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(502);
    });

    it("N4 P2 fix: discards the AI suggestion if a human review completed WHILE the model call was in flight (real race, not simulated)", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const { submissionId } = await insertTaskAndSubmission(agentId, "HUMAN_REQUIRED");
      const adminToken = await login(admin);

      // Simulate the model call being slow enough for a real human review
      // to land in the meantime: the mock resolves only AFTER we've
      // already sent the concurrent human review request below.
      let resolveSuggestion: (value: { score: number; rationale: string }) => void = () => {
        throw new Error("resolveSuggestion called before the mock installed it");
      };
      generateAiScoreSuggestionMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSuggestion = resolve;
          }),
      );

      const aiRequestPromise = app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/${submissionId}/ai-suggestion`,
        cookies: { session_token: adminToken },
      });

      // Give the AI request a moment to reach (and hang inside) the mock.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const humanReviewResponse = await app.inject({
        method: "POST",
        url: `/admin/evaluation/results/${submissionId}/review`,
        cookies: { session_token: adminToken },
        payload: { score: 90, rationale: "real human review lands first" },
      });
      expect(humanReviewResponse.statusCode).toBe(201);

      resolveSuggestion({ score: 40, rationale: "stale suggestion" });
      const aiResponse = await aiRequestPromise;
      expect(aiResponse.statusCode).toBe(409);

      const { rows } = await pool.query(
        `SELECT scored_by FROM evaluation_results WHERE submission_id = $1`,
        [submissionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.scored_by).toBe("HUMAN");
    });

    it("returns 404 for a non-existent submission", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/00000000-0000-0000-0000-000000000000/ai-suggestion`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects a non-admin caller (403)", async () => {
      const stranger = privateKeyToAccount(generatePrivateKey());
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "POST",
        url: `/admin/evaluation/submissions/00000000-0000-0000-0000-000000000000/ai-suggestion`,
        cookies: { session_token: strangerToken },
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
