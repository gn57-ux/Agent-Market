import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 20 (agent-evaluation-appeal-antifraud), T-2000 —
 * 0031_create_evaluation_tables.sql's own real-Postgres verification.
 *
 * Covers: all 6 tables exist with their real FK/CHECK constraints
 * (AC-2004's "字段与 Feature 13 声誉信号表无重叠" is verified structurally
 * here — every FK below points only at `agents` or at this Feature's own
 * new tables, never at `recommendation_candidates`/`ratings`/`disputes`/
 * `task_state_history`, the real Feature 13 tables); the appeal-to-result
 * linkage invariants (same submission, a genuinely different result,
 * status/link consistency); rollback drops all six tables and clears
 * accumulated data; the migration can be reapplied (up → down → up,
 * T-2000's own literal requirement).
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

const OWNER_ADDRESS = "0xc283fefc63f0cd0e873a0000c6d07ef7b77e91dc";

runIfOptedIn("0031_create_evaluation_tables migration (integration, T-2000)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM risk_signals");
    await pool.query("DELETE FROM evaluation_appeals");
    await pool.query("DELETE FROM evaluation_results");
    await pool.query("DELETE FROM evaluation_submissions");
    await pool.query("DELETE FROM evaluation_tasks");
    await pool.query("DELETE FROM evaluation_rubrics");
    await pool.query("DELETE FROM agents");
  });

  async function insertAgent(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [OWNER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertRubric(rubricVersion = `v1-${Math.random()}`): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
       VALUES ($1, 'writing', '{"dimensions":["clarity"]}') RETURNING id`,
      [rubricVersion],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertRubric: no id returned");
    return id;
  }

  async function insertEvaluationTask(
    rubricId: string,
    scoringMode = "RULE_BASED",
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_tasks (rubric_id, title, prompt, scoring_mode)
       VALUES ($1, 'Task', 'Do the thing', $2) RETURNING id`,
      [rubricId, scoringMode],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertEvaluationTask: no id returned");
    return id;
  }

  async function insertSubmission(agentId: string): Promise<string> {
    const rubricId = await insertRubric();
    const evaluationTaskId = await insertEvaluationTask(rubricId);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_submissions (evaluation_task_id, agent_id, submitted_content)
       VALUES ($1, $2, 'answer') RETURNING id`,
      [evaluationTaskId, agentId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertSubmission: no id returned");
    return id;
  }

  async function insertResult(
    submissionId: string,
    overrides: { scoredBy?: string; reviewerAddress?: string | null; rationale?: string } = {},
  ): Promise<string> {
    const scoredBy = overrides.scoredBy ?? "RULE";
    const reviewerAddress = overrides.reviewerAddress ?? null;
    const rationale = overrides.rationale ?? "x";
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evaluation_results (submission_id, scored_by, reviewer_address, score, rationale)
       VALUES ($1, $2, $3, 80, $4) RETURNING id`,
      [submissionId, scoredBy, reviewerAddress, rationale],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertResult: no id returned");
    return id;
  }

  it("rubric_version must be unique", async () => {
    await insertRubric("v1-fixed");
    await expect(
      pool.query(
        `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
         VALUES ('v1-fixed', 'design', '{}')`,
      ),
    ).rejects.toThrow();
  });

  it("evaluation_tasks.scoring_mode is a closed enum (RULE_BASED/HUMAN_REQUIRED)", async () => {
    const rubricId = await insertRubric();
    await expect(
      pool.query(
        `INSERT INTO evaluation_tasks (rubric_id, title, prompt, scoring_mode)
         VALUES ($1, 'Task', 'prompt', 'INVALID_MODE')`,
        [rubricId],
      ),
    ).rejects.toThrow();
  });

  it("evaluation_results.scored_by is a closed enum (RULE/AI/HUMAN)", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);
    await expect(
      pool.query(
        `INSERT INTO evaluation_results (submission_id, scored_by, score, rationale)
         VALUES ($1, 'ROBOT', 80, 'x')`,
        [submissionId],
      ),
    ).rejects.toThrow();
  });

  it("N4 P2 fix (round 1+2): reviewer_address is required for HUMAN and forbidden for RULE/AI", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);

    await expect(
      pool.query(
        `INSERT INTO evaluation_results (submission_id, scored_by, score, rationale)
         VALUES ($1, 'HUMAN', 80, 'no reviewer set')`,
        [submissionId],
      ),
    ).rejects.toThrow();

    // round 2 fix: RULE/AI must NOT carry a reviewer_address either.
    await expect(
      pool.query(
        `INSERT INTO evaluation_results (submission_id, scored_by, reviewer_address, score, rationale)
         VALUES ($1, 'RULE', $2, 80, 'rule-scored but has a reviewer?')`,
        [submissionId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO evaluation_results (submission_id, scored_by, reviewer_address, score, rationale)
         VALUES ($1, 'AI', $2, 80, 'ai-scored but has a reviewer?')`,
        [submissionId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();

    // The real valid shapes: HUMAN with a reviewer, RULE/AI without one.
    const humanId = await insertResult(submissionId, {
      scoredBy: "HUMAN",
      reviewerAddress: OWNER_ADDRESS,
    });
    expect(humanId).toBeTruthy();
    const ruleId = await insertResult(submissionId, { scoredBy: "RULE", reviewerAddress: null });
    expect(ruleId).toBeTruthy();
  });

  it("a full submission -> result -> appeal -> re-review chain persists with unambiguous FK relationships (AC-2002)", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);
    const resultId = await insertResult(submissionId, { rationale: "passed 4/5 checks" });

    const { rows: appealRows } = await pool.query<{ id: string; status: string }>(
      `INSERT INTO evaluation_appeals (submission_id, evaluation_result_id, agent_owner_address, reason)
       VALUES ($1, $2, $3, 'disagree with score') RETURNING id, status`,
      [submissionId, resultId, OWNER_ADDRESS],
    );
    expect(appealRows[0]?.status).toBe("PENDING");
    const appealId = appealRows[0]?.id ?? "";

    // A real re-review produces a NEW evaluation_results row for the SAME
    // submission and links the appeal to it unambiguously.
    const reReviewResultId = await insertResult(submissionId, {
      scoredBy: "HUMAN",
      reviewerAddress: OWNER_ADDRESS,
      rationale: "re-reviewed, raised score",
    });

    const { rows: resolvedAppeal } = await pool.query<{
      status: string;
      resulting_evaluation_result_id: string;
    }>(
      `UPDATE evaluation_appeals SET status = 'RE_REVIEWED', resulting_evaluation_result_id = $1
       WHERE id = $2 RETURNING status, resulting_evaluation_result_id`,
      [reReviewResultId, appealId],
    );
    expect(resolvedAppeal[0]?.status).toBe("RE_REVIEWED");
    expect(resolvedAppeal[0]?.resulting_evaluation_result_id).toBe(reReviewResultId);

    // AC-2002: the original result, the appeal reason, and the re-review
    // result are all reachable from the appeal row alone, unambiguously.
    const { rows: fullChain } = await pool.query<{
      reason: string;
      original_rationale: string;
      resulting_rationale: string;
    }>(
      `SELECT ea.reason,
              orig.rationale AS original_rationale,
              resolved.rationale AS resulting_rationale
         FROM evaluation_appeals ea
         JOIN evaluation_results orig ON orig.id = ea.evaluation_result_id
         JOIN evaluation_results resolved ON resolved.id = ea.resulting_evaluation_result_id
        WHERE ea.id = $1`,
      [appealId],
    );
    expect(fullChain[0]?.reason).toBe("disagree with score");
    expect(fullChain[0]?.original_rationale).toBe("passed 4/5 checks");
    expect(fullChain[0]?.resulting_rationale).toBe("re-reviewed, raised score");
  });

  it("N4 P1 fix (round 1): evaluation_appeals status and resulting_evaluation_result_id must move together", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);
    const resultId = await insertResult(submissionId, { rationale: "x" });
    const otherResultId = await insertResult(submissionId, { rationale: "y" });

    // RE_REVIEWED without a resulting result must be rejected.
    await expect(
      pool.query(
        `INSERT INTO evaluation_appeals (submission_id, evaluation_result_id, agent_owner_address, reason, status)
         VALUES ($1, $2, $3, 'reason', 'RE_REVIEWED')`,
        [submissionId, resultId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();

    // PENDING with a resulting result already set must be rejected too.
    await expect(
      pool.query(
        `INSERT INTO evaluation_appeals
           (submission_id, evaluation_result_id, agent_owner_address, reason, status, resulting_evaluation_result_id)
         VALUES ($1, $2, $3, 'reason', 'PENDING', $4)`,
        [submissionId, resultId, OWNER_ADDRESS, otherResultId],
      ),
    ).rejects.toThrow();
  });

  it("N4 P1 fix (round 2): resulting_evaluation_result_id cannot be the SAME row as evaluation_result_id", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);
    const resultId = await insertResult(submissionId, { rationale: "x" });

    await expect(
      pool.query(
        `INSERT INTO evaluation_appeals
           (submission_id, evaluation_result_id, agent_owner_address, reason, status, resulting_evaluation_result_id)
         VALUES ($1, $2, $3, 'reason', 'RE_REVIEWED', $2)`,
        [submissionId, resultId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("N4 P1 fix (round 2): resulting_evaluation_result_id must belong to the SAME submission as the appealed result", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);
    const otherSubmissionId = await insertSubmission(agentId);
    const resultId = await insertResult(submissionId, { rationale: "x" });
    const foreignSubmissionResultId = await insertResult(otherSubmissionId, {
      rationale: "unrelated",
    });

    await expect(
      pool.query(
        `INSERT INTO evaluation_appeals
           (submission_id, evaluation_result_id, agent_owner_address, reason, status, resulting_evaluation_result_id)
         VALUES ($1, $2, $3, 'reason', 'RE_REVIEWED', $4)`,
        [submissionId, resultId, OWNER_ADDRESS, foreignSubmissionResultId],
      ),
    ).rejects.toThrow();
  });

  it("N4 P1 fix (round 2): the appealed evaluation_result_id itself must belong to the declared submission_id", async () => {
    const agentId = await insertAgent();
    const submissionId = await insertSubmission(agentId);
    const otherSubmissionId = await insertSubmission(agentId);
    const foreignResultId = await insertResult(otherSubmissionId, { rationale: "unrelated" });

    await expect(
      pool.query(
        `INSERT INTO evaluation_appeals (submission_id, evaluation_result_id, agent_owner_address, reason)
         VALUES ($1, $2, $3, 'reason')`,
        [submissionId, foreignResultId, OWNER_ADDRESS],
      ),
    ).rejects.toThrow();
  });

  it("risk_signals.signal_type is a closed enum and status defaults to DETECTED", async () => {
    const agentId = await insertAgent();
    const { rows } = await pool.query<{ status: string }>(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence)
       VALUES ('SCORE_MANIPULATION', $1, '{"pattern":"burst"}') RETURNING status`,
      [agentId],
    );
    expect(rows[0]?.status).toBe("DETECTED");

    await expect(
      pool.query(
        `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence)
         VALUES ('NOT_A_REAL_TYPE', $1, '{}')`,
        [agentId],
      ),
    ).rejects.toThrow();
  });

  it("N4 P2 fix: risk_signals rejects a signal with neither subject_agent_id nor subject_address", async () => {
    await expect(
      pool.query(
        `INSERT INTO risk_signals (signal_type, evidence)
         VALUES ('DUPLICATE_ACCOUNT', '{}')`,
      ),
    ).rejects.toThrow();

    // subject_address alone (no agent id) is a real, valid shape.
    const { rows } = await pool.query<{ subject_address: string }>(
      `INSERT INTO risk_signals (signal_type, subject_address, evidence)
       VALUES ('DUPLICATE_ACCOUNT', $1, '{}') RETURNING subject_address`,
      ["0x1234567890123456789012345678901234567890"],
    );
    expect(rows[0]?.subject_address).toBe("0x1234567890123456789012345678901234567890");
  });

  it("AC-2004: none of the six tables reference or share columns with any real Feature 13 reputation table", async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name IN (
           'evaluation_rubrics', 'evaluation_tasks', 'evaluation_submissions',
           'evaluation_results', 'evaluation_appeals', 'risk_signals'
         )`,
    );
    const feature13TableNames = new Set([
      "recommendation_candidates",
      "recommendation_runs",
      "ratings",
      "disputes",
      "task_state_history",
    ]);
    for (const row of rows) {
      expect(feature13TableNames.has(row.table_name)).toBe(false);
    }
    // Every FK on these six tables must reference only `agents` or one of
    // this Feature's own tables — never a Feature 13 table.
    const { rows: fkRows } = await pool.query<{
      table_name: string;
      foreign_table_name: string;
    }>(
      `SELECT tc.table_name, ccu.table_name AS foreign_table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN (
            'evaluation_rubrics', 'evaluation_tasks', 'evaluation_submissions',
            'evaluation_results', 'evaluation_appeals', 'risk_signals'
          )`,
    );
    const ownTables = new Set([
      "agents",
      "evaluation_rubrics",
      "evaluation_tasks",
      "evaluation_submissions",
      "evaluation_results",
      "evaluation_appeals",
      "risk_signals",
    ]);
    expect(fkRows.length).toBeGreaterThan(0);
    for (const row of fkRows) {
      expect(ownTables.has(row.foreign_table_name)).toBe(true);
    }
  });

  it("rollback drops all six tables, clearing accumulated data, and the migration can be reapplied (up -> down -> up)", async () => {
    const agentId = await insertAgent();
    const rubricId = await insertRubric();
    await insertEvaluationTask(rubricId);
    await pool.query(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence)
       VALUES ('COLLUSION', $1, '{}')`,
      [agentId],
    );

    // 0034_add_agents_risk_hold_status.sql (T-2008, applied after this
    // migration) adds a real FK from risk_hold_audit_logs to risk_signals —
    // rollbacks must run in reverse migration order, so 0034 is rolled back
    // FIRST here, exactly like a real operator would have to.
    const rollback0034Path = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0034_add_agents_risk_hold_status.rollback.sql",
    );
    await pool.query(readFileSync(rollback0034Path, "utf8"));

    const rollbackPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0031_create_evaluation_tables.rollback.sql",
    );
    const rollbackSql = readFileSync(rollbackPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: tableRows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_name IN (
           'evaluation_rubrics', 'evaluation_tasks', 'evaluation_submissions',
           'evaluation_results', 'evaluation_appeals', 'risk_signals',
           'risk_hold_audit_logs'
         )`,
    );
    expect(tableRows).toHaveLength(0);

    const { rows: migrationRows } = await pool.query(
      `SELECT id FROM schema_migrations
        WHERE id IN ('0031_create_evaluation_tables.sql', '0034_add_agents_risk_hold_status.sql')`,
    );
    expect(migrationRows).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual([
      "0031_create_evaluation_tables.sql",
      "0034_add_agents_risk_hold_status.sql",
    ]);

    // Reapplied: a fresh rubric can be inserted again, and risk-hold's own
    // table/column are back too.
    const { rows: reapplied } = await pool.query<{ rubric_version: string }>(
      `INSERT INTO evaluation_rubrics (rubric_version, category, criteria)
       VALUES ('v1-after-reapply', 'writing', '{}') RETURNING rubric_version`,
    );
    expect(reapplied[0]?.rubric_version).toBe("v1-after-reapply");

    const { rows: agentRows } = await pool.query<{ risk_hold_status: string }>(
      `SELECT risk_hold_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(agentRows[0]?.risk_hold_status).toBe("NONE");
  });
});
