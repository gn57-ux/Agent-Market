import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 21 (arbitration-committee), T-2107 (F-2106) — the required
 * "构造一个模拟利益冲突场景，验证回避记录被正确记录" scenario: a real
 * dispute is opened where the requester and a committee member happen to
 * be closely associated (the same real wallet, the simplest real
 * conflict-of-interest shape this test can construct without inventing a
 * separate "known associates" registry this Feature was never asked to
 * build) — an admin records that member's real recusal for this real
 * dispute, and it is genuinely queryable afterward.
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

const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn("arbitration recusal routes (integration, T-2107)", () => {
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
    await pool.query("DELETE FROM arbitration_recusals");
    await pool.query("DELETE FROM arbitration_committee_members");
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM tasks");
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

  async function seedActiveCommitteeMember(address: string, addedBy: string): Promise<void> {
    await pool.query(
      `INSERT INTO arbitration_committee_members (member_address, added_by) VALUES ($1, $2)`,
      [address.toLowerCase(), addedBy.toLowerCase()],
    );
  }

  const admin = privateKeyToAccount(generatePrivateKey());
  // The requester AND the recusing committee member are the SAME real
  // wallet — the simplest, unambiguous real conflict of interest this
  // test can construct: this committee member cannot be neutral about a
  // dispute they themselves are the requester in.
  const conflictedRequesterAndMember = privateKeyToAccount(generatePrivateKey());

  async function insertDisputeForRequester(requesterAddress: string): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requesterAddress.toLowerCase(),
    ]);
    const {
      rows: [task],
    } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'DISPUTED', 'AUTOMATION')
       RETURNING id`,
      [requesterAddress.toLowerCase(), TOKEN_ADDRESS],
    );
    const taskId = task?.id ?? "";
    const {
      rows: [dispute],
    } = await pool.query<{ id: string }>(
      `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash)
       VALUES ($1, $2, 'quality dispute', 'summary', $3) RETURNING id`,
      [taskId, requesterAddress.toLowerCase(), "0x" + "d4".repeat(32)],
    );
    return dispute?.id ?? "";
  }

  it("records a real recusal for the exact conflict-of-interest scenario (the recusing member IS the requester) and it is genuinely queryable", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);
    await seedActiveCommitteeMember(conflictedRequesterAndMember.address, admin.address);
    const disputeId = await insertDisputeForRequester(conflictedRequesterAndMember.address);

    const recordResponse = await app.inject({
      method: "POST",
      url: `/admin/disputes/${disputeId}/recusals`,
      cookies: { session_token: adminToken },
      payload: {
        memberAddress: conflictedRequesterAndMember.address,
        reason: "该仲裁员是本争议的需求方本人，存在直接利益冲突，回避本次裁决。",
      },
    });
    expect(recordResponse.statusCode).toBe(201);
    const recorded = recordResponse.json() as {
      recusal: { disputeId: string; memberAddress: string; reason: string };
    };
    expect(recorded.recusal.disputeId).toBe(disputeId);
    expect(recorded.recusal.memberAddress).toBe(conflictedRequesterAndMember.address.toLowerCase());

    const listResponse = await app.inject({
      method: "GET",
      url: `/admin/disputes/${disputeId}/recusals`,
      cookies: { session_token: adminToken },
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listResponse.json() as { recusals: { memberAddress: string }[] };
    expect(listed.recusals).toHaveLength(1);
    expect(listed.recusals[0]?.memberAddress).toBe(
      conflictedRequesterAndMember.address.toLowerCase(),
    );
  });

  it("rejects declaring the same recusal twice for the same dispute", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);
    await seedActiveCommitteeMember(conflictedRequesterAndMember.address, admin.address);
    const disputeId = await insertDisputeForRequester(conflictedRequesterAndMember.address);

    await app.inject({
      method: "POST",
      url: `/admin/disputes/${disputeId}/recusals`,
      cookies: { session_token: adminToken },
      payload: { memberAddress: conflictedRequesterAndMember.address, reason: "conflict" },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/admin/disputes/${disputeId}/recusals`,
      cookies: { session_token: adminToken },
      payload: { memberAddress: conflictedRequesterAndMember.address, reason: "conflict again" },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("a non-admin cannot record a recusal", async () => {
    await seedAdmin(admin.address);
    const nonAdmin = privateKeyToAccount(generatePrivateKey());
    const nonAdminToken = await login(nonAdmin);
    await seedActiveCommitteeMember(conflictedRequesterAndMember.address, admin.address);
    const disputeId = await insertDisputeForRequester(conflictedRequesterAndMember.address);

    const response = await app.inject({
      method: "POST",
      url: `/admin/disputes/${disputeId}/recusals`,
      cookies: { session_token: nonAdminToken },
      payload: { memberAddress: conflictedRequesterAndMember.address, reason: "conflict" },
    });
    expect(response.statusCode).toBe(403);
  });

  // N4 P2 fix (round 1): the recusing address must be a real, currently
  // ACTIVE committee member — never any syntactically-valid address.
  it("rejects recording a recusal for an address that is not a real active committee member", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);
    const disputeId = await insertDisputeForRequester(conflictedRequesterAndMember.address);
    // Deliberately NOT seeded as a committee member.

    const response = await app.inject({
      method: "POST",
      url: `/admin/disputes/${disputeId}/recusals`,
      cookies: { session_token: adminToken },
      payload: { memberAddress: conflictedRequesterAndMember.address, reason: "conflict" },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query(`SELECT * FROM arbitration_recusals`);
    expect(rows).toHaveLength(0);
  });

  // N4 P2 fix (round 1): a syntactically valid but non-existent disputeId
  // must be a clean 404, not an unhandled foreign_key_violation 500.
  it("returns 404 for a syntactically valid but non-existent disputeId", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);
    await seedActiveCommitteeMember(conflictedRequesterAndMember.address, admin.address);

    const response = await app.inject({
      method: "POST",
      url: `/admin/disputes/00000000-0000-0000-0000-000000000000/recusals`,
      cookies: { session_token: adminToken },
      payload: { memberAddress: conflictedRequesterAndMember.address, reason: "conflict" },
    });
    expect(response.statusCode).toBe(404);
  });
});
