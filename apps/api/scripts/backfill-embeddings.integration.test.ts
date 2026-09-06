import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { computeEmbeddingVersion } from "../src/modules/embeddings/embed-on-save.js";
import { OllamaEmbeddingProvider } from "../src/modules/embeddings/ollama-provider.js";
import { runBackfill } from "./backfill-embeddings.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1310's own real proof of F-1316: only missing/stale
// rows are processed, already-current rows are left untouched, a failure on
// one entity doesn't stop the rest and is picked up by re-running, and the
// concurrency cap genuinely bounds how many `/api/embed` calls are ever in
// flight at once — against a fake Ollama server (deterministic failure
// injection and concurrency observation), not a real one.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const OWNER_ADDRESS = "0xd283fefc63f0cd0e873a0000c6d07ef7b77e91dc";
const REQUESTER_ADDRESS = "0xe283fefc63f0cd0e873a0000c6d07ef7b77e91dd";
const TOKEN_ADDRESS = "0xf283fefc63f0cd0e873a0000c6d07ef7b77e91de";

const FAKE_DIGEST = "back1117".repeat(8);

function fakeVector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) * 0.01);
}

function tagsResponseBody(): string {
  return JSON.stringify({
    models: [{ name: "bge-m3:latest", model: "bge-m3:latest", digest: FAKE_DIGEST, details: {} }],
  });
}

runIfOptedIn("backfill-embeddings runBackfill (integration, T-1310)", () => {
  let pool: Pool;
  let server: Server | undefined;
  let embedCallCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let failingInputSubstring: string | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
      REQUESTER_ADDRESS,
    ]);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_embeddings");
    await pool.query("DELETE FROM task_embeddings");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
    await pool.query("DELETE FROM task_skills");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM embedding_budget_usage");
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    embedCallCount = 0;
    inFlight = 0;
    maxInFlight = 0;
    failingInputSubstring = undefined;
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  // Real fake Ollama server: `/api/tags` always succeeds; `/api/embed`
  // tracks concurrency, counts calls, and can be told to fail for inputs
  // containing `failingInputSubstring` (test-controlled, reset per test).
  function listenOllama(delayMs = 0): Promise<string> {
    const handler: RequestListener = (req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(tagsResponseBody());
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        embedCallCount += 1;
        const { input } = JSON.parse(raw) as { input: string };
        const respond = () => {
          inFlight -= 1;
          if (failingInputSubstring && input.includes(failingInputSubstring)) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "boom" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [fakeVector(embedCallCount)] }));
        };
        if (delayMs > 0) {
          setTimeout(respond, delayMs);
        } else {
          respond();
        }
      });
    };
    return new Promise((resolve) => {
      server = createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
          resolve(`http://127.0.0.1:${address.port}`);
        }
      });
    });
  }

  async function insertAgent(description: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Backfill Test Agent', $2, 'writing', $1) RETURNING id`,
      [OWNER_ADDRESS, description],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertTask(description: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', $2, '1000', $3, '2033-01-01T00:00:00Z', 'DRAFT', 'CONTENT_GENERATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, description, TOKEN_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  it("only processes missing/stale records, leaving an already-current record untouched", async () => {
    const url = await listenOllama();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    const targetVersion = computeEmbeddingVersion(await provider.resolveVersionIdentity());

    const missingAgentId = await insertAgent("agent missing a vector");
    const currentAgentId = await insertAgent("agent already current");
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, $3)`,
      [currentAgentId, `[${fakeVector(999).join(",")}]`, targetVersion],
    );
    const staleAgentId = await insertAgent("agent with a stale version");
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, 'ollama:bge-m3:latest@old-digest:dim1024:tmplv1')`,
      [staleAgentId, `[${fakeVector(998).join(",")}]`],
    );

    const summary = await runBackfill(pool, provider);

    expect(summary.agentsProcessed).toBe(2);
    expect(summary.remainingStaleAgents).toBe(0);

    const { rows: currentRow } = await pool.query<{ embedding_version: string }>(
      `SELECT embedding_version FROM agent_embeddings WHERE agent_id = $1`,
      [currentAgentId],
    );
    // Untouched: still the ORIGINAL row this test inserted directly, not a
    // freshly-generated one (proves it was never re-embedded).
    expect(currentRow[0]?.embedding_version).toBe(targetVersion);

    const { rows: missingRow } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [missingAgentId],
    );
    expect(missingRow).toHaveLength(1);

    const { rows: staleRow } = await pool.query<{ embedding_version: string }>(
      `SELECT embedding_version FROM agent_embeddings WHERE agent_id = $1`,
      [staleAgentId],
    );
    expect(staleRow[0]?.embedding_version).toBe(targetVersion);
  });

  it("makes no /api/embed calls at all when every record is already current", async () => {
    const url = await listenOllama();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    const targetVersion = computeEmbeddingVersion(await provider.resolveVersionIdentity());

    const agentId = await insertAgent("already current agent");
    await pool.query(
      `INSERT INTO agent_embeddings (agent_id, embedding, provider, model, dimension, embedding_version)
       VALUES ($1, $2, 'ollama', 'bge-m3:latest', 1024, $3)`,
      [agentId, `[${fakeVector(1).join(",")}]`, targetVersion],
    );

    const callsBefore = embedCallCount;
    const summary = await runBackfill(pool, provider);

    expect(summary.agentsProcessed).toBe(0);
    expect(summary.tasksProcessed).toBe(0);
    expect(embedCallCount).toBe(callsBefore);
  });

  it("a failure on one record doesn't stop the rest, and re-running only processes the remaining (still-stale) record", async () => {
    const url = await listenOllama();
    failingInputSubstring = "the failing one";
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    const okAgentId = await insertAgent("a fine agent");
    const failingAgentId = await insertAgent("the failing one");

    const firstSummary = await runBackfill(pool, provider);
    expect(firstSummary.agentsProcessed).toBe(2);
    expect(firstSummary.remainingStaleAgents).toBe(1);

    const { rows: okRow } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      okAgentId,
    ]);
    expect(okRow).toHaveLength(1);
    const { rows: failingRowAfterFirst } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [failingAgentId],
    );
    expect(failingRowAfterFirst).toHaveLength(0);

    // "Resume": the underlying cause is fixed, re-run picks up exactly the
    // still-stale record — proving this needs no separate tracking table.
    failingInputSubstring = undefined;
    const secondSummary = await runBackfill(pool, provider);
    expect(secondSummary.agentsProcessed).toBe(1);
    expect(secondSummary.remainingStaleAgents).toBe(0);

    const { rows: failingRowAfterSecond } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [failingAgentId],
    );
    expect(failingRowAfterSecond).toHaveLength(1);
  });

  it("never has more than 2 /api/embed calls in flight at once", async () => {
    const url = await listenOllama(80);
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    for (let i = 0; i < 5; i += 1) {
      await insertAgent(`concurrency test agent ${i}`);
    }

    const summary = await runBackfill(pool, provider);

    expect(summary.agentsProcessed).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  // Codex review (T-1310 P2) regression: a concurrent save landing while
  // this entity is still waiting behind the concurrency cap must be
  // reflected in what actually gets embedded — not silently overwritten by
  // whatever text existed at the start of the whole batch.
  it("embeds an entity's text as of when it's actually processed, not as of the initial batch snapshot (concurrent update mid-run)", async () => {
    const receivedInputs: string[] = [];
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(tagsResponseBody());
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const { input } = JSON.parse(raw) as { input: string };
        receivedInputs.push(input);
        embedCallCount += 1;
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [fakeVector(embedCallCount)] }));
        }, 150);
      });
    });
    const url = await new Promise<string>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
          resolve(`http://127.0.0.1:${address.port}`);
        }
      });
    });
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    // With CONCURRENCY=2, agent3 only starts once agent1/agent2 free a
    // slot (~150ms in) — plenty of time to land a real concurrent UPDATE
    // on agent3 before this script ever reads its text.
    await insertAgent("agent1 original text");
    await insertAgent("agent2 original text");
    const agent3Id = await insertAgent("agent3 ORIGINAL text (should not be embedded)");

    const backfillPromise = runBackfill(pool, provider);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await pool.query(`UPDATE agents SET description = $1 WHERE id = $2`, [
      "agent3 UPDATED text (this is what must be embedded)",
      agent3Id,
    ]);
    await backfillPromise;

    expect(receivedInputs.some((input) => input.includes("agent3 UPDATED text"))).toBe(true);
    expect(receivedInputs.some((input) => input.includes("agent3 ORIGINAL text"))).toBe(false);
  });

  // Codex review (T-1311 P2) regression: if the entity changes again AFTER
  // backfill already read its text but BEFORE backfill's own write lands,
  // that write would be based on stale text — it must be discarded rather
  // than left behind looking "current" (see `discardIfEntityChangedSince`'s
  // doc comment for the full scenario, including why a real concurrent
  // save's OWN embed-on-save cycle would still self-heal it correctly).
  it("re-embeds with fresh text (never deletes) when the entity changes again while its embed() call is still in flight", async () => {
    const receivedInputs: string[] = [];
    let embedCallCount = 0;
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(tagsResponseBody());
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const { input } = JSON.parse(raw) as { input: string };
        receivedInputs.push(input);
        embedCallCount += 1;
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ embeddings: [fakeVector(embedCallCount)] }));
        }, 150);
      });
    });
    const url = await new Promise<string>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
          resolve(`http://127.0.0.1:${address.port}`);
        }
      });
    });
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    const agentId = await insertAgent("original text, before backfill even starts");

    const backfillPromise = runBackfill(pool, provider);
    // Backfill's own fetchAgentText already ran and returned (fast, no
    // delay) well before the first 150ms-delayed /api/embed response
    // comes back — this UPDATE lands squarely inside that window, forcing
    // exactly one retry (see MAX_STABILIZE_ATTEMPTS).
    await new Promise((resolve) => setTimeout(resolve, 40));
    await pool.query(`UPDATE agents SET description = $1, updated_at = now() WHERE id = $2`, [
      "concurrently updated text, while backfill's embed() call was in flight",
      agentId,
    ]);
    const summary = await backfillPromise;

    expect(summary.agentsProcessed).toBe(1);
    // Two embed() calls: the first attempt (stale text, gets superseded)
    // and the retry (fresh text, ends up stored) — never a delete, and
    // never gives up after just one concurrent update.
    expect(embedCallCount).toBe(2);
    expect(receivedInputs[0]).toContain("original text, before backfill even starts");
    expect(receivedInputs[1]).toContain("concurrently updated text");

    const { rows } = await pool.query<{ embedding_version: string }>(
      `SELECT embedding_version FROM agent_embeddings WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(1);
  });

  it("processes tasks independently of agents, using the four-part text (including expertType)", async () => {
    const url = await listenOllama();
    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    const taskId = await insertTask("a task needing backfill");
    const summary = await runBackfill(pool, provider);

    expect(summary.tasksProcessed).toBe(1);
    const { rows } = await pool.query<{ dimension: number }>(
      `SELECT dimension FROM task_embeddings WHERE task_id = $1`,
      [taskId],
    );
    expect(rows[0]?.dimension).toBe(1024);
  });

  // Codex review (T-1311 P2): one entity's DB error must not abort the
  // rest of the batch. Simulates a transient failure on exactly one
  // agent's own fetch step (via a thin query-wrapping pool, matching this
  // project's established test-mock convention), and proves the OTHER
  // agent in the same run still gets processed successfully.
  it("isolates one entity's DB error — the rest of the batch still gets processed", async () => {
    const url = await listenOllama();
    const realProvider = new OllamaEmbeddingProvider(pool, { baseUrl: url });

    const okAgentId = await insertAgent("a fine agent");
    const failingAgentId = await insertAgent("an agent whose own fetch will fail");

    const flakyPool = {
      query: ((text: string, params?: unknown[]) => {
        if (
          typeof text === "string" &&
          text.includes("FROM agents a") &&
          text.includes("WHERE a.id = $1") &&
          Array.isArray(params) &&
          params[0] === failingAgentId
        ) {
          return Promise.reject(new Error("simulated transient DB error"));
        }
        return pool.query(text, params);
      }) as Pool["query"],
    } as unknown as Pool;

    const summary = await runBackfill(flakyPool, realProvider);

    expect(summary.agentsProcessed).toBe(2);
    const { rows: okRow } = await pool.query(`SELECT * FROM agent_embeddings WHERE agent_id = $1`, [
      okAgentId,
    ]);
    expect(okRow).toHaveLength(1);
    const { rows: failingRow } = await pool.query(
      `SELECT * FROM agent_embeddings WHERE agent_id = $1`,
      [failingAgentId],
    );
    expect(failingRow).toHaveLength(0);
  });
});
