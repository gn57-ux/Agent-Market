import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { DASHBOARD_METRICS_WINDOW_DAYS } from "./dashboard.js";

/**
 * F-1609/F-1610 (Feature 16, T-1608b) — real end-to-end coverage for `GET
 * /admin/dashboard`. Real HTTP (`app.inject`), real Postgres, real SIWE
 * signatures.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const TOKEN_ADDRESS = "0x9983fefc63f0cd0e873a0000c6d07ef7b77e90d8";

runIfOptedIn("GET /admin/dashboard (integration, T-1608b)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const requester = privateKeyToAccount(generatePrivateKey());
  const admin = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agent_review_audit_logs, agents, sessions, auth_nonces, users, consumed_privy_tokens, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM admin_role_audit_logs");
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

  async function seedAdmin(): Promise<void> {
    const address = admin.address.toLowerCase();
    await pool.query(`INSERT INTO admin_roles (address, granted_by) VALUES ($1, $1)`, [address]);
  }

  async function ensureUser(address: string): Promise<void> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      address.toLowerCase(),
    ]);
  }

  async function insertAgent(reviewStatus: string, status: string = "ACTIVE"): Promise<string> {
    await ensureUser(requester.address);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address, pricing_type, review_status, status)
       VALUES ($1, 'Agent', 'desc', 'writing', $1, 'PER_TASK', $2, $3)
       RETURNING id`,
      [requester.address.toLowerCase(), reviewStatus, status],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertTask(status: string): Promise<string> {
    await ensureUser(requester.address);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '100', $2, '2030-01-01T00:00:00Z', $3, 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase(), TOKEN_ADDRESS, status],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  async function recordTransition(
    taskId: string,
    toStatus: string,
    occurredAt: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
       VALUES ($1, 'OPEN', $2, $3, $4)`,
      [taskId, toStatus, requester.address.toLowerCase(), occurredAt],
    );
  }

  async function insertDispute(taskId: string, status: "OPEN" | "RESOLVED"): Promise<void> {
    await pool.query(
      status === "OPEN"
        ? `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash, status)
           VALUES ($1, $2, 'reason', 'summary', $3, 'OPEN')`
        : `INSERT INTO disputes
             (task_id, requester_address, reason, evidence_summary, evidence_hash, status, resolution, resolved_by, resolved_at)
           VALUES ($1, $2, 'reason', 'summary', $3, 'RESOLVED', 'SUPPORT_AGENT', $2, now())`,
      [taskId, requester.address.toLowerCase(), `0x${taskId.replace(/-/g, "").padEnd(64, "0")}`],
    );
  }

  it("rejects a non-admin session with 403", async () => {
    const token = await login(requester);
    const response = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      cookies: { session_token: token },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects no session with 401", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/dashboard" });
    expect(response.statusCode).toBe(401);
  });

  it("returns all expected fields with correct counts for an admin", async () => {
    // Published tasks: OPEN and beyond count, DRAFT/AWAITING_FUNDING don't.
    await insertTask("OPEN");
    await insertTask("ACCEPTED");
    await insertTask("DRAFT");
    await insertTask("AWAITING_FUNDING");

    // Published (ACTIVE) vs pending-review Agents.
    await insertAgent("ACTIVE");
    await insertAgent("ACTIVE");
    await insertAgent("PENDING_REVIEW");
    await insertAgent("REJECTED");
    // Codex review (T-1608b round 1 P2): approved but owner-deactivated —
    // status/reviewStatus are orthogonal (design.md 决策 3), NOT actually
    // market-visible, must not count as published.
    await insertAgent("ACTIVE", "INACTIVE");

    // Open vs resolved disputes.
    const disputedTask = await insertTask("DISPUTED");
    await insertDispute(disputedTask, "OPEN");
    const resolvedTask = await insertTask("RELEASED");
    await insertDispute(resolvedTask, "RESOLVED");

    await seedAdmin();
    const adminToken = await login(admin);
    const response = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      cookies: { session_token: adminToken },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.publishedTaskCount).toBe(4); // OPEN, ACCEPTED, DISPUTED, RELEASED (DRAFT/AWAITING_FUNDING excluded)
    expect(body.publishedAgentCount).toBe(2);
    expect(body.reviewQueue.total).toBe(1);
    expect(body.reviewQueue.items).toHaveLength(1);
    expect(body.reviewQueue.items[0].reviewStatus).toBe("PENDING_REVIEW");
    expect(body.openDisputes).toHaveLength(1);
    expect(body.openDisputes[0].taskId).toBe(disputedTask);
    expect(body.platformFunds).toEqual(
      expect.objectContaining({
        totalEscrowed: expect.any(String),
        totalReleased: expect.any(String),
        totalRefunded: expect.any(String),
        activeLocked: expect.any(String),
      }),
    );
    expect(body.metrics.windowDays).toBe(DASHBOARD_METRICS_WINDOW_DAYS);
    expect(body.metrics.pendingReviewCount).toBe(1);
  });

  it("windowed metrics (tasksPublishedInWindow/tasksCompletedInWindow/disputesInWindow) exclude events outside the window, and count exactly the events inside it", async () => {
    const now = new Date();
    const insideWindow = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const outsideWindow = new Date(
      now.getTime() - (DASHBOARD_METRICS_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000,
    ).toISOString(); // well outside the window

    const recentOpenTask = await insertTask("OPEN");
    await recordTransition(recentOpenTask, "OPEN", insideWindow);
    const staleOpenTask = await insertTask("OPEN");
    await recordTransition(staleOpenTask, "OPEN", outsideWindow);

    const recentReleasedTask = await insertTask("RELEASED");
    await recordTransition(recentReleasedTask, "RELEASED", insideWindow);
    const staleReleasedTask = await insertTask("RELEASED");
    await recordTransition(staleReleasedTask, "RELEASED", outsideWindow);

    const recentDisputeTask = await insertTask("DISPUTED");
    await pool.query(
      `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash, status, created_at)
       VALUES ($1, $2, 'reason', 'summary', $3, 'OPEN', $4)`,
      [
        recentDisputeTask,
        requester.address.toLowerCase(),
        `0x${recentDisputeTask.replace(/-/g, "").padEnd(64, "0")}`,
        insideWindow,
      ],
    );
    const staleDisputeTask = await insertTask("DISPUTED");
    await pool.query(
      `INSERT INTO disputes
         (task_id, requester_address, reason, evidence_summary, evidence_hash, status, resolution, resolved_by, resolved_at, created_at)
       VALUES ($1, $2, 'reason', 'summary', $3, 'RESOLVED', 'SUPPORT_AGENT', $2, $4, $4)`,
      [
        staleDisputeTask,
        requester.address.toLowerCase(),
        `0x${staleDisputeTask.replace(/-/g, "").padEnd(64, "0")}`,
        outsideWindow,
      ],
    );

    await seedAdmin();
    const adminToken = await login(admin);
    const response = await app.inject({
      method: "GET",
      url: "/admin/dashboard",
      cookies: { session_token: adminToken },
    });
    expect(response.statusCode).toBe(200);
    const { metrics } = response.json();
    expect(metrics.tasksPublishedInWindow).toBe(1);
    expect(metrics.tasksCompletedInWindow).toBe(1);
    expect(metrics.disputesInWindow).toBe(1);
  });
});
