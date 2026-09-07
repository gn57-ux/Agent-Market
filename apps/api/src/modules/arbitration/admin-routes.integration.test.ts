import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 21 (arbitration-committee), T-2106 (F-2104; requirements.md
 * AC-2106) — the real end-to-end proof: only a real admin (via Feature
 * 16's real `app.requireAdmin`) can add/remove committee members, every
 * change is queryable, and re-adding a removed member is allowed (the
 * `REMOVED` row's own real history stays intact).
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

runIfOptedIn("arbitration-committee admin routes (integration, T-2106)", () => {
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
    await pool.query("DELETE FROM arbitration_committee_members");
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

  const admin = privateKeyToAccount(generatePrivateKey());
  const nonAdmin = privateKeyToAccount(generatePrivateKey());
  const memberCandidate = privateKeyToAccount(generatePrivateKey());
  const replacementCandidate = privateKeyToAccount(generatePrivateKey());

  it("a real admin can add a member, list it, then remove it — every change queryable", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    const addResponse = await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    expect(addResponse.statusCode).toBe(201);
    const added = addResponse.json() as { member: { status: string; memberAddress: string } };
    expect(added.member.status).toBe("ACTIVE");
    expect(added.member.memberAddress).toBe(memberCandidate.address.toLowerCase());

    const listAfterAdd = await app.inject({
      method: "GET",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
    });
    expect(listAfterAdd.statusCode).toBe(200);
    expect((listAfterAdd.json() as { members: unknown[] }).members).toHaveLength(1);

    const removeResponse = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/remove`,
      cookies: { session_token: adminToken },
    });
    expect(removeResponse.statusCode).toBe(200);

    const listAfterRemove = await app.inject({
      method: "GET",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
    });
    const members = (listAfterRemove.json() as { members: { status: string }[] }).members;
    expect(members).toHaveLength(1);
    expect(members[0]?.status).toBe("REMOVED");
  });

  it("re-adding a previously-removed member succeeds and keeps both real rows (full history preserved)", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/remove`,
      cookies: { session_token: adminToken },
    });
    const secondAdd = await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    expect(secondAdd.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
    });
    expect((list.json() as { members: unknown[] }).members).toHaveLength(2);
  });

  it("rejects adding the same address twice while it is still ACTIVE", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("rejects removing an address that is not currently an ACTIVE member", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    const response = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/remove`,
      cookies: { session_token: adminToken },
    });
    expect(response.statusCode).toBe(409);
  });

  it("AC-2106: a non-admin address cannot add or remove committee members", async () => {
    await seedAdmin(admin.address);
    const nonAdminToken = await login(nonAdmin);

    const addResponse = await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: nonAdminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    expect(addResponse.statusCode).toBe(403);

    const removeResponse = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/remove`,
      cookies: { session_token: nonAdminToken },
    });
    expect(removeResponse.statusCode).toBe(403);

    const { rows } = await pool.query(`SELECT * FROM arbitration_committee_members`);
    expect(rows).toHaveLength(0);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      payload: { memberAddress: memberCandidate.address },
    });
    expect(response.statusCode).toBe(401);
  });

  // N4 P2 fix (round 2): the zero address can never be a real Safe owner
  // — rejected at the request boundary (400), never reaching the DB.
  it("rejects adding the zero address as a committee member", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    const response = await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: "0x0000000000000000000000000000000000000000" },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query(`SELECT * FROM arbitration_committee_members`);
    expect(rows).toHaveLength(0);
  });

  it("rejects replacing a member with the zero address", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    const response = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/replace`,
      cookies: { session_token: adminToken },
      payload: { newMemberAddress: "0x0000000000000000000000000000000000000000" },
    });
    expect(response.statusCode).toBe(400);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM arbitration_committee_members WHERE member_address = $1`,
      [memberCandidate.address.toLowerCase()],
    );
    expect(rows[0]?.status).toBe("ACTIVE");
  });

  // N4 P1 fix (round 1): "替换" must be one atomic operation, not two
  // separate remove+add calls a client could issue.
  it("replace: real admin atomically removes the old member and adds the new one in a single real operation", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });

    const replaceResponse = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/replace`,
      cookies: { session_token: adminToken },
      payload: { newMemberAddress: replacementCandidate.address },
    });
    expect(replaceResponse.statusCode).toBe(200);
    const replaced = replaceResponse.json() as {
      member: { status: string; memberAddress: string };
    };
    expect(replaced.member.status).toBe("ACTIVE");
    expect(replaced.member.memberAddress).toBe(replacementCandidate.address.toLowerCase());

    const { rows } = await pool.query<{ member_address: string; status: string }>(
      `SELECT member_address, status FROM arbitration_committee_members ORDER BY added_at`,
    );
    expect(rows).toEqual([
      { member_address: memberCandidate.address.toLowerCase(), status: "REMOVED" },
      { member_address: replacementCandidate.address.toLowerCase(), status: "ACTIVE" },
    ]);
  });

  it("replace: rolls back entirely (old member stays ACTIVE) when the replacement address is already an active member", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: memberCandidate.address },
    });
    await app.inject({
      method: "POST",
      url: "/admin/arbitration-committee/members",
      cookies: { session_token: adminToken },
      payload: { memberAddress: replacementCandidate.address },
    });

    const replaceResponse = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/replace`,
      cookies: { session_token: adminToken },
      payload: { newMemberAddress: replacementCandidate.address },
    });
    expect(replaceResponse.statusCode).toBe(409);

    // Real rollback proof: the old member is STILL active — the failed
    // "add" half never left the "remove" half committed on its own.
    const { rows } = await pool.query<{ member_address: string; status: string }>(
      `SELECT member_address, status FROM arbitration_committee_members ORDER BY added_at`,
    );
    expect(rows).toEqual([
      { member_address: memberCandidate.address.toLowerCase(), status: "ACTIVE" },
      { member_address: replacementCandidate.address.toLowerCase(), status: "ACTIVE" },
    ]);
  });

  it("replace: rejects when the address being replaced is not currently an ACTIVE member", async () => {
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    const replaceResponse = await app.inject({
      method: "POST",
      url: `/admin/arbitration-committee/members/${memberCandidate.address}/replace`,
      cookies: { session_token: adminToken },
      payload: { newMemberAddress: replacementCandidate.address },
    });
    expect(replaceResponse.statusCode).toBe(409);

    const { rows } = await pool.query(`SELECT * FROM arbitration_committee_members`);
    expect(rows).toHaveLength(0);
  });
});
