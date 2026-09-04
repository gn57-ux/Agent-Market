import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { computeEvidenceHash } from "./evidence-hash.js";

/**
 * Real-HTTP integration test for T-1002's off-chain dispute-submission
 * route (`POST`/`GET /tasks/:taskId/disputes`) — the routes.ts layer
 * itself was previously only exercised indirectly via
 * `tasks/disputes.integration.test.ts`'s direct `insertDispute` calls,
 * never through the actual endpoint. Skipped unless a human opts in with
 * RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe TEST_DATABASE_URL,
 * same as every other `*.integration.test.ts` suite.
 *
 * The "does not leave an orphaned OPEN dispute on a terminal task" test
 * below is this suite's own reason for existing: Codex review (T-1002
 * round 2, P2) found that the original handler read task status/deadline
 * and then INSERTed the dispute as two separate, unlocked steps — a
 * concurrent settlement could move the task out of `SUBMITTED` in
 * between, and the dispute would still be inserted successfully. The fix
 * wraps both in one transaction that takes the SAME `SELECT ... FOR
 * UPDATE` row lock `transitionTaskStatus` (tasks/repository.ts) already
 * takes for every settlement/dispute-resolution transition.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE";

runIfOptedIn("POST/GET /tasks/:taskId/disputes (integration, T-1002)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM audit_logs");
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM tasks");
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

  async function insertTaskWithStatus(
    status: "SUBMITTED" | "RELEASED",
    overrides: { reviewDeadline?: string } = {},
  ): Promise<{ taskId: string; agentId: string }> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [agent.address.toLowerCase()],
    );
    const agentId = agentRows[0]?.id;
    if (!agentId) throw new Error("insertTaskWithStatus: no agent id returned");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline,
          status, accepted_agent_address, accepted_agent_id, accepted_at, submitted_at, review_deadline, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', $3, $4, $5, now(), now(), $6, 'AUTOMATION')
       RETURNING id`,
      [
        requester.address.toLowerCase(),
        "0x1111111111111111111111111111111111111111",
        status,
        agent.address.toLowerCase(),
        agentId,
        overrides.reviewDeadline ?? "2099-01-01T00:00:00Z",
      ],
    );
    const taskId = rows[0]?.id;
    if (!taskId) throw new Error("insertTaskWithStatus: no task id returned");
    return { taskId, agentId };
  }

  it("accepts a dispute submission from the requester on a SUBMITTED task and returns the same evidenceHash computeEvidenceHash produces (AC-1003)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const token = await login(requester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: token },
      payload: { reason: "quality issue", evidenceSummary: "the deliverable is incomplete" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { disputeId: string; evidenceHash: string };
    expect(body.evidenceHash).toBe(computeEvidenceHash("the deliverable is incomplete"));

    const getResponse = await app.inject({ method: "GET", url: `/tasks/${taskId}/disputes` });
    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json() as {
      status: string;
      disputeId: string;
      evidenceSummary?: string;
      evidenceHash?: string;
    };
    expect(getBody.status).toBe("OPEN");
    expect(getBody.disputeId).toBe(body.disputeId);
    // T-1002 human-review fix (Codex round 2, P1): an anonymous GET must
    // never see the dispute's private evidence text.
    expect(getBody.evidenceSummary).toBeUndefined();
    expect(getBody.evidenceHash).toBeUndefined();
  });

  it("GET exposes evidenceSummary to the requester and the accepted Agent, but not to an anonymous caller of the same dispute (T-1002 human-review fix, Codex round 2, P1)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const requesterToken = await login(requester);
    const agentToken = await login(agent);

    const postResponse = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: requesterToken },
      payload: { reason: "quality issue", evidenceSummary: "confidential evidence text" },
    });
    expect(postResponse.statusCode).toBe(201);

    const anonymousGet = await app.inject({ method: "GET", url: `/tasks/${taskId}/disputes` });
    expect(anonymousGet.statusCode).toBe(200);
    expect((anonymousGet.json() as { evidenceSummary?: string }).evidenceSummary).toBeUndefined();

    const requesterGet = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: requesterToken },
    });
    expect(requesterGet.statusCode).toBe(200);
    expect((requesterGet.json() as { evidenceSummary?: string }).evidenceSummary).toBe(
      "confidential evidence text",
    );

    const agentGet = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: agentToken },
    });
    expect(agentGet.statusCode).toBe(200);
    expect((agentGet.json() as { evidenceSummary?: string }).evidenceSummary).toBe(
      "confidential evidence text",
    );

    // The "logged-in but unrelated user" and "on-chain-verified arbitrator"
    // viewer categories both require resolving real chain config / an RPC
    // client (`access-guard.ts`'s on-chain `isArbitrator` check) — not
    // exercisable at this full-HTTP layer without a real or injected
    // chain, matching this codebase's established convention that
    // chain-touching logic is tested by calling the underlying service
    // function directly. Both are covered in
    // `disputes/service.integration.test.ts` (`getDisputeView`, real DB +
    // fake `ChainRpcClient`), including the explicit "self-claimed
    // arbitrator that readHasRole rejects still gets only the public
    // projection" case.
  });

  it("rejects a dispute submission from a non-requester (403)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const token = await login(agent);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: token },
      payload: { reason: "quality issue", evidenceSummary: "the deliverable is incomplete" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a second dispute submission while one is already OPEN (409)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const token = await login(requester);

    const first = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: token },
      payload: { reason: "first", evidenceSummary: "first evidence" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: token },
      payload: { reason: "second", evidenceSummary: "second evidence" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects a dispute submission once the review deadline has already passed (409)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED", {
      reviewDeadline: "2000-01-01T00:00:00Z",
    });
    const token = await login(requester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes`,
      cookies: { session_token: token },
      payload: { reason: "quality issue", evidenceSummary: "the deliverable is incomplete" },
    });

    expect(response.statusCode).toBe(409);
  });

  it("does not leave an orphaned OPEN dispute row when the task is settled concurrently with the submission (Codex review, T-1002 round 2, P2)", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const token = await login(requester);

    // Simulates the settlement verification's own row-locking transition
    // racing the dispute submission: whichever transaction's
    // `SELECT ... FOR UPDATE` commits first determines the outcome, and
    // the other must see the post-commit state, never a stale read.
    const raceClient = await pool.connect();
    try {
      await raceClient.query("BEGIN");
      await raceClient.query(`SELECT status FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);

      const disputeRequest = app.inject({
        method: "POST",
        url: `/tasks/${taskId}/disputes`,
        cookies: { session_token: token },
        payload: { reason: "quality issue", evidenceSummary: "the deliverable is incomplete" },
      });

      // Give the dispute request a chance to reach (and block on) its own
      // FOR UPDATE before this transaction commits the task to RELEASED.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await raceClient.query(`UPDATE tasks SET status = 'RELEASED' WHERE id = $1`, [taskId]);
      await raceClient.query("COMMIT");

      const response = await disputeRequest;
      expect(response.statusCode).toBe(409);
    } finally {
      raceClient.release();
    }

    const { rows } = await pool.query(`SELECT * FROM disputes WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(0);

    const { rows: taskRows } = await pool.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = $1`,
      [taskId],
    );
    expect(taskRows[0]?.status).toBe("RELEASED");
  });

  it("returns 404 from GET when no dispute has ever been submitted for the task", async () => {
    const { taskId } = await insertTaskWithStatus("SUBMITTED");
    const response = await app.inject({ method: "GET", url: `/tasks/${taskId}/disputes` });
    expect(response.statusCode).toBe(404);
  });
});
