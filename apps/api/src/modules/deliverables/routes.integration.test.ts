import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";
import { computeFileDigest, computeUrlDigest } from "./digest.js";
import { MAX_FILE_SIZE_BYTES } from "./storage.local.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-902's dedicated verification of
// `POST /tasks/:taskId/deliverables` (AC-901): both the file-upload path
// and the resultUrl path, and that the returned resultHash matches what
// digest.ts independently computes (proving the route calls the same,
// single implementation rather than an inline duplicate).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

function buildMultipartPayload(params: {
  fieldName: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}): { payload: Buffer; contentType: string } {
  const boundary = "----t902testboundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(
      `Content-Disposition: form-data; name="${params.fieldName}"; filename="${params.filename}"\r\n`,
    ),
    Buffer.from(`Content-Type: ${params.mimeType}\r\n\r\n`),
    params.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

runIfOptedIn("POST /tasks/:taskId/deliverables (integration, T-902)", () => {
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

  async function insertTask(
    overrides: {
      status?: string;
      acceptedAgentAddress?: string | null;
      deliveryDeadline?: string;
    } = {},
  ): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
    ]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_address, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, $3, $4, $5, 'AUTOMATION')
       RETURNING id`,
      [
        requester.address.toLowerCase(),
        "0x1111111111111111111111111111111111111111",
        overrides.deliveryDeadline ?? "2099-01-01T00:00:00Z",
        overrides.status ?? "ACCEPTED",
        overrides.acceptedAgentAddress === undefined
          ? agent.address.toLowerCase()
          : overrides.acceptedAgentAddress,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  it("accepts a file upload, persists it, and returns a resultHash matching computeFileDigest (AC-901)", async () => {
    const taskId = await insertTask();
    const token = await login(agent);
    const content = Buffer.from("real deliverable content");
    const { payload, contentType } = buildMultipartPayload({
      fieldName: "file",
      filename: "result.txt",
      mimeType: "text/plain",
      content,
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/deliverables`,
      cookies: { session_token: token },
      headers: { "content-type": contentType },
      payload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { deliverableId: string; resultHash: string; storedAt: string };
    expect(body.resultHash).toBe(computeFileDigest(content));
    expect(body.deliverableId).toBeTruthy();
    expect(body.storedAt).toBeTruthy();

    const { rows } = await pool.query(`SELECT * FROM deliverables WHERE id = $1`, [
      body.deliverableId,
    ]);
    expect(rows[0]?.storage_type).toBe("LOCAL_FILE");
    expect(rows[0]?.agent_address).toBe(agent.address.toLowerCase());
  });

  it("accepts a resultUrl submission and returns a resultHash matching computeUrlDigest (AC-901)", async () => {
    const taskId = await insertTask();
    const token = await login(agent);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/deliverables`,
      cookies: { session_token: token },
      payload: { resultUrl: "https://example.com/result.pdf" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { deliverableId: string; resultHash: string };
    expect(body.resultHash).toBe(computeUrlDigest("https://example.com/result.pdf"));

    const { rows } = await pool.query(`SELECT * FROM deliverables WHERE id = $1`, [
      body.deliverableId,
    ]);
    expect(rows[0]?.storage_type).toBe("URL");
    expect(rows[0]?.result_url).toBe("https://example.com/result.pdf");
  });

  it("rejects a non-https resultUrl with 400 (F-907)", async () => {
    const taskId = await insertTask();
    const token = await login(agent);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/deliverables`,
      cookies: { session_token: token },
      payload: { resultUrl: "http://example.com/result.pdf" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a disallowed file mime type with 400 (AC-904)", async () => {
    const taskId = await insertTask();
    const token = await login(agent);
    const { payload, contentType } = buildMultipartPayload({
      fieldName: "file",
      filename: "virus.exe",
      mimeType: "application/x-msdownload",
      content: Buffer.from("x"),
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/deliverables`,
      cookies: { session_token: token },
      headers: { "content-type": contentType },
      payload,
    });

    expect(response.statusCode).toBe(400);
    const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(0);
  });

  // N4 round 1 P2 (Codex): `@fastify/multipart` v8's `toBuffer()` throws
  // (`FST_REQ_FILE_TOO_LARGE`) partway through reading an oversized upload
  // rather than returning normally with `truncated` set — without a catch
  // around that call, this escaped as an unhandled 500 instead of the
  // intended 400.
  it("rejects a file exceeding MAX_FILE_SIZE_BYTES with 400, not a 500 (AC-904)", async () => {
    const taskId = await insertTask();
    const token = await login(agent);
    const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
    const { payload, contentType } = buildMultipartPayload({
      fieldName: "file",
      filename: "huge.pdf",
      mimeType: "application/pdf",
      content: oversized,
    });

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/deliverables`,
      cookies: { session_token: token },
      headers: { "content-type": contentType },
      payload,
    });

    expect(response.statusCode).toBe(400);
    const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(0);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const taskId = await insertTask();
    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/deliverables`,
      payload: { resultUrl: "https://example.com/result.pdf" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for a nonexistent task", async () => {
    const token = await login(agent);
    const response = await app.inject({
      method: "POST",
      url: `/tasks/00000000-0000-4000-8000-000000000000/deliverables`,
      cookies: { session_token: token },
      payload: { resultUrl: "https://example.com/result.pdf" },
    });
    expect(response.statusCode).toBe(404);
  });

  // F-906 (N4 round 1 P1 fix, Codex): the route must actually enforce
  // "only the accepted Agent, only while ACCEPTED, only before the
  // deadline" rather than accepting a submission from any signed-in user.
  describe("F-906 submission preconditions", () => {
    it("returns 409 when the caller is not the task's accepted Agent", async () => {
      const stranger = privateKeyToAccount(generatePrivateKey());
      const taskId = await insertTask();
      const token = await login(stranger);

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        payload: { resultUrl: "https://example.com/result.pdf" },
      });

      expect(response.statusCode).toBe(409);
      const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
      expect(rows).toHaveLength(0);
    });

    it("returns 409 when the task has no accepted Agent at all", async () => {
      const taskId = await insertTask({ acceptedAgentAddress: null });
      const token = await login(agent);

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        payload: { resultUrl: "https://example.com/result.pdf" },
      });

      expect(response.statusCode).toBe(409);
    });

    it("returns 409 when the task is not in ACCEPTED status (e.g. still OPEN)", async () => {
      const taskId = await insertTask({ status: "OPEN", acceptedAgentAddress: null });
      const token = await login(agent);

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        payload: { resultUrl: "https://example.com/result.pdf" },
      });

      expect(response.statusCode).toBe(409);
    });

    it("returns 409 when the delivery deadline has already passed", async () => {
      const taskId = await insertTask({ deliveryDeadline: "2000-01-01T00:00:00Z" });
      const token = await login(agent);

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        payload: { resultUrl: "https://example.com/result.pdf" },
      });

      expect(response.statusCode).toBe(409);
    });
  });
});
