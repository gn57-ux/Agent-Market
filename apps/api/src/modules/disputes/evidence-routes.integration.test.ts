import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { computeEvidenceHash } from "./evidence-hash.js";
import { insertDispute } from "./repository.js";

/**
 * Feature 21 (arbitration-committee), T-2108 (F-2110) — the required
 * "真实提交多轮举证，记录完整可查询" scenario: the real requester submits
 * round 1, the real accepted Agent submits round 2 for the SAME real open
 * dispute, and the complete two-round timeline is genuinely queryable by
 * either real party in submission order.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

const YD_TOKEN_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

runIfOptedIn("dispute evidence routes (integration, T-2108)", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const bystander = privateKeyToAccount(generatePrivateKey());

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
    await pool.query("DELETE FROM dispute_evidence_submissions");
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

  async function insertTaskWithOpenDispute(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2), ($3) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
      bystander.address.toLowerCase(),
    ]);
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Agent', 'desc', 'writing', $1) RETURNING id`,
      [agent.address.toLowerCase()],
    );
    const agentId = agentRows[0]?.id;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline,
          status, accepted_agent_address, accepted_agent_id, accepted_at, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', 'SUBMITTED', $3, $4, now(), 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase(), YD_TOKEN_ADDRESS, agent.address.toLowerCase(), agentId],
    );
    const taskId = rows[0]?.id ?? "";

    const evidenceHash = computeEvidenceHash("original filing evidence");
    await insertDispute(pool, {
      taskId,
      requesterAddress: requester.address.toLowerCase(),
      reason: "quality dispute",
      evidenceSummary: "original filing evidence",
      evidenceHash,
    });
    return taskId;
  }

  it("records a real multi-round, multi-party evidence timeline and returns it complete and in order", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const requesterToken = await login(requester);
    const agentToken = await login(agent);

    const round1 = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: requesterToken },
      payload: { content: "requester's round 1: original screenshots" },
    });
    expect(round1.statusCode).toBe(201);
    expect((round1.json() as { submitterRole: string }).submitterRole).toBe("REQUESTER");

    const round2 = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: agentToken },
      payload: { content: "agent's round 1 rebuttal: delivery logs" },
    });
    expect(round2.statusCode).toBe(201);
    expect((round2.json() as { submitterRole: string }).submitterRole).toBe("AGENT");

    const round3 = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: requesterToken },
      payload: { content: "requester's round 2: further clarification" },
    });
    expect(round3.statusCode).toBe(201);

    const listResponse = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: requesterToken },
    });
    expect(listResponse.statusCode).toBe(200);
    const submissions = (
      listResponse.json() as { submissions: { submitterRole: string; content: string }[] }
    ).submissions;
    expect(submissions).toHaveLength(3);
    expect(submissions.map((s) => s.submitterRole)).toEqual(["REQUESTER", "AGENT", "REQUESTER"]);
    expect(submissions[0]?.content).toBe("requester's round 1: original screenshots");
    expect(submissions[2]?.content).toBe("requester's round 2: further clarification");
  });

  // N4 P2 fix (round 2): cursor pagination — a real timeline larger than
  // one page must be walkable to completion via `nextCursor`, and the
  // real total across pages must equal the real total number of rounds
  // actually submitted (no row skipped, none duplicated).
  it("paginates a real evidence timeline larger than one page via nextCursor, with no gaps or duplicates", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const requesterToken = await login(requester);

    const totalRounds = 5;
    for (let i = 0; i < totalRounds; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/disputes/evidence`,
        cookies: { session_token: requesterToken },
        payload: { content: `round ${i}` },
      });
      expect(response.statusCode).toBe(201);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}/disputes/evidence?limit=2${cursor ? `&after=${cursor}` : ""}`,
        cookies: { session_token: requesterToken },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        submissions: { content: string }[];
        nextCursor: string | null;
      };
      expect(body.submissions.length).toBeLessThanOrEqual(2);
      collected.push(...body.submissions.map((s) => s.content));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // real safety bound against an infinite loop if the fix regresses
    } while (cursor !== null);

    expect(collected).toEqual(["round 0", "round 1", "round 2", "round 3", "round 4"]);
  });

  it("rejects a submission from someone who is neither the requester nor the accepted agent", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const bystanderToken = await login(bystander);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: bystanderToken },
      payload: { content: "unrelated submission" },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await pool.query(`SELECT * FROM dispute_evidence_submissions`);
    expect(rows).toHaveLength(0);
  });

  it("rejects reading the evidence timeline for someone who is neither party", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const requesterToken = await login(requester);
    await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: requesterToken },
      payload: { content: "private evidence" },
    });

    const bystanderToken = await login(bystander);
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: bystanderToken },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects submitting evidence for a task with no open dispute", async () => {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, '2099-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase(), YD_TOKEN_ADDRESS],
    );
    const taskId = rows[0]?.id ?? "";
    const requesterToken = await login(requester);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/disputes/evidence`,
      cookies: { session_token: requesterToken },
      payload: { content: "no dispute exists yet" },
    });
    expect(response.statusCode).toBe(404);
  });

  // N4 P1 fix (round 1): `getOpenDisputeForTask`'s own pre-check already
  // catches a dispute that was resolved BEFORE the request started (404,
  // via the test above) — the real gap this fix closes is the dispute
  // becoming resolved AFTER that pre-check reads it but BEFORE the insert
  // itself commits. Calling `insertDisputeEvidenceSubmission` directly
  // against an already-resolved dispute id exercises that exact atomic
  // `WHERE disputes.status = 'OPEN'` guard on its own — the only way to
  // deterministically reproduce "the row changed between the two steps"
  // without orchestrating a real concurrent second request.
  it("insertDisputeEvidenceSubmission returns null (fail-closed) once the dispute is no longer OPEN, even if a caller already passed an earlier open-check", async () => {
    const taskId = await insertTaskWithOpenDispute();
    const { insertDisputeEvidenceSubmission } = await import("./evidence-repository.js");
    const {
      rows: [disputeRow],
    } = await pool.query<{ id: string }>(`SELECT id FROM disputes WHERE task_id = $1`, [taskId]);
    const disputeId = disputeRow?.id ?? "";

    await pool.query(
      `UPDATE disputes SET status = 'RESOLVED', resolution = 'SUPPORT_AGENT', resolved_by = $1, resolved_at = now() WHERE id = $2`,
      [agent.address.toLowerCase(), disputeId],
    );

    const result = await insertDisputeEvidenceSubmission(pool, {
      disputeId,
      submitterAddress: requester.address,
      submitterRole: "REQUESTER",
      content: "submitted right as resolution landed",
    });
    expect(result).toBeNull();

    const { rows } = await pool.query(`SELECT * FROM dispute_evidence_submissions`);
    expect(rows).toHaveLength(0);
  });
});
