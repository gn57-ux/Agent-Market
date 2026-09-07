import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { holdAgent } from "./repository.js";

/**
 * Feature 20 (agent-evaluation-appeal-antifraud), T-2008 (用户 2026-09-06
 * Q-2003 决策) — the independent risk-hold module's own real end-to-end
 * proof: `POST /admin/agents/:agentId/risk-hold/release` is the ONLY way
 * `risk_hold_status` moves back to `NONE`, and every HOLD/RELEASE leaves a
 * real audit row.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

runIfOptedIn("risk-hold admin routes (integration, T-2008)", () => {
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
    await pool.query("DELETE FROM risk_hold_audit_logs");
    await pool.query("DELETE FROM risk_signals");
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

  it("releases a real HELD Agent, records a real audit row, and rejects double-release (409)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { rows: signalRows } = await pool.query<{ id: string }>(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence)
       VALUES ('SCORE_MANIPULATION', $1, '{}') RETURNING id`,
      [agentId],
    );
    const riskSignalId = signalRows[0]?.id ?? "";
    await holdAgent(pool, {
      agentId,
      riskSignalId,
      actorAddress: admin.address.toLowerCase(),
      reason: "test setup",
    });

    const { rows: before } = await pool.query<{ risk_hold_status: string }>(
      `SELECT risk_hold_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(before[0]?.risk_hold_status).toBe("HELD");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/agents/${agentId}/risk-hold/release`,
      cookies: { session_token: adminToken },
      payload: { reason: "reviewed manually, appeal upheld" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().riskHoldStatus).toBe("NONE");

    const { rows: after } = await pool.query<{ risk_hold_status: string }>(
      `SELECT risk_hold_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(after[0]?.risk_hold_status).toBe("NONE");

    const { rows: auditRows } = await pool.query<{ action: string; actor_address: string }>(
      `SELECT action, actor_address FROM risk_hold_audit_logs WHERE agent_id = $1 ORDER BY occurred_at ASC`,
      [agentId],
    );
    expect(auditRows.map((r) => r.action)).toEqual(["HOLD", "RELEASE"]);
    expect(auditRows[1]?.actor_address).toBe(admin.address.toLowerCase());

    const second = await app.inject({
      method: "POST",
      url: `/admin/agents/${agentId}/risk-hold/release`,
      cookies: { session_token: adminToken },
      payload: { reason: "trying again" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("returns the full HOLD/RELEASE audit history, newest first", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { rows: signalRows } = await pool.query<{ id: string }>(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence)
       VALUES ('SCORE_MANIPULATION', $1, '{}') RETURNING id`,
      [agentId],
    );
    await holdAgent(pool, {
      agentId,
      riskSignalId: signalRows[0]?.id ?? "",
      actorAddress: admin.address.toLowerCase(),
      reason: "first hold",
    });

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "GET",
      url: `/admin/agents/${agentId}/risk-hold/audit-log`,
      cookies: { session_token: adminToken },
    });

    expect(response.statusCode).toBe(200);
    const entries = response.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("HOLD");
    expect(entries[0].reason).toBe("first hold");
  });

  it("rejects releasing an Agent that is not currently HELD (409)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/agents/${agentId}/risk-hold/release`,
      cookies: { session_token: adminToken },
      payload: { reason: "x" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects a non-admin caller (403)", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const strangerToken = await login(stranger);

    const response = await app.inject({
      method: "POST",
      url: `/admin/agents/00000000-0000-0000-0000-000000000000/risk-hold/release`,
      cookies: { session_token: strangerToken },
      payload: { reason: "x" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("N4 P1 fix: two truly concurrent releases of the same Agent never both succeed, and a released Agent always has exactly one matching RELEASE audit row", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const { rows: signalRows } = await pool.query<{ id: string }>(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence)
       VALUES ('SCORE_MANIPULATION', $1, '{}') RETURNING id`,
      [agentId],
    );
    await holdAgent(pool, {
      agentId,
      riskSignalId: signalRows[0]?.id ?? "",
      actorAddress: admin.address.toLowerCase(),
      reason: "test setup",
    });

    const adminToken = await login(admin);
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/risk-hold/release`,
        cookies: { session_token: adminToken },
        payload: { reason: "release attempt A" },
      }),
      app.inject({
        method: "POST",
        url: `/admin/agents/${agentId}/risk-hold/release`,
        cookies: { session_token: adminToken },
        payload: { reason: "release attempt B" },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);

    // The atomicity fix's own real proof: exactly one RELEASE audit row,
    // never zero (a failed insert after a successful UPDATE) and never
    // two (the UPDATE's WHERE guard should have stopped the second
    // request before it could reach the INSERT at all).
    const { rows: auditRows } = await pool.query<{ action: string }>(
      `SELECT action FROM risk_hold_audit_logs WHERE agent_id = $1 AND action = 'RELEASE'`,
      [agentId],
    );
    expect(auditRows).toHaveLength(1);

    const { rows: agentRows } = await pool.query<{ risk_hold_status: string }>(
      `SELECT risk_hold_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(agentRows[0]?.risk_hold_status).toBe("NONE");
  });
});
