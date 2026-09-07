import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";

/**
 * Feature 20 (agent-evaluation-appeal-antifraud), T-2008 —
 * `GET /admin/risk-signals` / `POST /admin/risk-signals/:id/{confirm,
 * dismiss}`'s real end-to-end proof.
 *
 * 用户 2026-09-06 Q-2003 决策 (superseding this file's original "confirm
 * never touches the Agent" scope note): confirming a HOLD_TRIGGERING_SIGNAL_
 * TYPES member (SCORE_MANIPULATION/COLLUSION/FAKE_DELIVERY) now ALSO calls
 * the independent `risk-hold` module's `holdAgent` inside the SAME
 * transaction as the `risk_signals.status → CONFIRMED` write — see the
 * "confirming a HOLD-triggering signal" describe block below. `dismiss`
 * still never touches `agents` at all; neither does confirming a
 * non-HOLD-triggering signal type (DUPLICATE_ACCOUNT, T-2007 DEFERRED,
 * never produced by a real detector, but exercised here directly via SQL to
 * prove the allowlist is real and not "any confirm").
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

runIfOptedIn("antifraud admin routes (integration, T-2008)", () => {
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

  async function insertSignal(
    agentId: string,
    signalType: string,
    status = "DETECTED",
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO risk_signals (signal_type, subject_agent_id, evidence, status)
       VALUES ($1, $2, '{"x":1}', $3) RETURNING id`,
      [signalType, agentId, status],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertSignal: no id returned");
    return id;
  }

  it("lists risk signals, newest first", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const first = await insertSignal(agentId, "SCORE_MANIPULATION");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await insertSignal(agentId, "FAKE_DELIVERY");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "GET",
      url: "/admin/risk-signals",
      cookies: { session_token: adminToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual([second, first]);
  });

  it("filters risk signals by status", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    await insertSignal(agentId, "SCORE_MANIPULATION", "DETECTED");
    const dismissedId = await insertSignal(agentId, "FAKE_DELIVERY", "DISMISSED");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "GET",
      url: "/admin/risk-signals?status=DISMISSED",
      cookies: { session_token: adminToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual([dismissedId]);
  });

  it("N4 P2 fix: paginates the risk-signal queue rather than returning everything unbounded", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const signalIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const agentId = await insertAgent(owner.address.toLowerCase());
      signalIds.push(await insertSignal(agentId, "SCORE_MANIPULATION"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const adminToken = await login(admin);
    const firstPage = await app.inject({
      method: "GET",
      url: "/admin/risk-signals?pageSize=2&page=1",
      cookies: { session_token: adminToken },
    });
    const secondPage = await app.inject({
      method: "GET",
      url: "/admin/risk-signals?pageSize=2&page=2",
      cookies: { session_token: adminToken },
    });

    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.signals).toHaveLength(2);
    expect(firstBody.total).toBe(3);
    expect(firstBody.page).toBe(1);
    expect(firstBody.pageSize).toBe(2);

    const secondBody = secondPage.json();
    expect(secondBody.signals).toHaveLength(1);
    expect(secondBody.total).toBe(3);

    const allIds = [...firstBody.signals, ...secondBody.signals].map((s: { id: string }) => s.id);
    expect(allIds.sort()).toEqual([...signalIds].sort());
  });

  it("rejects a pageSize above the codebase-wide 20-row cap", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    const response = await app.inject({
      method: "GET",
      url: "/admin/risk-signals?pageSize=21",
      cookies: { session_token: adminToken },
    });
    expect(response.statusCode).toBe(400);
  });

  it("a real admin confirm transitions status to CONFIRMED and records reviewed_by, without touching the Agent's status/quality_score", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const signalId = await insertSignal(agentId, "SCORE_MANIPULATION");

    const before = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
      agentId,
    ]);

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/risk-signals/${signalId}/confirm`,
      cookies: { session_token: adminToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("CONFIRMED");

    const { rows } = await pool.query<{ status: string; reviewed_by: string }>(
      `SELECT status, reviewed_by FROM risk_signals WHERE id = $1`,
      [signalId],
    );
    expect(rows[0]?.status).toBe("CONFIRMED");
    expect(rows[0]?.reviewed_by).toBe(admin.address.toLowerCase());

    // Q-2003's orthogonality requirement, checked for real: confirming a
    // risk signal never touches the Agent's baseline-evaluation-adjacent
    // columns (status/quality_score) — the punishment consequence lives
    // entirely in the separate risk_hold_status/risk_hold_audit_logs pair,
    // covered by the "confirming a HOLD-triggering signal" block below.
    const after = await pool.query(`SELECT status, quality_score FROM agents WHERE id = $1`, [
      agentId,
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  describe("confirming a HOLD-triggering signal (Q-2003)", () => {
    it.each(["SCORE_MANIPULATION", "COLLUSION", "FAKE_DELIVERY"])(
      "confirming a %s signal sets risk_hold_status=HELD and writes one HOLD audit row",
      async (signalType) => {
        const admin = privateKeyToAccount(generatePrivateKey());
        const owner = privateKeyToAccount(generatePrivateKey());
        await login(admin);
        await seedAdmin(admin.address);
        await login(owner);
        const agentId = await insertAgent(owner.address.toLowerCase());
        const signalId = await insertSignal(agentId, signalType);
        const adminToken = await login(admin);

        const response = await app.inject({
          method: "POST",
          url: `/admin/risk-signals/${signalId}/confirm`,
          cookies: { session_token: adminToken },
        });
        expect(response.statusCode).toBe(200);

        const { rows: agentRows } = await pool.query<{ risk_hold_status: string }>(
          `SELECT risk_hold_status FROM agents WHERE id = $1`,
          [agentId],
        );
        expect(agentRows[0]?.risk_hold_status).toBe("HELD");

        const { rows: auditRows } = await pool.query<{
          action: string;
          risk_signal_id: string;
          actor_address: string;
        }>(
          `SELECT action, risk_signal_id, actor_address FROM risk_hold_audit_logs WHERE agent_id = $1`,
          [agentId],
        );
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]?.action).toBe("HOLD");
        expect(auditRows[0]?.risk_signal_id).toBe(signalId);
        expect(auditRows[0]?.actor_address).toBe(admin.address.toLowerCase());
      },
    );

    it("dismissing a HOLD-triggering-type signal never sets risk_hold_status", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const signalId = await insertSignal(agentId, "SCORE_MANIPULATION");
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/risk-signals/${signalId}/dismiss`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);

      const { rows: agentRows } = await pool.query<{ risk_hold_status: string }>(
        `SELECT risk_hold_status FROM agents WHERE id = $1`,
        [agentId],
      );
      expect(agentRows[0]?.risk_hold_status).toBe("NONE");
      const { rows: auditRows } = await pool.query(
        `SELECT id FROM risk_hold_audit_logs WHERE agent_id = $1`,
        [agentId],
      );
      expect(auditRows).toHaveLength(0);
    });

    it("confirming a non-HOLD-triggering signal type (DUPLICATE_ACCOUNT, T-2007 DEFERRED) never sets risk_hold_status", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      // DUPLICATE_ACCOUNT is never produced by a real detector (T-2007 is
      // DEFERRED) — inserted directly via SQL to prove the allowlist is a
      // real gate, not "any confirm holds".
      const signalId = await insertSignal(agentId, "DUPLICATE_ACCOUNT");
      const adminToken = await login(admin);

      const response = await app.inject({
        method: "POST",
        url: `/admin/risk-signals/${signalId}/confirm`,
        cookies: { session_token: adminToken },
      });
      expect(response.statusCode).toBe(200);

      const { rows: agentRows } = await pool.query<{ risk_hold_status: string }>(
        `SELECT risk_hold_status FROM agents WHERE id = $1`,
        [agentId],
      );
      expect(agentRows[0]?.risk_hold_status).toBe("NONE");
    });

    it("confirming a second HOLD-triggering signal for an already-HELD Agent still writes a second HOLD audit row", async () => {
      const admin = privateKeyToAccount(generatePrivateKey());
      const owner = privateKeyToAccount(generatePrivateKey());
      await login(admin);
      await seedAdmin(admin.address);
      await login(owner);
      const agentId = await insertAgent(owner.address.toLowerCase());
      const firstSignalId = await insertSignal(agentId, "SCORE_MANIPULATION");
      const secondSignalId = await insertSignal(agentId, "FAKE_DELIVERY");
      const adminToken = await login(admin);

      const first = await app.inject({
        method: "POST",
        url: `/admin/risk-signals/${firstSignalId}/confirm`,
        cookies: { session_token: adminToken },
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: "POST",
        url: `/admin/risk-signals/${secondSignalId}/confirm`,
        cookies: { session_token: adminToken },
      });
      expect(second.statusCode).toBe(200);

      const { rows: agentRows } = await pool.query<{ risk_hold_status: string }>(
        `SELECT risk_hold_status FROM agents WHERE id = $1`,
        [agentId],
      );
      expect(agentRows[0]?.risk_hold_status).toBe("HELD");
      const { rows: auditRows } = await pool.query<{ risk_signal_id: string }>(
        `SELECT risk_signal_id FROM risk_hold_audit_logs WHERE agent_id = $1 ORDER BY occurred_at ASC`,
        [agentId],
      );
      expect(auditRows.map((r) => r.risk_signal_id)).toEqual([firstSignalId, secondSignalId]);
    });
  });

  it("a real admin dismiss transitions status to DISMISSED", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const signalId = await insertSignal(agentId, "SCORE_MANIPULATION");

    const adminToken = await login(admin);
    const response = await app.inject({
      method: "POST",
      url: `/admin/risk-signals/${signalId}/dismiss`,
      cookies: { session_token: adminToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("DISMISSED");
    const { rows } = await pool.query(`SELECT status FROM risk_signals WHERE id = $1`, [signalId]);
    expect(rows[0]?.status).toBe("DISMISSED");
  });

  it("rejects resolving an already-resolved signal (409)", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const signalId = await insertSignal(agentId, "SCORE_MANIPULATION");
    const adminToken = await login(admin);

    const first = await app.inject({
      method: "POST",
      url: `/admin/risk-signals/${signalId}/confirm`,
      cookies: { session_token: adminToken },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/admin/risk-signals/${signalId}/dismiss`,
      cookies: { session_token: adminToken },
    });
    expect(second.statusCode).toBe(409);
  });

  it("N4-lesson race: two truly concurrent resolutions of the same signal never both succeed", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    await login(owner);
    const agentId = await insertAgent(owner.address.toLowerCase());
    const signalId = await insertSignal(agentId, "SCORE_MANIPULATION");
    const adminToken = await login(admin);

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/admin/risk-signals/${signalId}/confirm`,
        cookies: { session_token: adminToken },
      }),
      app.inject({
        method: "POST",
        url: `/admin/risk-signals/${signalId}/dismiss`,
        cookies: { session_token: adminToken },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);
  });

  it("returns 404 for resolving a non-existent signal", async () => {
    const admin = privateKeyToAccount(generatePrivateKey());
    await login(admin);
    await seedAdmin(admin.address);
    const adminToken = await login(admin);

    const response = await app.inject({
      method: "POST",
      url: `/admin/risk-signals/00000000-0000-0000-0000-000000000000/confirm`,
      cookies: { session_token: adminToken },
    });
    expect(response.statusCode).toBe(404);
  });

  it("N4 P2 fix: a 404/409 resolve never needs a SECOND pool connection while the first is still checked out", async () => {
    // A dedicated max:1 pool makes the fixed bug observable: before the
    // fix, the 404 path queried `pool` (not the already-checked-out
    // `dbClient`) for a follow-up read, which on a max:1 pool would hang
    // forever waiting for a connection that dbClient itself was holding.
    const singleConnectionPool = new Pool({
      connectionString: requireTestDatabaseUrl(),
      max: 1,
    });
    const singleConnectionApp = buildApp({ pool: singleConnectionPool });
    try {
      const admin = privateKeyToAccount(generatePrivateKey());
      const adminNonceResponse = await singleConnectionApp.inject({
        method: "POST",
        url: "/auth/nonce",
        payload: { address: admin.address },
      });
      const nonceBody = adminNonceResponse.json();
      const message = buildSignInMessage({
        domain: "localhost",
        address: admin.address,
        nonce: nonceBody.nonce,
        issuedAt: new Date(nonceBody.issuedAt),
        expiresAt: new Date(nonceBody.expiresAt),
      });
      const signature = await admin.signMessage({ message });
      const verifyResponse = await singleConnectionApp.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { address: admin.address, signature, nonce: nonceBody.nonce },
      });
      const setCookie = verifyResponse.headers["set-cookie"];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const adminToken = /session_token=([^;]+)/.exec(String(header))?.[1] ?? "";
      await singleConnectionPool.query(
        `INSERT INTO admin_roles (address, granted_by) VALUES ($1, $1)`,
        [admin.address.toLowerCase()],
      );

      const response = await Promise.race([
        singleConnectionApp.inject({
          method: "POST",
          url: `/admin/risk-signals/00000000-0000-0000-0000-000000000000/confirm`,
          cookies: { session_token: adminToken },
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("resolve appears to have deadlocked the pool")), 5_000),
        ),
      ]);
      expect(response.statusCode).toBe(404);
    } finally {
      await singleConnectionApp.close();
      await singleConnectionPool.end();
    }
  }, 15_000);

  it("rejects a non-admin caller (403)", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const strangerToken = await login(stranger);

    const response = await app.inject({
      method: "GET",
      url: "/admin/risk-signals",
      cookies: { session_token: strangerToken },
    });
    expect(response.statusCode).toBe(403);
  });
});
