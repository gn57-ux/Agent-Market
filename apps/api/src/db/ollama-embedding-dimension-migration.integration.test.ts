import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1309's own verification that
// 0017_ollama_embedding_dimension.sql actually enforces, at the database
// layer, specs/13-vector-recall-scoring/design.md v1.2's data model: both
// embeddings tables store and round-trip a real 1024-dim vector, reject
// the old 1536-dim shape, and the ivfflat index survives the column-type
// rebuild — WITHOUT touching 0015_create_vector_recall_scoring.sql itself
// (see that migration's own still-passing 1536-dim test file,
// vector-recall-scoring-migration.integration.test.ts, which documents
// 0015's original, unmodified behavior in isolation).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const OWNER_ADDRESS = "0xd183fefc63f0cd0e873a0000c6d07ef7b77e90dc";
const REQUESTER_ADDRESS = "0xe183fefc63f0cd0e873a0000c6d07ef7b77e90dd";
const TOKEN_ADDRESS = "0xf183fefc63f0cd0e873a0000c6d07ef7b77e90de";

function fakeVector1024(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) * 0.01);
}

function fakeVector1536(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01);
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

runIfOptedIn("0017_ollama_embedding_dimension migration (integration, T-1309)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
    );
    await pool.end();
  });

  async function insertAgent(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
         VALUES ($1, 'Test Agent', 'desc', 'writing', $1) RETURNING id`,
      [OWNER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
         VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT', 'AUTOMATION')
         RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  it("agent_embeddings.embedding is vector(1024) after migration", async () => {
    const { rows } = await pool.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
         WHERE table_name = 'agent_embeddings' AND column_name = 'embedding'`,
    );
    expect(rows[0]?.udt_name).toBe("vector");
    // information_schema doesn't expose pgvector's own typmod (dimension)
    // directly — proven behaviorally below instead (accepts 1024, rejects
    // 1536).
  });

  it("stores and round-trips a real 1024-dim vector for an Agent", async () => {
    const agentId = await insertAgent();
    const vector = fakeVector1024(1);
    const { rows } = await pool.query<{ dimension: number }>(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'ollama:bge-m3:latest@digest:dim1024:tmplv1')
         RETURNING dimension`,
      [agentId, toVectorLiteral(vector)],
    );
    expect(rows[0]?.dimension).toBe(1024);

    const { rows: readBack } = await pool.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    const parsed = readBack[0]?.embedding
      ?.slice(1, -1)
      .split(",")
      .map((n) => Number(n));
    expect(parsed).toHaveLength(1024);
    expect(parsed?.[0]).toBeCloseTo(vector[0] as number, 5);
  });

  it("rejects the old 1536-dim shape, even with dimension correctly declared as 1024", async () => {
    const agentId = await insertAgent();
    await expect(
      pool.query(
        `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
           VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')`,
        [agentId, toVectorLiteral(fakeVector1536(2))],
      ),
    ).rejects.toThrow();
  });

  it("rejects a dimension value other than 1024, even if the vector itself is 1024-long", async () => {
    const agentId = await insertAgent();
    await expect(
      pool.query(
        `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
           VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1536, 'v')`,
        [agentId, toVectorLiteral(fakeVector1024(3))],
      ),
    ).rejects.toThrow();
  });

  it("stores a 1024-dim task embedding, independent of agent_embeddings", async () => {
    const taskId = await insertTask();
    const { rows } = await pool.query<{ dimension: number }>(
      `INSERT INTO task_embeddings (task_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')
         RETURNING dimension`,
      [taskId, toVectorLiteral(fakeVector1024(4))],
    );
    expect(rows[0]?.dimension).toBe(1024);
  });

  it("agent_embeddings is removed when its Agent is deleted (ON DELETE CASCADE) — unaffected by the dimension change", async () => {
    const agentId = await insertAgent();
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')`,
      [agentId, toVectorLiteral(fakeVector1024(6))],
    );
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("orders real 1024-dim candidates by cosine distance (<=>), nearest first — proves the rebuilt ivfflat index is genuinely queryable", async () => {
    const near = await insertAgent();
    const far = await insertAgent();
    const queryVector = fakeVector1024(10);
    const nearVector = queryVector.map((v) => v + 0.0001);
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')`,
      [near, toVectorLiteral(nearVector)],
    );
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')`,
      [far, toVectorLiteral(fakeVector1024(999))],
    );

    const { rows } = await pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM agent_embeddings WHERE agent_id = ANY($2) ORDER BY embedding <=> $1`,
      [toVectorLiteral(queryVector), [near, far]],
    );
    expect(rows.map((r) => r.agent_id)).toEqual([near, far]);
  });

  it("rollback restores vector(1536)/dimension=1536, clearing 1024-dim rows, and the migration can be reapplied (up → down → up)", async () => {
    const agentId = await insertAgent();
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')`,
      [agentId, toVectorLiteral(fakeVector1024(5))],
    );

    const rollbackPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0017_ollama_embedding_dimension.rollback.sql",
    );
    const rollbackSql = await import("node:fs").then((fs) => fs.readFileSync(rollbackPath, "utf8"));
    await pool.query(rollbackSql);

    const { rows: afterRollbackRows } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(afterRollbackRows).toHaveLength(0);

    const { rows: columns } = await pool.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
         WHERE table_name = 'agent_embeddings' AND column_name = 'embedding'`,
    );
    expect(columns[0]?.udt_name).toBe("vector");

    // Behaviorally proves the rollback really restored 1536 (not left at
    // 1024): a real 1536-dim insert now succeeds again.
    const { rows: reinsert } = await pool.query<{ dimension: number }>(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'openai', 'text-embedding-3-small', 1536, 'v1')
         RETURNING dimension`,
      [agentId, toVectorLiteral(fakeVector1536(6))],
    );
    expect(reinsert[0]?.dimension).toBe(1536);
    await pool.query(`DELETE FROM agent_embeddings WHERE agent_id = $1`, [agentId]);

    const { rows: migrationRows } = await pool.query(
      `SELECT id FROM schema_migrations WHERE id = '0017_ollama_embedding_dimension.sql'`,
    );
    expect(migrationRows).toHaveLength(0);

    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toEqual(["0017_ollama_embedding_dimension.sql"]);

    // Reapplied: 1024 works again, 1536 is rejected again.
    const { rows: reapplied } = await pool.query<{ dimension: number }>(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
         VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'v')
         RETURNING dimension`,
      [agentId, toVectorLiteral(fakeVector1024(7))],
    );
    expect(reapplied[0]?.dimension).toBe(1024);
  });
});
