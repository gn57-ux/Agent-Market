import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// Human review follow-up (T-902, kept in the original lineage): round 1's
// P2 fix ("clean up an orphaned file when the DB write fails") was only
// unit-tested against `deleteFile` in isolation — never against the real
// route path where a real `saveFile` writes real bytes to a real
// `DELIVERABLE_STORAGE_DIR` and the SUBSEQUENT persistence step fails.
// This suite closes that gap end to end: real HTTP request → real
// multipart parsing → real file written to disk → a controlled
// persistence failure/rejection → assert the response, the filesystem,
// and the database all agree there is no orphan.
//
// `insertDeliverableIfSubmissionAllowed` is the one thing mocked, so the
// exact failure mode (locked-recheck rejection vs. a genuine DB error) is
// deterministic rather than raced — everything else (`saveFile`,
// `checkSubmissionAllowed`, `getTaskById`, the real Postgres-backed app)
// stays real. `deleteFile` is ALSO wrapped (default: delegates to the real
// implementation) so one dedicated test can make cleanup itself fail and
// verify that does not change the response the client already received.
const insertDeliverableIfSubmissionAllowedMock = vi.fn();
vi.mock("./repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repository.js")>();
  return {
    ...actual,
    insertDeliverableIfSubmissionAllowed: (
      ...args: Parameters<typeof actual.insertDeliverableIfSubmissionAllowed>
    ) => insertDeliverableIfSubmissionAllowedMock(...args),
  };
});

const deleteFileMock = vi.fn();
vi.mock("./storage.local.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage.local.js")>();
  deleteFileMock.mockImplementation((filePath: string) => actual.deleteFile(filePath));
  return {
    ...actual,
    deleteFile: (filePath: string) => deleteFileMock(filePath),
  };
});

const { buildApp } = await import("../../app.js");
const { runMigrations } = await import("../../db/migrate.js");
const { requireTestDatabaseUrl } = await import("../../db/test-support.js");
const { buildSignInMessage } = await import("../auth/signInMessage.js");
const { DeliverableSubmissionNotAllowedError } = await import("./repository.js");
const { readFile: storageReadFile } = await import("./storage.local.js");

const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE";

function buildMultipartPayload(content: Buffer): { payload: Buffer; contentType: string } {
  const boundary = "----t902cleanuptestboundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="result.txt"\r\n`),
    Buffer.from(`Content-Type: text/plain\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

runIfOptedIn(
  "POST /tasks/:taskId/deliverables — orphaned-file cleanup (integration, T-902 human review)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    let storageDir: string;
    let previousStorageDirEnv: string | undefined;
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

    beforeEach(async () => {
      storageDir = await mkdtemp(path.join(tmpdir(), "deliverables-cleanup-test-"));
      previousStorageDirEnv = process.env.DELIVERABLE_STORAGE_DIR;
      process.env.DELIVERABLE_STORAGE_DIR = storageDir;
      insertDeliverableIfSubmissionAllowedMock.mockReset();
      deleteFileMock.mockClear();
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
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        requester.address.toLowerCase(),
      ]);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_address)
         VALUES ($1, 'writing', 'Task', 'desc', 1000, $2, '2099-01-01T00:00:00Z', 'ACCEPTED', $3)
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

    it("removes the real on-disk file and returns 409 (not masked) when the locked F-906 recheck rejects", async () => {
      insertDeliverableIfSubmissionAllowedMock.mockRejectedValueOnce(
        new DeliverableSubmissionNotAllowedError("任务当前状态不允许提交成果。"),
      );
      const taskId = await insertTask();
      const token = await login(agent);
      const { payload, contentType } = buildMultipartPayload(Buffer.from("real bytes on disk"));

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        headers: { "content-type": contentType },
        payload,
      });

      // Response semantics preserved exactly — 409, not 500.
      expect(response.statusCode).toBe(409);

      // The real file `saveFile` wrote must be gone (no orphan). Fastify
      // sends the response as soon as `reply.send()` is called inside
      // `persistOrReject` — the handler's own post-send cleanup work
      // (`cleanupOrphanedFile`) is still genuinely awaited internally by
      // the route handler, but `app.inject()` itself resolves once the
      // response is flushed, not once the whole handler function returns.
      // Awaiting the mock's own recorded return value (the real promise
      // `cleanupOrphanedFile` is awaiting) is what actually waits for
      // cleanup to finish before asserting the file is gone — a bare
      // "was it called" check would otherwise race a cleanup that is
      // still in flight.
      expect(deleteFileMock).toHaveBeenCalledTimes(1);
      const savedFilePath = deleteFileMock.mock.calls[0]?.[0] as string;
      await deleteFileMock.mock.results[0]?.value;
      await expect(storageReadFile(savedFilePath)).rejects.toThrow();

      // No deliverable row was ever persisted.
      const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
      expect(rows).toHaveLength(0);
    });

    it("removes the real on-disk file and returns 500 (not masked) when persistence fails for a genuine reason", async () => {
      insertDeliverableIfSubmissionAllowedMock.mockRejectedValueOnce(
        new Error("simulated database connection failure"),
      );
      const taskId = await insertTask();
      const token = await login(agent);
      const { payload, contentType } = buildMultipartPayload(Buffer.from("real bytes on disk 2"));

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        headers: { "content-type": contentType },
        payload,
      });

      expect(response.statusCode).toBe(500);

      // See the previous test's comment: wait for the recorded cleanup
      // promise itself, not just for the mock to have been called.
      expect(deleteFileMock).toHaveBeenCalledTimes(1);
      const savedFilePath = deleteFileMock.mock.calls[0]?.[0] as string;
      await deleteFileMock.mock.results[0]?.value;
      await expect(storageReadFile(savedFilePath)).rejects.toThrow();

      const { rows } = await pool.query(`SELECT * FROM deliverables WHERE task_id = $1`, [taskId]);
      expect(rows).toHaveLength(0);
    });

    it("keeps the original 409 when cleanup itself fails (a broken deleteFile must not change the response)", async () => {
      insertDeliverableIfSubmissionAllowedMock.mockRejectedValueOnce(
        new DeliverableSubmissionNotAllowedError("只有本任务的接单 Agent 才能提交成果。"),
      );
      deleteFileMock.mockRejectedValueOnce(new Error("simulated disk error during cleanup"));
      const taskId = await insertTask();
      const token = await login(agent);
      const { payload, contentType } = buildMultipartPayload(
        Buffer.from("orphan if cleanup fails"),
      );

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        headers: { "content-type": contentType },
        payload,
      });

      // The cleanup failure (mocked above) must NOT surface as this
      // response — the 409 the persistence rejection produced is what the
      // client must see.
      expect(response.statusCode).toBe(409);
    });

    it("keeps the original 500 when cleanup itself fails (a broken deleteFile must not mask the real DB error)", async () => {
      insertDeliverableIfSubmissionAllowedMock.mockRejectedValueOnce(
        new Error("simulated database connection failure 2"),
      );
      deleteFileMock.mockRejectedValueOnce(new Error("simulated disk error during cleanup 2"));
      const taskId = await insertTask();
      const token = await login(agent);
      const { payload, contentType } = buildMultipartPayload(
        Buffer.from("orphan if cleanup fails 2"),
      );

      const response = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: token },
        headers: { "content-type": contentType },
        payload,
      });

      expect(response.statusCode).toBe(500);
    });
  },
);
