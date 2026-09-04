import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { embedAgentOnSave, embedTaskOnSave } from "./embed-on-save.js";
import { OllamaEmbeddingProvider } from "./ollama-provider.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. AC-1301's own real proof: a save's own success is
// entirely independent of whether embedding generation succeeds — this
// suite exercises the whole real chain (concatenation → real HTTP calls to
// a real local server standing in for Ollama → real UPSERT into
// agent_embeddings/task_embeddings), not embed-on-save.ts's pure functions
// in isolation. This is a fake HTTP server, not a real local Ollama — see
// ollama-provider.integration.test.ts (T-1308's own real-Ollama suite,
// gated behind RUN_OLLAMA_INTEGRATION_TESTS=1) for the genuinely-real
// bge-m3 chain.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const OWNER_ADDRESS = "0xd283fefc63f0cd0e873a0000c6d07ef7b77e90dc";
const REQUESTER_ADDRESS = "0xe283fefc63f0cd0e873a0000c6d07ef7b77e90dd";
const TOKEN_ADDRESS = "0xf283fefc63f0cd0e873a0000c6d07ef7b77e90de";

// Not a credential — a plausible-looking but fake Ollama model digest, used
// only as this suite's fake `/api/tags` response.
const FAKE_DIGEST = "d1g35700".repeat(8);

function fakeVector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) * 0.01);
}

function tagsResponseBody(model = "bge-m3:latest", digest = FAKE_DIGEST): string {
  return JSON.stringify({ models: [{ name: model, model, digest, details: {} }] });
}

runIfOptedIn("embedAgentOnSave / embedTaskOnSave (integration, T-1302/T-1308)", () => {
  let pool: Pool;
  let server: Server | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
      REQUESTER_ADDRESS,
    ]);
  });

  afterEach(async () => {
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.OLLAMA_EMBEDDING_MODEL;
    await pool.query("DELETE FROM agent_embeddings");
    await pool.query("DELETE FROM task_embeddings");
    await pool.query("DELETE FROM embedding_budget_usage");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM task_skills");
    await pool.query("DELETE FROM tasks");
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, schema_migrations CASCADE",
    );
    await pool.end();
  });

  // Routes `GET /api/tags` to a fixed, valid response (a real digest lookup
  // every OllamaEmbeddingProvider.embed() call makes) so each test only
  // needs to supply the `/api/embed` behavior it actually cares about.
  function listenOllama(
    embedHandler: RequestListener,
    options: { tagsBody?: string; tagsStatus?: number } = {},
  ): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/api/tags") {
          res.writeHead(options.tagsStatus ?? 200, { "Content-Type": "application/json" });
          res.end(options.tagsBody ?? tagsResponseBody());
          return;
        }
        embedHandler(req, res);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
          resolve(`http://127.0.0.1:${address.port}`);
        }
      });
    });
  }

  async function insertAgent(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Copy Polisher', 'desc', 'writing', $1) RETURNING id`,
      [OWNER_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    await pool.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, 'copywriting')`, [
      id,
    ]);
    return id;
  }

  async function insertTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT', 'CONTENT_GENERATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    await pool.query(`INSERT INTO task_skills (task_id, skill_tag) VALUES ($1, 'copywriting')`, [
      id,
    ]);
    return id;
  }

  it("persists a real embedding for an Agent, built from description+category+skillTags (never expertType — Agents have none)", async () => {
    let receivedInput: string | undefined;
    const url = await listenOllama((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedInput = (JSON.parse(raw) as { input: string }).input;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [fakeVector(1)] }));
      });
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await embedAgentOnSave(
      pool,
      { id: agentId, description: "desc", category: "writing", skillTags: ["copywriting"] },
      provider,
    );

    expect(receivedInput).toContain("desc");
    expect(receivedInput).toContain("分类：writing");
    expect(receivedInput).toContain("技能标签：copywriting");
    expect(receivedInput).not.toContain("专家类型");

    const { rows } = await pool.query<{
      dimension: number;
      provider: string;
      embedding_version: string;
    }>(`SELECT dimension, provider, embedding_version FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dimension).toBe(1024);
    expect(rows[0]?.provider).toBe("ollama");
    expect(rows[0]?.embedding_version).toBe(`ollama:bge-m3:latest@${FAKE_DIGEST}:dim1024:tmplv1`);
  });

  it("persists a real embedding for a task, built from description+expertType+category+skillTags", async () => {
    let receivedInput: string | undefined;
    const url = await listenOllama((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedInput = (JSON.parse(raw) as { input: string }).input;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [fakeVector(2)] }));
      });
    });

    const taskId = await insertTask();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await embedTaskOnSave(
      pool,
      {
        id: taskId,
        description: "desc",
        expertType: "CONTENT_GENERATION",
        category: "writing",
        skillTags: ["copywriting"],
      },
      provider,
    );

    expect(receivedInput).toContain("专家类型：CONTENT_GENERATION");

    const { rows } = await pool.query(`SELECT * FROM task_embeddings WHERE task_id = $1`, [taskId]);
    expect(rows).toHaveLength(1);
  });

  it("re-saving replaces (not duplicates) the Agent's embedding row", async () => {
    let embedCallCount = 0;
    const url = await listenOllama((req, res) => {
      embedCallCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [fakeVector(embedCallCount)] }));
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    const agent = { id: agentId, description: "desc", category: "writing", skillTags: [] };
    await embedAgentOnSave(pool, agent, provider);
    await embedAgentOnSave(pool, agent, provider);

    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(1);
    expect(embedCallCount).toBe(2);
  });

  // AC-1301's core guarantee: the save operation this function is called
  // AFTER has already succeeded (the row inserted above proves that) — this
  // test proves the embedding side of that operation degrades cleanly.
  it("resolves without throwing when the Provider returns an error, and persists no row", async () => {
    const url = await listenOllama((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(
      embedAgentOnSave(
        pool,
        { id: agentId, description: "desc", category: "writing", skillTags: [] },
        provider,
      ),
    ).resolves.toBeUndefined();

    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("resolves without throwing and skips entirely when OLLAMA_EMBEDDING_MODEL names an undeclared model (real resolveProvider path, no override)", async () => {
    process.env.OLLAMA_EMBEDDING_MODEL = "not-a-declared-model:latest";
    const agentId = await insertAgent();
    await expect(
      embedAgentOnSave(pool, {
        id: agentId,
        description: "desc",
        category: "writing",
        skillTags: [],
      }),
    ).resolves.toBeUndefined();

    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // Codex review (T-1308 P2): a save whose text genuinely changed must not
  // leave behind a vector describing the PRIOR text just because the
  // Provider happens to be unavailable at that moment — a stale-but-
  // present row would satisfy dispatch/repository.ts's mere "does a row
  // exist" check while actually being wrong.
  it("clears an Agent's existing embedding when a later save happens while the Provider is unavailable (undeclared model)", async () => {
    const url = await listenOllama((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [fakeVector(1)] }));
    });
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    const agentId = await insertAgent();
    await embedAgentOnSave(
      pool,
      { id: agentId, description: "desc v1", category: "writing", skillTags: [] },
      provider,
    );
    const { rows: beforeUnavailable } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(beforeUnavailable).toHaveLength(1);

    process.env.OLLAMA_EMBEDDING_MODEL = "not-a-declared-model:latest";
    await embedAgentOnSave(pool, {
      id: agentId,
      description: "desc v2 (pivoted, provider unavailable)",
      category: "writing",
      skillTags: [],
    });

    const { rows: afterUnavailable } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(afterUnavailable).toHaveLength(0);
  });

  it("skips entirely when EMBEDDING_PROVIDER=off", async () => {
    process.env.EMBEDDING_PROVIDER = "off";
    const agentId = await insertAgent();
    await embedAgentOnSave(pool, {
      id: agentId,
      description: "desc",
      category: "writing",
      skillTags: [],
    });

    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(0);
  });

  // N4 round-1 Finding 2 regression: a slower OLDER save's response must
  // never overwrite a faster NEWER save's result. Deliberately delays the
  // first (older) call's HTTP response so it would resolve after the
  // second (newer, undelayed) call if the two ran concurrently — without
  // `enqueuePerEntity`'s serialization, the older call's late-arriving
  // stale vector would win the UPSERT.
  it("keeps the newer save's embedding when an older save's response arrives later (out-of-order completion)", async () => {
    const url = await listenOllama((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const input = (JSON.parse(raw) as { input: string }).input;
        const isOlder = input.includes("older text");
        const respond = () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [fakeVector(isOlder ? 1 : 2)] }));
        };
        if (isOlder) {
          setTimeout(respond, 150);
        } else {
          respond();
        }
      });
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    const olderCall = embedAgentOnSave(
      pool,
      { id: agentId, description: "older text", category: "writing", skillTags: [] },
      provider,
    );
    const newerCall = embedAgentOnSave(
      pool,
      { id: agentId, description: "newer text", category: "writing", skillTags: [] },
      provider,
    );
    await Promise.all([olderCall, newerCall]);

    const { rows } = await pool.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(1);
    const parsed = rows[0]?.embedding
      ?.slice(1, -1)
      .split(",")
      .map((n) => Number(n));
    // pgvector stores as float4 internally — compare with a tolerance
    // rather than exact equality (matches vector-recall-scoring-migration.
    // integration.test.ts's identical convention).
    expect(parsed?.[0]).toBeCloseTo(fakeVector(2)[0] as number, 5);
  });

  // N4 round-2 Finding regression: a working vector must not survive a
  // FAILED regeneration attempt after an update — otherwise it would look
  // "valid" (row exists) to anything checking for one, while actually
  // describing the entity's PRIOR text. F-1304's degrade path only
  // triggers correctly if a failed regeneration leaves no row at all.
  it("removes an Agent's existing embedding when a later regeneration attempt fails", async () => {
    const url = await listenOllama((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [fakeVector(1)] }));
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await embedAgentOnSave(
      pool,
      { id: agentId, description: "desc v1", category: "writing", skillTags: [] },
      provider,
    );
    const { rows: beforeFailure } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(beforeFailure).toHaveLength(1);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const failingUrl = await listenOllama((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    const failingProvider = new OllamaEmbeddingProvider(pool, { baseUrl: failingUrl });
    await embedAgentOnSave(
      pool,
      { id: agentId, description: "desc v2 (pivoted)", category: "writing", skillTags: [] },
      failingProvider,
    );

    const { rows: afterFailure } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(afterFailure).toHaveLength(0);
  });

  it("removes a task's existing embedding when a later regeneration attempt fails", async () => {
    const url = await listenOllama((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [fakeVector(1)] }));
    });

    const taskId = await insertTask();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await embedTaskOnSave(
      pool,
      {
        id: taskId,
        description: "desc v1",
        expertType: "CONTENT_GENERATION",
        category: "writing",
        skillTags: [],
      },
      provider,
    );
    const { rows: beforeFailure } = await pool.query(
      `SELECT * FROM task_embeddings WHERE task_id = $1`,
      [taskId],
    );
    expect(beforeFailure).toHaveLength(1);

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const failingUrl = await listenOllama((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    const failingProvider = new OllamaEmbeddingProvider(pool, { baseUrl: failingUrl });
    await embedTaskOnSave(
      pool,
      {
        id: taskId,
        description: "desc v2 (pivoted)",
        expertType: "CONTENT_GENERATION",
        category: "writing",
        skillTags: [],
      },
      failingProvider,
    );

    const { rows: afterFailure } = await pool.query(
      `SELECT * FROM task_embeddings WHERE task_id = $1`,
      [taskId],
    );
    expect(afterFailure).toHaveLength(0);
  });

  // Codex review (T-1308 P2): `enqueuePerEntity`'s per-entity chain must
  // not jam after one call's `work` rejects — `deleteAgentEmbedding` runs
  // OUTSIDE the try/catch inside `work` (a deliberate design: its failure
  // should propagate to embedAgentOnSave's own caller, not be silently
  // swallowed alongside Provider failures), so a transient DB error on
  // just the DELETE must still let an already-enqueued LATER save run
  // normally, not silently starve forever.
  it("still runs a later enqueued save even after an earlier save's pre-embedding DELETE rejects (queue must not jam)", async () => {
    const url = await listenOllama((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [fakeVector(9)] }));
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    let deleteCallCount = 0;
    const flakyPool: Queryable = {
      query: ((text: string, params?: unknown[]) => {
        if (text.includes("DELETE FROM agent_embeddings")) {
          deleteCallCount += 1;
          if (deleteCallCount === 1) {
            return Promise.reject(new Error("simulated transient DB error"));
          }
        }
        return pool.query(text, params);
      }) as Queryable["query"],
    };

    const firstCall = embedAgentOnSave(
      flakyPool,
      { id: agentId, description: "first (delete fails)", category: "writing", skillTags: [] },
      provider,
    );
    const secondCall = embedAgentOnSave(
      flakyPool,
      { id: agentId, description: "second (should still run)", category: "writing", skillTags: [] },
      provider,
    );

    await expect(firstCall).rejects.toThrow("simulated transient DB error");
    await expect(secondCall).resolves.toBeUndefined();

    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("resolves without throwing when the monthly budget is exhausted, and persists no row, without making any HTTP request", async () => {
    process.env.EMBEDDING_MONTHLY_BUDGET = "0";
    let serverWasCalled = false;
    const url = await listenOllama((req, res) => {
      serverWasCalled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [fakeVector(3)] }));
    });

    const agentId = await insertAgent();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await embedAgentOnSave(
      pool,
      { id: agentId, description: "desc", category: "writing", skillTags: [] },
      provider,
    );

    expect(serverWasCalled).toBe(false);
    delete process.env.EMBEDDING_MONTHLY_BUDGET;
    const { rows } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      agentId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
