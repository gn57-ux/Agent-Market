import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-904's dedicated verification of
// `GET /tasks/:taskId/deliverables/latest`: metadata-only, public (no
// session required), returns the discriminated fileMeta/resultUrl shape,
// and passes through tasks.submitted_at/review_deadline verbatim
// (currently always NULL — T-905's ResultSubmitted event-sync handler is
// what writes them, not this route).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE";

runIfOptedIn("GET /tasks/:taskId/deliverables/latest (integration, T-904)", () => {
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
    await pool.query("DELETE FROM users");
  });

  async function insertTask(): Promise<string> {
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
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

  async function insertDeliverable(
    taskId: string,
    overrides: Partial<{
      storageType: "LOCAL_FILE" | "URL";
      filePath: string | null;
      resultUrl: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      resultHash: string;
    }> = {},
  ): Promise<void> {
    const storageType = overrides.storageType ?? "URL";
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, file_path, result_url, mime_type, size_bytes, result_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        taskId,
        agent.address.toLowerCase(),
        storageType,
        overrides.filePath ?? null,
        storageType === "URL" ? (overrides.resultUrl ?? "https://example.com/result.pdf") : null,
        overrides.mimeType ?? null,
        overrides.sizeBytes ?? null,
        overrides.resultHash ?? `0x${"a".repeat(64)}`,
      ],
    );
  }

  it("returns 404 for a nonexistent task", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/tasks/00000000-0000-4000-8000-000000000000/deliverables/latest`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when the task exists but has no deliverable yet", async () => {
    const taskId = await insertTask();
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not require a session — metadata-only reads are public", async () => {
    const taskId = await insertTask();
    await insertDeliverable(taskId);
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
      // Deliberately no cookies at all.
    });
    expect(response.statusCode).toBe(200);
  });

  it("returns resultUrl (not fileMeta) for a URL-type deliverable", async () => {
    const taskId = await insertTask();
    await insertDeliverable(taskId, {
      storageType: "URL",
      resultUrl: "https://example.com/result.pdf",
    });

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.resultUrl).toBe("https://example.com/result.pdf");
    expect(body.fileMeta).toBeUndefined();
  });

  it("returns fileMeta (not resultUrl) for a LOCAL_FILE-type deliverable", async () => {
    const taskId = await insertTask();
    await insertDeliverable(taskId, {
      storageType: "LOCAL_FILE",
      filePath: "some-random-uuid",
      mimeType: "application/pdf",
      sizeBytes: 12345,
    });

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.fileMeta).toEqual({ mimeType: "application/pdf", sizeBytes: 12345 });
    expect(body.resultUrl).toBeUndefined();
  });

  it("returns the most recent deliverable when multiple submission attempts exist", async () => {
    const taskId = await insertTask();
    await insertDeliverable(taskId, { resultUrl: "https://example.com/first.pdf" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await insertDeliverable(taskId, { resultUrl: "https://example.com/second.pdf" });

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().resultUrl).toBe("https://example.com/second.pdf");
  });

  // N4 round 1 P2 (Codex): `created_at` alone is not a reliable ordering
  // key — two submissions can tie on it. This forces a real tie (an
  // explicit, identical `created_at` on both rows) and proves the endpoint
  // still deterministically picks the row inserted SECOND (the higher
  // `sequence_no`), not whichever row a UUID-ordered tiebreaker happened
  // to prefer.
  it("breaks a created_at tie using sequence_no, not the (unordered) UUID id", async () => {
    const taskId = await insertTask();
    const tiedTimestamp = "2026-05-01T00:00:00.000Z";
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash, created_at)
       VALUES ($1, $2, 'URL', 'https://example.com/tied-first.pdf', $3, $4)`,
      [taskId, agent.address.toLowerCase(), `0x${"a".repeat(64)}`, tiedTimestamp],
    );
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, result_url, result_hash, created_at)
       VALUES ($1, $2, 'URL', 'https://example.com/tied-second.pdf', $3, $4)`,
      [taskId, agent.address.toLowerCase(), `0x${"b".repeat(64)}`, tiedTimestamp],
    );

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });

    expect(response.statusCode).toBe(200);
    // The row inserted second (higher sequence_no) must win, regardless of
    // the tied created_at or the two rows' random UUID ordering.
    expect(response.json().resultUrl).toBe("https://example.com/tied-second.pdf");
  });

  it("passes through submittedAt/reviewDeadline as null before T-905's event sync ever runs", async () => {
    const taskId = await insertTask();
    await insertDeliverable(taskId);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });

    const body = response.json();
    expect(body.submittedAt).toBeNull();
    expect(body.reviewDeadline).toBeNull();
  });

  it("passes through a real submittedAt/reviewDeadline verbatim once tasks columns are set", async () => {
    const taskId = await insertTask();
    await insertDeliverable(taskId);
    const submittedAt = "2026-06-01T12:00:00.000Z";
    const reviewDeadline = "2026-06-04T12:00:00.000Z";
    await pool.query(`UPDATE tasks SET submitted_at = $1, review_deadline = $2 WHERE id = $3`, [
      submittedAt,
      reviewDeadline,
      taskId,
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/deliverables/latest`,
    });

    const body = response.json();
    expect(body.submittedAt).toBe(submittedAt);
    expect(body.reviewDeadline).toBe(reviewDeadline);
  });
});
