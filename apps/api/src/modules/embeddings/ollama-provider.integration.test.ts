import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { EmbeddingProviderError, OllamaEmbeddingProvider } from "./ollama-provider.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. `embed()` calls `tryConsumeEmbeddingBudget` internally,
// which needs a real Postgres pool — this suite exercises the whole real
// chain (budget check + real HTTP calls to a real local server standing in
// for Ollama), not `ollama-provider.ts` in isolation. The genuinely-real
// local Ollama chain (actual bge-m3 inference, no fake server) is a
// separate suite below, gated behind RUN_OLLAMA_INTEGRATION_TESTS=1 — this
// suite's fake server exists precisely so every error path (non-2xx,
// malformed body, wrong dimension, NaN/Infinity, timeout, missing model)
// can be tested deterministically without depending on a real Ollama
// process's actual failure behavior.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const VALID_1024_VECTOR = Array.from({ length: 1024 }, (_, i) => i / 1024);
const FAKE_DIGEST = "d1g35700".repeat(8);

function tagsResponseBody(model = "bge-m3:latest", digest = FAKE_DIGEST): string {
  return JSON.stringify({ models: [{ name: model, model, digest, details: {} }] });
}

runIfOptedIn("OllamaEmbeddingProvider (integration, T-1308)", () => {
  let pool: Pool;
  let server: Server | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterEach(async () => {
    delete process.env.OLLAMA_EMBEDDING_MODEL;
    delete process.env.EMBEDDING_MONTHLY_BUDGET;
    await pool.query("DELETE FROM embedding_budget_usage");
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE",
    );
    await pool.end();
  });

  // Routes `GET /api/tags` to a fixed, valid response so each test only
  // needs to supply the `/api/embed` behavior it actually cares about,
  // unless it explicitly overrides `tagsHandler`.
  function listen(embedHandler: RequestListener, tagsHandler?: RequestListener): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/api/tags") {
          if (tagsHandler) {
            tagsHandler(req, res);
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(tagsResponseBody());
          }
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

  it("throws EmbeddingProviderError at construction time for an undeclared model", () => {
    expect(() => new OllamaEmbeddingProvider(pool, { model: "not-declared:latest" })).toThrow(
      EmbeddingProviderError,
    );
  });

  it("sends the model+input body to /api/embed and parses a real 1024-dim response, tagging the result with the resolved digest", async () => {
    let receivedBody: unknown;
    const url = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [VALID_1024_VECTOR] }));
      });
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    const result = await provider.embed("a task description");

    expect(receivedBody).toEqual({ model: "bge-m3:latest", input: "a task description" });
    expect(result.model).toBe("bge-m3:latest");
    expect(result.dimension).toBe(1024);
    expect(result.provider).toBe("ollama");
    expect(result.modelDigest).toBe(FAKE_DIGEST);
    expect(result.vector).toHaveLength(1024);
  });

  it("only queries /api/tags once across two embed() calls on the same instance (digest cached)", async () => {
    let tagsCallCount = 0;
    const url = await listen(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [VALID_1024_VECTOR] }));
      },
      (req, res) => {
        tagsCallCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(tagsResponseBody());
      },
    );

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await provider.embed("first");
    await provider.embed("second");

    expect(tagsCallCount).toBe(1);
  });

  it("throws EmbeddingProviderError for a non-2xx status from /api/embed, without echoing the response body", async () => {
    const url = await listen((req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited, must-not-leak-into-message" }));
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    try {
      await provider.embed("text");
      throw new Error("expected embed to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect((error as Error).message).not.toContain("must-not-leak-into-message");
    }
  });

  it("throws EmbeddingProviderError when /api/tags returns a non-2xx status (model list unavailable)", async () => {
    const url = await listen(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [VALID_1024_VECTOR] }));
      },
      (req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      },
    );

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError when the configured model is absent from /api/tags (model not installed)", async () => {
    const url = await listen(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [VALID_1024_VECTOR] }));
      },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [] }));
      },
    );

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError for a malformed (non-JSON) /api/embed response body", async () => {
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError when embeddings is empty", async () => {
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [] }));
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError when the response vector has the wrong dimension", async () => {
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [[1, 2, 3]] }));
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError (not a raw TypeError) for a bare JSON null response", async () => {
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("null");
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError when the vector has the right length but contains a NaN/Infinity element", async () => {
    const brokenVector = [...VALID_1024_VECTOR];
    brokenVector[500] = Number.NaN;
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [brokenVector] }));
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);

    const infiniteVector = [...VALID_1024_VECTOR];
    infiniteVector[0] = Number.POSITIVE_INFINITY;
    const url2 = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [infiniteVector] }));
    });
    const provider2 = new OllamaEmbeddingProvider(pool, { baseUrl: url2 });
    await expect(provider2.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError when the vector has the right length but non-numeric elements", async () => {
    const wrongTypeVector = Array.from({ length: 1024 }, () => "not-a-number");
    const url = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embeddings: [wrongTypeVector] }));
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("throws EmbeddingProviderError when the monthly budget is already exhausted, without making any HTTP request", async () => {
    process.env.EMBEDDING_MONTHLY_BUDGET = "0";
    let serverWasCalled = false;
    const url = await listen(
      (req, res) => {
        serverWasCalled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings: [VALID_1024_VECTOR] }));
      },
      (req, res) => {
        serverWasCalled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(tagsResponseBody());
      },
    );

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
    expect(serverWasCalled).toBe(false);
  });

  it("times out against a real server whose /api/tags never responds, without hanging", async () => {
    const url = await listen(
      () => {
        // never reached in this test
      },
      () => {
        // Deliberately never calls res.end() — the digest lookup itself
        // must time out.
      },
    );

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url, timeoutMs: 200 });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });

  it("times out against a real server whose /api/embed never responds, without hanging", async () => {
    const url = await listen(() => {
      // Deliberately never calls res.end() — the embed call itself must
      // time out (after the digest lookup already succeeded).
    });

    const provider = new OllamaEmbeddingProvider(pool, { baseUrl: url, timeoutMs: 200 });
    await expect(provider.embed("text")).rejects.toThrow(EmbeddingProviderError);
  });
});

// Genuinely real local Ollama, no fake server — proves the whole real chain
// (real HTTP round trip to a real running Ollama, real bge-m3 inference)
// actually works, matching this Feature's own "T-1307 必须使用本机真实
// bge-m3 完成黄金样本" standard applied one layer down at the Provider
// level. Requires both a real local Ollama with bge-m3:latest installed AND
// RUN_DB_INTEGRATION_TESTS=1 (budget tracking needs a real pool) — opted
// into separately from the fake-server suite above so CI/sandboxed
// environments without a local Ollama process can still run every other
// test in this file.
const runIfRealOllama =
  process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1" && process.env.RUN_DB_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

runIfRealOllama("OllamaEmbeddingProvider (real local Ollama, T-1308)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM embedding_budget_usage");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("produces a real 1024-dim, all-finite vector from bge-m3:latest for Chinese and English text alike", async () => {
    const provider = new OllamaEmbeddingProvider(pool);

    const zh = await provider.embed("撰写一份产品需求文档");
    expect(zh.vector).toHaveLength(1024);
    expect(zh.vector.every((value) => Number.isFinite(value))).toBe(true);
    expect(zh.provider).toBe("ollama");
    expect(zh.modelDigest.length).toBeGreaterThan(0);

    const en = await provider.embed("write a product requirements document");
    expect(en.vector).toHaveLength(1024);
    expect(en.vector.every((value) => Number.isFinite(value))).toBe(true);

    // The two texts describe the same real-world task in different
    // languages — cosine similarity should be meaningfully positive (not
    // asserting an exact threshold here; T-1307 v2's golden sample set
    // owns the real calibration work).
    const dot = zh.vector.reduce((sum, value, i) => sum + value * (en.vector[i] as number), 0);
    const normZh = Math.sqrt(zh.vector.reduce((sum, value) => sum + value * value, 0));
    const normEn = Math.sqrt(en.vector.reduce((sum, value) => sum + value * value, 0));
    const cosineSimilarity = dot / (normZh * normEn);
    expect(cosineSimilarity).toBeGreaterThan(0.3);
  });
});
