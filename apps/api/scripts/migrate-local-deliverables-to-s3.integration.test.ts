import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { runMigrations } from "../src/db/migrate.js";
import { saveFile as saveLocalFile } from "../src/modules/deliverables/storage.local.js";
import {
  putObjectWithKey,
  readFile as readS3File,
} from "../src/modules/deliverables/storage.s3.js";
import { migrateLocalDeliverablesToS3 } from "./migrate-local-deliverables-to-s3.js";

/**
 * Feature 23 (production-cloud-observability), T-2300 — N4 real finding
 * (round 1, P1): real verification that
 * `apps/api/scripts/migrate-local-deliverables-to-s3.ts` actually copies
 * existing local deliverables into a real S3 bucket (MinIO) under their
 * EXACT existing `file_path` key, is genuinely idempotent, and refuses to
 * silently overwrite a real content mismatch. Real Postgres + real MinIO,
 * no mocking of either backend's own I/O.
 *
 * Gated by BOTH `RUN_DB_INTEGRATION_TESTS=1` (real Postgres) and
 * `RUN_S3_INTEGRATION_TESTS=1` (real MinIO reachable at
 * `DELIVERABLE_STORAGE_S3_*`), matching `storage.s3.integration.test.ts`'s
 * own gating convention.
 */
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_S3_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

// Same MinIO-default convention `storage.s3.integration.test.ts` already
// establishes — sensible local defaults, overridable via real env vars.
const previousS3Env: Record<string, string | undefined> = {};
function setS3Env(key: string, value: string): void {
  previousS3Env[key] = process.env[key];
  process.env[key] = value;
}
beforeEach(() => {
  setS3Env(
    "DELIVERABLE_STORAGE_S3_ENDPOINT",
    process.env.DELIVERABLE_STORAGE_S3_ENDPOINT ?? "http://localhost:9000",
  );
  setS3Env(
    "DELIVERABLE_STORAGE_S3_BUCKET",
    process.env.DELIVERABLE_STORAGE_S3_BUCKET ?? "deliverables-test",
  );
  setS3Env("DELIVERABLE_STORAGE_S3_REGION", process.env.DELIVERABLE_STORAGE_S3_REGION ?? "auto");
  setS3Env(
    "DELIVERABLE_STORAGE_S3_ACCESS_KEY_ID",
    process.env.DELIVERABLE_STORAGE_S3_ACCESS_KEY_ID ?? "minioadmin",
  );
  setS3Env(
    "DELIVERABLE_STORAGE_S3_SECRET_ACCESS_KEY",
    process.env.DELIVERABLE_STORAGE_S3_SECRET_ACCESS_KEY ?? "minioadmin",
  );
});
afterEach(() => {
  for (const [key, value] of Object.entries(previousS3Env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE";

runIfOptedIn("migrateLocalDeliverablesToS3 (real Postgres + real MinIO, T-2300)", () => {
  let pool: Pool;
  let storageDir: string;
  const requester = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "deliverables-migration-test-"));
    process.env.DELIVERABLE_STORAGE_DIR = storageDir;
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await pool.query("DELETE FROM deliverables");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM users");
  });

  async function insertTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 1000, '0x1111111111111111111111111111111111111111', '2099-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [requester.address.toLowerCase()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  async function insertLocalFileDeliverable(content: Buffer, mimeType: string): Promise<string> {
    const taskId = await insertTask();
    const saved = await saveLocalFile({ buffer: content, mimeType });
    await pool.query(
      `INSERT INTO deliverables (task_id, agent_address, storage_type, file_path, mime_type, size_bytes, result_hash)
       VALUES ($1, $2, 'LOCAL_FILE', $3, $4, $5, $6)`,
      [
        taskId,
        agent.address.toLowerCase(),
        saved.filePath,
        mimeType,
        saved.sizeBytes,
        `0x${"c".repeat(64)}`,
      ],
    );
    return saved.filePath;
  }

  it("copies a real local deliverable into S3 under its exact existing key, byte-identical", async () => {
    const content = Buffer.from("real deliverable bytes for T-2300 migration test");
    const filePath = await insertLocalFileDeliverable(content, "text/plain");

    const result = await migrateLocalDeliverablesToS3(pool);

    expect(result.copied).toBe(1);
    expect(result.alreadyPresent).toBe(0);
    expect(result.failed).toEqual([]);

    // The real point of the migration: the SAME key is now readable from
    // the S3 backend too, with byte-identical content — a real read
    // through the real S3 client, not a re-inspection of local disk.
    const migrated = await readS3File(filePath);
    expect(migrated.equals(content)).toBe(true);
  });

  it("is genuinely idempotent: a second run reports already-present rather than re-copying", async () => {
    const content = Buffer.from("idempotency check content");
    await insertLocalFileDeliverable(content, "text/plain");

    const first = await migrateLocalDeliverablesToS3(pool);
    expect(first.copied).toBe(1);

    const second = await migrateLocalDeliverablesToS3(pool);
    expect(second.copied).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(second.failed).toEqual([]);
  });

  it("refuses to silently overwrite a real content mismatch under the same key", async () => {
    const content = Buffer.from("the real local content");
    const filePath = await insertLocalFileDeliverable(content, "text/plain");

    // Simulate a real, pre-existing (different) object already occupying
    // that same key in S3 — a genuine conflict, not something this script
    // should ever resolve by guessing which version is "correct".
    await putObjectWithKey(filePath, {
      buffer: Buffer.from("a DIFFERENT object already in S3 under the same key"),
      mimeType: "text/plain",
    });

    const result = await migrateLocalDeliverablesToS3(pool);

    expect(result.copied).toBe(0);
    expect(result.alreadyPresent).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.filePath).toBe(filePath);
    expect(result.failed[0]?.error).toContain("does not match");

    // The pre-existing (different) S3 object must be untouched — proof
    // this really did refuse to overwrite, not just report a failure
    // after overwriting anyway.
    const stillThere = await readS3File(filePath);
    expect(stillThere.toString()).toBe("a DIFFERENT object already in S3 under the same key");
  });
});
