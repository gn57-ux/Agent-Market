// Real success/failure paths (no mocking of `checkOllamaEmbedding` itself)
// — T-1311 (F-1317). The success case needs a real local Ollama with
// bge-m3:latest installed (this repo's own confirmed dev setup); the
// failure cases point OLLAMA_BASE_URL at a real local HTTP server this
// test controls, so they're deterministic without depending on Ollama
// being reachable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkOllamaEmbedding, formatOllamaPreflightLines } from "./ollama-preflight.mjs";

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(previous)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Codex review (T-1311 P1): this is the one test in this file that
// depends on PRE-EXISTING external state (a real local Ollama with
// bge-m3:latest already installed) rather than a server this test starts
// itself — unlike every other test below, it would fail on a fresh clone,
// in CI, or on any machine without that specific local setup, breaking
// `pnpm env:test` for everyone rather than just verifying this repo's own
// confirmed dev environment. Gated the same way this project's other
// real-Ollama tests are (apps/api's own `RUN_OLLAMA_INTEGRATION_TESTS=1`
// convention), so `pnpm env:test` stays green without it and this
// real-environment check only runs when explicitly opted into.
const testIfOllamaOptedIn = process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1" ? test : test.skip;

testIfOllamaOptedIn(
  "succeeds against the real local Ollama with bge-m3:latest installed",
  async () => {
    const result = await checkOllamaEmbedding();
    assert.equal(result.ok, true);
    assert.equal(result.model, "bge-m3:latest");
    assert.equal(formatOllamaPreflightLines(result).length, 1);
    assert.match(formatOllamaPreflightLines(result)[0], /✅ Ollama Embedding 就绪/);
  },
);

test("reports unreachable when nothing is listening at OLLAMA_BASE_URL", async () => {
  await withEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:1" }, async () => {
    const result = await checkOllamaEmbedding({ timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /无法连接本机 Ollama/);
    const lines = formatOllamaPreflightLines(result);
    assert.match(lines[0], /⚠️ Ollama Embedding 不可用/);
    assert.match(lines[1], /ollama serve/);
    assert.match(lines[1], /ollama pull bge-m3:latest/);
  });
});

test("reports the configured model as missing when /api/tags doesn't list it", async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "some-other-model:latest" }] }));
  });
  try {
    await withEnv({ OLLAMA_BASE_URL: url }, async () => {
      const result = await checkOllamaEmbedding();
      assert.equal(result.ok, false);
      assert.match(result.reason, /未安装模型 bge-m3:latest/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reports a non-2xx status from /api/tags as a failure", async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  try {
    await withEnv({ OLLAMA_BASE_URL: url }, async () => {
      const result = await checkOllamaEmbedding();
      assert.equal(result.ok, false);
      assert.match(result.reason, /非成功状态码（500）/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("respects OLLAMA_EMBEDDING_MODEL when checking which model must be installed", async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "custom-model:latest" }] }));
  });
  try {
    await withEnv(
      { OLLAMA_BASE_URL: url, OLLAMA_EMBEDDING_MODEL: "custom-model:latest" },
      async () => {
        const result = await checkOllamaEmbedding();
        assert.equal(result.ok, true);
        assert.equal(result.model, "custom-model:latest");
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
