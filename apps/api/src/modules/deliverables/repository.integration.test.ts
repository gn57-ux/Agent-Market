import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import {
  DeliverableSubmissionNotAllowedError,
  insertDeliverableIfSubmissionAllowed,
} from "./repository.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-902 round 2's dedicated verification
// that `insertDeliverableIfSubmissionAllowed` re-checks F-906 against the
// task's CURRENT database state at insert time — not a stale row a caller
// read earlier — closing the TOCTOU window a plain
// "check once, then insert unconditionally" implementation would have (N4
// round 2 P1, Codex).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, schema_migrations CASCADE";

runIfOptedIn("insertDeliverableIfSubmissionAllowed (integration, T-902 round 2)", () => {
  let pool: Pool;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM deliverables");
    await pool.query("DELETE FROM tasks");
  });

  async function insertTask(status: string, acceptedAgentAddress: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_address, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', $3, $4, 'AUTOMATION')
       RETURNING id`,
      [
        requester.address.toLowerCase(),
        "0x1111111111111111111111111111111111111111",
        status,
        acceptedAgentAddress,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  it("succeeds when the task's CURRENT state satisfies F-906", async () => {
    const taskId = await insertTask("ACCEPTED", agent.address.toLowerCase());

    const deliverable = await insertDeliverableIfSubmissionAllowed(
      pool,
      {
        taskId,
        agentAddress: agent.address.toLowerCase(),
        storageType: "URL",
        filePath: null,
        resultUrl: "https://example.com/result.pdf",
        mimeType: null,
        sizeBytes: null,
        resultHash: `0x${"a".repeat(64)}`,
      },
      agent.address.toLowerCase(),
    );

    expect(deliverable.id).toBeTruthy();
  });

  // This is the core TOCTOU-fix proof: the task's status is mutated to
  // something invalid via a SEPARATE, already-committed transaction AFTER
  // a caller might have read it as ACCEPTED, then
  // `insertDeliverableIfSubmissionAllowed` is called — proving it rejects
  // based on the row it reads INSIDE its own locked transaction, never a
  // caller-supplied/previously-read value.
  it("rejects when the task's status changed to non-ACCEPTED before this call, even if an earlier read saw ACCEPTED", async () => {
    const taskId = await insertTask("ACCEPTED", agent.address.toLowerCase());
    // Simulates a concurrent status transition (e.g. cancellation) landing
    // in the window between an earlier fast-path read and this call.
    await pool.query(`UPDATE tasks SET status = 'CANCELLED' WHERE id = $1`, [taskId]);

    await expect(
      insertDeliverableIfSubmissionAllowed(
        pool,
        {
          taskId,
          agentAddress: agent.address.toLowerCase(),
          storageType: "URL",
          filePath: null,
          resultUrl: "https://example.com/result.pdf",
          mimeType: null,
          sizeBytes: null,
          resultHash: `0x${"a".repeat(64)}`,
        },
        agent.address.toLowerCase(),
      ),
    ).rejects.toBeInstanceOf(DeliverableSubmissionNotAllowedError);

    const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(0);
  });

  it("rejects when the accepted Agent changed away from the caller before this call", async () => {
    const taskId = await insertTask("ACCEPTED", agent.address.toLowerCase());
    const otherAgent = privateKeyToAccount(generatePrivateKey());
    await pool.query(`UPDATE tasks SET accepted_agent_address = $1 WHERE id = $2`, [
      otherAgent.address.toLowerCase(),
      taskId,
    ]);

    await expect(
      insertDeliverableIfSubmissionAllowed(
        pool,
        {
          taskId,
          agentAddress: agent.address.toLowerCase(),
          storageType: "URL",
          filePath: null,
          resultUrl: "https://example.com/result.pdf",
          mimeType: null,
          sizeBytes: null,
          resultHash: `0x${"a".repeat(64)}`,
        },
        agent.address.toLowerCase(),
      ),
    ).rejects.toBeInstanceOf(DeliverableSubmissionNotAllowedError);
  });

  it("rejects when the delivery deadline was moved into the past before this call", async () => {
    const taskId = await insertTask("ACCEPTED", agent.address.toLowerCase());
    await pool.query(`UPDATE tasks SET delivery_deadline = '2000-01-01T00:00:00Z' WHERE id = $1`, [
      taskId,
    ]);

    await expect(
      insertDeliverableIfSubmissionAllowed(
        pool,
        {
          taskId,
          agentAddress: agent.address.toLowerCase(),
          storageType: "URL",
          filePath: null,
          resultUrl: "https://example.com/result.pdf",
          mimeType: null,
          sizeBytes: null,
          resultHash: `0x${"a".repeat(64)}`,
        },
        agent.address.toLowerCase(),
      ),
    ).rejects.toBeInstanceOf(DeliverableSubmissionNotAllowedError);
  });
});
