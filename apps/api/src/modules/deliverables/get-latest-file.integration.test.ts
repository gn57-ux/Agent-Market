import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { saveFile } from "./storage.local.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-907's dedicated verification of
// `GET /tasks/:taskId/deliverables/latest/file`: F-908's access
// restriction (requester/accepted-Agent only, everyone else 403), the
// real file-content response for LOCAL_FILE, and the 302 redirect for
// URL-type deliverables.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

runIfOptedIn("GET /tasks/:taskId/deliverables/latest/file (integration, T-907)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  let previousStorageDirEnv: string | undefined;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

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

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "deliverables-file-test-"));
    previousStorageDirEnv = process.env.DELIVERABLE_STORAGE_DIR;
    process.env.DELIVERABLE_STORAGE_DIR = storageDir;
  });

  afterEach(async () => {
    if (previousStorageDirEnv === undefined) {
      delete process.env.DELIVERABLE_STORAGE_DIR;
    } else {
      process.env.DELIVERABLE_STORAGE_DIR = previousStorageDirEnv;
    }
    await rm(storageDir, { recursive: true, force: true });
    await pool.query("DELETE FROM deliverables");
    await pool.query("DELETE FROM tasks");
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

  async function insertTask(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_address, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', 'ACCEPTED', $3, 'AUTOMATION')
       RETURNING id`,
      [
        requester.address.toLowerCase(),
        "0x1111111111111111111111111111111111111111",
        agent.address.toLowerCase(),
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  async function insertUrlDeliverable(taskId: string, resultUrl: string): Promise<void> {
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash)
       VALUES ($1, $2, 'URL', $3, $4)`,
      [taskId, agent.address.toLowerCase(), resultUrl, `0x${"a".repeat(64)}`],
    );
  }

  async function insertLocalFileDeliverable(
    taskId: string,
    content: Buffer,
    mimeType: string,
  ): Promise<void> {
    const saved = await saveFile({ buffer: content, mimeType });
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, file_path, mime_type, size_bytes, result_hash)
       VALUES ($1, $2, 'LOCAL_FILE', $3, $4, $5, $6)`,
      [
        taskId,
        agent.address.toLowerCase(),
        saved.filePath,
        mimeType,
        saved.sizeBytes,
        `0x${"b".repeat(64)}`,
      ],
    );
  }

  it("returns 401 for an unauthenticated request", async () => {
    const taskId = await insertTask();
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 403 for a signed-in stranger (neither requester nor accepted Agent)", async () => {
    const taskId = await insertTask();
    await insertUrlDeliverable(taskId, "https://example.com/result.pdf");
    const token = await login(stranger);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(403);
  });

  it("allows the requester", async () => {
    const taskId = await insertTask();
    await insertUrlDeliverable(taskId, "https://example.com/result.pdf");
    const token = await login(requester);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(302);
  });

  it("allows the accepted Agent", async () => {
    const taskId = await insertTask();
    await insertUrlDeliverable(taskId, "https://example.com/result.pdf");
    const token = await login(agent);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(302);
  });

  it("returns 404 when the task exists but has no deliverable yet", async () => {
    const taskId = await insertTask();
    const token = await login(requester);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(404);
  });

  it("302-redirects an authorized caller to the original resultUrl for a URL-type deliverable", async () => {
    const taskId = await insertTask();
    await insertUrlDeliverable(taskId, "https://example.com/result.pdf");
    const token = await login(requester);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://example.com/result.pdf");
  });

  it("streams the real file content and mime type for a LOCAL_FILE-type deliverable", async () => {
    const taskId = await insertTask();
    const content = Buffer.from("the actual deliverable bytes");
    await insertLocalFileDeliverable(taskId, content, "text/plain");
    const token = await login(requester);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest/file`,
      cookies: { session_token: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.rawPayload.equals(content)).toBe(true);
  });
});
