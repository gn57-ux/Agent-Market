import { spawn, execFile, type ChildProcessByStdio } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../app.js";
import { runMigrations } from "../db/migrate.js";
import { requireTestDatabaseUrl } from "../db/test-support.js";
import { buildSignInMessage } from "../modules/auth/signInMessage.js";
import { callAgent } from "../modules/agents/invocation-client.js";

/**
 * T-1400 (Feature 14, F-1401) — the real end-to-end scenario Feature 14's
 * own kickoff requires: 发布任务 → 本地 bge-m3 向量召回/匹配 → Agent 接单与质押 →
 * 提交成果 → 结算. Mirrors `full-lifecycle.hardhat.e2e.test.ts`'s (T-1007)
 * real-infrastructure pattern exactly (real spawned Hardhat node, real
 * compiled `YDToken`/`TaskEscrow` contracts, real Postgres, the real
 * production `buildApp()` driven via `app.inject()`) but adds two pieces
 * that file deliberately doesn't need:
 *
 *  - A REAL spawned Go dispatch process (`go run ./cmd/server`,
 *    `services/dispatch/cmd/server/main.go`), not the mocked
 *    `dispatch.client.js` every existing dispatch test uses — the user's
 *    own Feature 14 kickoff explicitly forbids mocking dispatch for
 *    integration acceptance evidence.
 *  - REAL Ollama-backed embeddings (`embedAgentOnSave`/`embedTaskOnSave`,
 *    fire-and-forget from `POST /agents`/`POST /tasks/drafts`), not the
 *    seeded/fake vectors `dispatch/routes.integration.test.ts` uses for its
 *    own (deliberately narrower-scoped) unit-level coverage — this test
 *    polls `agent_embeddings`/`task_embeddings` until real Ollama inference
 *    has actually landed a row before calling `/match`, so `algorithmVersion:
 *    "v0.2"` is genuinely exercised, not assumed.
 *
 * This test also drives acceptance through the REAL server-issued-permit
 * HTTP path (`POST /tasks/:taskId/acceptance-permits`, `GET
 * /tasks/:taskId/agents/:agentId/acceptance-permit`) rather than
 * `full-lifecycle`'s own shortcut of hand-signing a permit directly via
 * `authorizedSigner.signTypedData(...)` — Feature 14's whole point is
 * proving the dispatch/match/permit pipeline works end to end for real, so
 * this specific file cannot take that shortcut.
 *
 * The Agent/task pair below (电商翻译任务 / 英语电商文案编辑 Agent) is sample
 * #3 of Feature 13's own real golden-sample calibration
 * (`specs/13-vector-recall-scoring/golden-sample-calibration.md`) — a
 * cross-category pair (task category `translation`, Agent category
 * `writing`) that the ACTUAL production model (local Ollama bge-m3:latest)
 * scored at a real cosine similarity of 0.6917, safely above the real
 * v02SemanticSimilarityThreshold of 0.64
 * (`services/dispatch/internal/eligibility/eligibility.go`). Reusing this
 * already-verified-real pair (rather than inventing new text and hoping it
 * lands above threshold) is what lets this test reliably exercise F-1305's
 * semantic-widening OR-branch: category-exact-match alone would NOT
 * consider this Agent eligible (a different category), so recommending it
 * is real, live proof the whole vector-recall pipeline — real embedding
 * generation, real pgvector cosine query, real Go eligibility filter — is
 * wired together correctly, not just individually unit-tested.
 *
 * Layered opt-in: `RUN_DB_INTEGRATION_TESTS=1` + `RUN_HARDHAT_E2E_TESTS=1`
 * (same two gates `full-lifecycle.hardhat.e2e.test.ts` uses — design.md's
 * own instruction: "不新建第三套测试基础设施") PLUS `RUN_OLLAMA_INTEGRATION_TESTS=1`
 * (this project's existing, separately-established gate for anything
 * needing a real local Ollama — reused here, not invented), since this file
 * is the first to require all three real dependencies simultaneously.
 */
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" &&
  process.env.RUN_HARDHAT_E2E_TESTS === "1" &&
  process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1"
    ? describe
    : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const contractsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../contracts",
);

const dispatchDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../services/dispatch",
);

const execFileAsync = promisify(execFile);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE";

// Same well-known deterministic Hardhat Network default accounts
// `full-lifecycle.hardhat.e2e.test.ts` (T-1007) already uses — publicly
// documented, hold no real value.
const HARDHAT_ACCOUNT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;

const REVIEW_WINDOW_SECONDS = 259_200; // 72h — matches T-1007's own deployment.

function readArtifact(relativePath: string): { abi: unknown; bytecode: Hex } {
  const raw = readFileSync(path.join(contractsDir, relativePath), "utf8");
  const parsed = JSON.parse(raw) as { abi: unknown; bytecode: string };
  return { abi: parsed.abi, bytecode: parsed.bytecode as Hex };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("getFreePort: failed to acquire a free TCP port"));
      }
    });
  });
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `waitForRpcReady: hardhat node at ${rpcUrl} never became ready within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

async function waitForDispatchReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `waitForDispatchReady: dispatch service at ${baseUrl} never became ready within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

runIfOptedIn(
  "Feature 14 phase 2 integration (real Hardhat + real Go dispatch + real Ollama, T-1400, F-1401)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    let hardhatProcess: ChildProcessByStdio<null, Readable, Readable>;
    let hardhatStderr = "";
    let dispatchProcess: ChildProcessByStdio<null, Readable, Readable>;
    let dispatchStderr = "";
    let dispatchBinaryDir: string;
    let rpcUrl: string;
    let dispatchBaseUrl: string;
    let chainId: number;
    let ydTokenAddress: `0x${string}`;
    let escrowAddress: `0x${string}`;
    let publicClient: PublicClient;
    let ydTokenAbi: unknown;
    let escrowAbi: unknown;

    const previousEnv: Partial<Record<string, string | undefined>> = {};
    const MANAGED_ENV_KEYS = [
      "BACKEND_RPC_URL",
      "FUNDING_REQUIRED_CONFIRMATIONS",
      "CHAIN_ID",
      "YD_FAUCET_ADDRESS",
      "YD_TOKEN_ADDRESS",
      "TASK_ESCROW_ADDRESS",
      "DISPATCH_SERVICE_URL",
      "ACCEPTANCE_PERMIT_SIGNER_KEY",
      "EMBEDDING_PROVIDER",
    ] as const;

    function setManagedEnv(key: (typeof MANAGED_ENV_KEYS)[number], value: string): void {
      if (!(key in previousEnv)) {
        previousEnv[key] = process.env[key];
      }
      process.env[key] = value;
    }

    const deployer = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[0]);
    const requester = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[1]);
    const agent = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[2]);
    // `ACCEPTANCE_PERMIT_SIGNER_KEY` must derive the SAME address as the
    // deployed contract's `authorizedSigner` constructor argument
    // (`permit.service.ts`'s `verifySignerMatchesContract` doc comment) —
    // using the same key for both, exactly like `full-lifecycle`'s
    // `authorizedSigner` account, is what makes the REAL server-issued
    // permit below verifiable by the REAL deployed contract's own
    // `acceptTask`.
    const authorizedSigner = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[3]);
    const arbitrator = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[4]);
    const unrelatedUser = privateKeyToAccount(generatePrivateKey());
    void unrelatedUser;

    // Codex review (T-1402 round 1, P2): the hook's own timeout must
    // comfortably exceed the SUM of its internal budgets, not just the
    // largest one — `waitForRpcReady` and `waitForDispatchReady` each
    // allow up to 30s on their own, and migrations/`go build`/two contract
    // deployments/several transaction confirmations run on top of that. A
    // 60s hook timeout could kill this hook via Vitest's own timeout while
    // every individual step is still well within its own allowed budget,
    // producing an intermittent failure on a real but slower machine —
    // not a hang, just under-provisioned headroom.
    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
        requester.address.toLowerCase(),
        agent.address.toLowerCase(),
      ]);

      const rpcPort = await getFreePort();
      rpcUrl = `http://127.0.0.1:${rpcPort}`;
      hardhatProcess = spawn(
        path.join(contractsDir, "node_modules/.bin/hardhat"),
        ["node", "--port", String(rpcPort), "--hostname", "127.0.0.1"],
        { cwd: contractsDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      hardhatProcess.stderr.on("data", (chunk: Buffer) => {
        hardhatStderr += chunk.toString();
      });
      const hardhatSpawnErrorPromise = new Promise<never>((_resolve, reject) => {
        hardhatProcess.once("error", reject);
      });
      try {
        await Promise.race([waitForRpcReady(rpcUrl, 30_000), hardhatSpawnErrorPromise]);
      } catch (error) {
        throw new Error(`${String(error)}\nhardhat node stderr:\n${hardhatStderr}`);
      }

      // Built once, then spawned directly (Codex review, T-1400 round 1,
      // P2): `go run ./cmd/server` is a wrapper that compiles and then
      // launches the actual server as a CHILD of that wrapper process —
      // `dispatchProcess.kill()` only signals the wrapper PID, with no
      // guarantee the real server child (holding the listening port and
      // inherited stdio pipes) exits with it, risking a leaked process
      // after this suite ends. Building the binary first and spawning IT
      // directly means `dispatchProcess` below IS the real server process,
      // so `kill()` in `afterAll` terminates the actual thing holding the
      // port.
      dispatchBinaryDir = await mkdtemp(path.join(os.tmpdir(), "agent-market-dispatch-e2e-"));
      const dispatchBinaryPath = path.join(dispatchBinaryDir, "dispatch-server");
      await execFileAsync("go", ["build", "-o", dispatchBinaryPath, "./cmd/server"], {
        cwd: dispatchDir,
      });

      const dispatchPort = await getFreePort();
      dispatchBaseUrl = `http://127.0.0.1:${dispatchPort}`;
      dispatchProcess = spawn(dispatchBinaryPath, [], {
        cwd: dispatchDir,
        env: { ...process.env, DISPATCH_PORT: String(dispatchPort) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      dispatchProcess.stderr.on("data", (chunk: Buffer) => {
        dispatchStderr += chunk.toString();
      });
      const dispatchSpawnErrorPromise = new Promise<never>((_resolve, reject) => {
        dispatchProcess.once("error", reject);
      });
      try {
        await Promise.race([
          waitForDispatchReady(dispatchBaseUrl, 30_000),
          dispatchSpawnErrorPromise,
        ]);
      } catch (error) {
        throw new Error(`${String(error)}\ndispatch service stderr:\n${dispatchStderr}`);
      }
      setManagedEnv("DISPATCH_SERVICE_URL", dispatchBaseUrl);

      setManagedEnv("BACKEND_RPC_URL", rpcUrl);
      setManagedEnv("FUNDING_REQUIRED_CONFIRMATIONS", "1");
      setManagedEnv("EMBEDDING_PROVIDER", "ollama");

      publicClient = createPublicClient({ transport: http(rpcUrl) });
      chainId = await publicClient.getChainId();
      setManagedEnv("CHAIN_ID", String(chainId));
      setManagedEnv("YD_FAUCET_ADDRESS", "0x9876543210987654321098765432109876543210");

      const deployerWallet = createWalletClient({ account: deployer, transport: http(rpcUrl) });

      const ydTokenArtifact = readArtifact("artifacts/src/YDToken.sol/YDToken.json");
      ydTokenAbi = ydTokenArtifact.abi;
      const initialSupply = 10_000_000n * 10n ** 18n;
      const ydTokenDeployHash = await deployerWallet.deployContract({
        abi: ydTokenArtifact.abi as never,
        bytecode: ydTokenArtifact.bytecode,
        args: [requester.address, initialSupply],
        chain: null,
      });
      const ydTokenReceipt = await publicClient.waitForTransactionReceipt({
        hash: ydTokenDeployHash,
      });
      if (!ydTokenReceipt.contractAddress)
        throw new Error("YDToken deployment produced no address");
      ydTokenAddress = ydTokenReceipt.contractAddress;
      setManagedEnv("YD_TOKEN_ADDRESS", ydTokenAddress);

      const taskEscrowArtifact = readArtifact("artifacts/src/TaskEscrow.sol/TaskEscrow.json");
      escrowAbi = taskEscrowArtifact.abi;
      const escrowDeployHash = await deployerWallet.deployContract({
        abi: taskEscrowArtifact.abi as never,
        bytecode: taskEscrowArtifact.bytecode,
        args: [ydTokenAddress, authorizedSigner.address, REVIEW_WINDOW_SECONDS, arbitrator.address],
        chain: null,
      });
      const escrowReceipt = await publicClient.waitForTransactionReceipt({
        hash: escrowDeployHash,
      });
      if (!escrowReceipt.contractAddress)
        throw new Error("TaskEscrow deployment produced no address");
      escrowAddress = escrowReceipt.contractAddress;
      setManagedEnv("TASK_ESCROW_ADDRESS", escrowAddress);
      setManagedEnv("ACCEPTANCE_PERMIT_SIGNER_KEY", HARDHAT_ACCOUNT_KEYS[3]);

      // Fund the agent wallet with plenty of YD to stake with.
      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const transferHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "transfer",
        args: [agent.address, 1_000_000n * 10n ** 18n],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: transferHash });

      app = buildApp({ pool, logger: false });
      await app.ready();
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      hardhatProcess?.kill();
      dispatchProcess?.kill();
      if (dispatchBinaryDir) {
        await rm(dispatchBinaryDir, { recursive: true, force: true });
      }
      await pool?.query(DROP_ALL_TABLES_SQL);
      await pool?.end();
      for (const key of MANAGED_ENV_KEYS) {
        const original = previousEnv[key];
        if (original === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original;
        }
      }
    });

    async function login(account: {
      address: `0x${string}`;
      signMessage: typeof requester.signMessage;
    }): Promise<string> {
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
      if (!match?.[1]) throw new Error("login: no session_token cookie in verify response");
      return match[1];
    }

    function evidenceLog(scenario: string, data: Record<string, unknown>): void {
      console.log(
        `[T-1400 evidence] ${scenario}: ${JSON.stringify(
          data,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
          2,
        )}`,
      );
    }

    /** Polls `agent_embeddings`/`task_embeddings` until real Ollama
     * inference (fired off fire-and-forget from `POST /agents`/`POST
     * /tasks/drafts`) has actually landed a row — never assumed to have
     * already happened by the time the next HTTP call runs. */
    async function waitForRow(
      table: "agent_embeddings" | "task_embeddings",
      column: "agent_id" | "task_id",
      id: string,
      timeoutMs = 30_000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(
        `waitForRow: no real Ollama embedding appeared in ${table} for ${column}=${id} within ${timeoutMs}ms — ` +
          "is a real Ollama serving bge-m3:latest reachable at OLLAMA_BASE_URL (default http://127.0.0.1:11434)?",
      );
    }

    it("F-1401 real end-to-end: publish → real bge-m3 recall/match → accept+stake → deliver → settle", async () => {
      // ---------------------------------------------------------------
      // Step 1: real Agent creation (F-1201 fields: protocolVersion),
      // category deliberately DIFFERENT from the task below (see file
      // header — this is Feature 13's own verified golden-sample pair
      // #3, real cosine similarity 0.6917).
      // ---------------------------------------------------------------
      const agentSessionToken = await login(agent);
      const createAgentResponse = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: agentSessionToken },
        payload: {
          name: "T-1400 英语电商文案编辑",
          description: "英语母语文案编辑，擅长电商营销文案与产品描述本地化",
          category: "writing",
          skillTags: ["英语文案", "本地化", "电商"],
          payoutAddress: agent.address,
          protocolVersion: "v1",
        },
      });
      expect(createAgentResponse.statusCode).toBe(201);
      const agentId = (createAgentResponse.json() as { agentId: string }).agentId;

      await waitForRow("agent_embeddings", "agent_id", agentId);

      // ---------------------------------------------------------------
      // Step 2: real Task draft creation (F-1205 field: expertType),
      // category `translation` — an exact-match miss against the Agent's
      // `writing` category, so any recommendation below can ONLY have
      // come from F-1305's real semantic-widening OR-branch.
      // ---------------------------------------------------------------
      const requesterSessionToken = await login(requester);
      const deliveryDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const budget = (1_000n * 10n ** 18n).toString();
      const createDraftResponse = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: requesterSessionToken },
        headers: { "idempotency-key": `t-1400-draft-${Date.now()}` },
        payload: {
          category: "translation",
          skillTags: ["中译英", "电商"],
          title: "T-1400 跨境电商产品说明书翻译",
          description: "为跨境电商网站翻译产品说明书，中文译为英文，语气需符合海外消费者习惯",
          budget,
          deliveryDeadline,
          expertType: "CONTENT_GENERATION",
        },
      });
      expect(createDraftResponse.statusCode).toBe(201);
      const taskId = (createDraftResponse.json() as { taskId: string }).taskId;

      await waitForRow("task_embeddings", "task_id", taskId);

      // ---------------------------------------------------------------
      // Step 3: real funding — funding-intent, real on-chain approve +
      // createTask against the real deployed TaskEscrow, then
      // funding-verifications re-derives OPEN status from the real chain
      // event (never trusts the client-reported status alone).
      // ---------------------------------------------------------------
      const intentResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-intent`,
        cookies: { session_token: requesterSessionToken },
      });
      expect(intentResponse.statusCode).toBe(200);
      const intent = intentResponse.json() as {
        contractAddress: `0x${string}`;
        token: `0x${string}`;
        budget: string;
        deliveryDeadline: number;
        taskIdOnChain: `0x${string}`;
      };
      expect(intent.contractAddress.toLowerCase()).toBe(escrowAddress.toLowerCase());

      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const approveHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "approve",
        args: [escrowAddress, BigInt(intent.budget)],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const createTaskHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "createTask",
        args: [
          intent.taskIdOnChain,
          intent.token,
          BigInt(intent.budget),
          BigInt(intent.deliveryDeadline),
        ],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

      const fundingVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-verifications`,
        cookies: { session_token: requesterSessionToken },
        payload: { txHash: createTaskHash },
      });
      expect(fundingVerifyResponse.statusCode).toBe(200);
      expect((fundingVerifyResponse.json() as { status: string }).status).toBe("OPEN");

      // ---------------------------------------------------------------
      // Step 4: real match — a real spawned Go dispatch process, real
      // pgvector cosine similarity computed from the two real Ollama
      // embeddings above, real eligibility.Filter.
      // ---------------------------------------------------------------
      const matchResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: requesterSessionToken },
      });
      expect(matchResponse.statusCode).toBe(200);
      const matchBody = matchResponse.json() as {
        taskId: string;
        algorithmVersion: string;
        recommendationCount: number;
      };
      // The real, live proof this is genuinely exercising F-1305: a
      // "v0.1" run would never recommend this Agent at all (different
      // category, no exact match) — algorithmVersion MUST be "v0.2" for
      // any recommendation to exist below.
      expect(matchBody.algorithmVersion).toBe("v0.2");
      expect(matchBody.recommendationCount).toBeGreaterThan(0);
      expect(matchBody.recommendationCount).toBeLessThanOrEqual(3);

      const recommendationsResponse = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}/recommendations`,
      });
      expect(recommendationsResponse.statusCode).toBe(200);
      const recommendations = (
        recommendationsResponse.json() as {
          recommendations: { agentId: string; rank: number; slotType: string; score: number }[];
        }
      ).recommendations;
      const ourRecommendation = recommendations.find((r) => r.agentId === agentId);
      expect(ourRecommendation).toBeDefined();

      // Real DB check: the persisted candidate row carries the REAL
      // semantic similarity Feature 13's own bge-m3 pipeline computed —
      // not a placeholder, and above the real 0.64 threshold. Also asserts
      // the real persisted `reputation_signals` digest (Codex review,
      // T-1404 round 1, P2: the whiteboard matrix cited this as tested
      // evidence before any test here actually queried the column —
      // fixed by adding this real assertion rather than softening the
      // doc's claim, since the underlying persistence genuinely happens on
      // this v0.2 run).
      const { rows: candidateRows } = await pool.query<{
        semantic_similarity: string | null;
        algorithm_version: string;
        reputation_signals: {
          completionRate: { value: number; sampleSize: number };
          qualityFeedback: { value: number; sampleSize: number };
          communication: { value: number; sampleSize: number };
          disputeSignal: { value: number; sampleSize: number };
          historicalScale: { value: number; sampleSize: number };
        } | null;
      }>(
        `SELECT rc.semantic_similarity, rr.algorithm_version, rc.reputation_signals
             FROM recommendation_candidates rc
             JOIN recommendation_runs rr ON rr.id = rc.run_id
            WHERE rr.task_id = $1 AND rc.agent_id = $2
            ORDER BY rr.requested_at DESC LIMIT 1`,
        [taskId, agentId],
      );
      const candidateRow = candidateRows[0];
      expect(candidateRow).toBeDefined();
      expect(candidateRow?.algorithm_version).toBe("v0.2");
      const semanticSimilarity = Number(candidateRow?.semantic_similarity);
      expect(semanticSimilarity).toBeGreaterThanOrEqual(0.64);

      const reputationSignals = candidateRow?.reputation_signals;
      expect(reputationSignals).toBeDefined();
      expect(reputationSignals).not.toBeNull();
      for (const key of [
        "completionRate",
        "qualityFeedback",
        "communication",
        "disputeSignal",
        "historicalScale",
      ] as const) {
        // `value` is legitimately `number | null` (repository.ts's
        // `ReputationSignalDigestEntry`) — this Agent is brand new with no
        // settled task history yet, so `null` here is the real, expected
        // value, not a missing-data bug.
        const entry = reputationSignals?.[key];
        expect(entry?.value === null || typeof entry?.value === "number").toBe(true);
        expect(typeof entry?.sampleSize).toBe("number");
      }

      // ---------------------------------------------------------------
      // Step 5: real accept — server-issued permit via the real HTTP
      // permit endpoints (never hand-signed in-test), then a real
      // on-chain acceptTask the real deployed contract itself verifies.
      // ---------------------------------------------------------------
      const issuePermitsResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/acceptance-permits`,
        cookies: { session_token: requesterSessionToken },
      });
      expect(issuePermitsResponse.statusCode).toBe(200);

      const permitResponse = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}/agents/${agentId}/acceptance-permit`,
        cookies: { session_token: agentSessionToken },
      });
      expect(permitResponse.statusCode).toBe(200);
      const permitJson = permitResponse.json() as {
        agentWalletAddress: `0x${string}`;
        nonce: string;
        expiry: number;
        chainId: number;
        verifyingContract: `0x${string}`;
        signature: `0x${string}`;
      };
      expect(permitJson.agentWalletAddress.toLowerCase()).toBe(agent.address.toLowerCase());
      expect(permitJson.verifyingContract.toLowerCase()).toBe(escrowAddress.toLowerCase());

      const permit = {
        taskId: intent.taskIdOnChain,
        agent: permitJson.agentWalletAddress,
        nonce: BigInt(permitJson.nonce),
        expiry: BigInt(permitJson.expiry),
        chainId: BigInt(permitJson.chainId),
        verifyingContract: permitJson.verifyingContract,
      };

      const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });
      const agentStakeApproveHash = await agentWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "approve",
        args: [escrowAddress, BigInt(intent.budget)],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: agentStakeApproveHash });

      const acceptTaskHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "acceptTask",
        args: [permit, permitJson.signature],
        chain: null,
        account: agent,
      });
      const acceptReceipt = await publicClient.waitForTransactionReceipt({
        hash: acceptTaskHash,
      });
      expect(acceptReceipt.status).toBe("success");

      const acceptanceVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/acceptance-verifications`,
        cookies: { session_token: agentSessionToken },
        payload: { txHash: acceptTaskHash },
      });
      expect(acceptanceVerifyResponse.statusCode).toBe(200);
      expect((acceptanceVerifyResponse.json() as { status: string }).status).toBe("ACCEPTED");

      const onChainTask = (await publicClient.readContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "getTask",
        args: [intent.taskIdOnChain],
      })) as { stake: bigint };

      // ---------------------------------------------------------------
      // Step 6: real deliver — real on-chain submitResult, verified via
      // the real result-verifications route.
      // ---------------------------------------------------------------
      const resultHash: `0x${string}` = keccak256(toBytes(`t-1400-result-${taskId}`));
      const submitResultHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "submitResult",
        args: [intent.taskIdOnChain, resultHash],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: submitResultHash });

      const resultVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/result-verifications`,
        cookies: { session_token: agentSessionToken },
        payload: { txHash: submitResultHash },
      });
      expect(resultVerifyResponse.statusCode).toBe(200);
      expect((resultVerifyResponse.json() as { status: string }).status).toBe("SUBMITTED");

      // ---------------------------------------------------------------
      // Step 7: real settle (normal branch) — real on-chain
      // approveResult pays budget+stake to the real agent wallet.
      // ---------------------------------------------------------------
      const agentBalanceBefore = (await publicClient.readContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "balanceOf",
        args: [agent.address],
      })) as bigint;

      const approveResultHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "approveResult",
        args: [intent.taskIdOnChain],
        chain: null,
        account: requester,
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveResultHash,
      });
      expect(approveReceipt.status).toBe("success");

      const settlementVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/settlement-verifications`,
        cookies: { session_token: requesterSessionToken },
        payload: { txHash: approveResultHash },
      });
      expect(settlementVerifyResponse.statusCode).toBe(200);
      expect((settlementVerifyResponse.json() as { status: string }).status).toBe("RELEASED");

      const agentBalanceAfter = (await publicClient.readContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "balanceOf",
        args: [agent.address],
      })) as bigint;
      expect(agentBalanceAfter - agentBalanceBefore).toBe(
        BigInt(intent.budget) + onChainTask.stake,
      );

      // ---------------------------------------------------------------
      // AC-1401: recommendation/acceptance/settlement records all
      // queryable in the real DB.
      // ---------------------------------------------------------------
      const { rows: taskRows } = await pool.query<{
        status: string;
        accepted_agent_id: string | null;
      }>(`SELECT status, accepted_agent_id FROM tasks WHERE id = $1`, [taskId]);
      expect(taskRows[0]?.status).toBe("RELEASED");
      expect(taskRows[0]?.accepted_agent_id).toBe(agentId);

      const { rows: permitRows } = await pool.query<{ status: string }>(
        `SELECT status FROM acceptance_permits WHERE task_id = $1 AND agent_id = $2`,
        [taskId, agentId],
      );
      expect(permitRows[0]?.status).toBe("CONSUMED");

      const { rows: agentRows } = await pool.query<{
        completed_task_count: number;
        success_count: number;
      }>(`SELECT completed_task_count, success_count FROM agents WHERE id = $1`, [agentId]);
      expect(agentRows[0]).toEqual({ completed_task_count: 1, success_count: 1 });

      evidenceLog("F-1401 real end-to-end", {
        taskId,
        taskIdOnChain: intent.taskIdOnChain,
        agentId,
        requesterAddress: requester.address,
        agentAddress: agent.address,
        algorithmVersion: matchBody.algorithmVersion,
        realSemanticSimilarity: semanticSimilarity,
        persistedReputationSignals: reputationSignals,
        acceptTaskHash,
        submitResultHash,
        approveResultHash,
        budget: intent.budget,
        stake: onChainTask.stake,
        agentBalanceBefore,
        agentBalanceAfter,
        finalTaskStatus: "RELEASED",
      });
    }, 120_000);

    /** Asserts NO row exists in `table` for `column = id` after a fixed
     * settle window — the deliberate mirror of `waitForRow` above (which
     * asserts eventual presence): `embedAgentOnSave`/`embedTaskOnSave` are
     * fire-and-forget, so proving absence requires waiting long enough for
     * a genuine failure to have already been swallowed, not polling until
     * a timeout (there is nothing to eventually appear). A plain refused
     * TCP connection (no listener on the port at all) fails near-
     * instantly — well under `ollama-provider.ts`'s own 15s request
     * timeout — so 3s is a comfortable real margin, not a race.
     */
    async function assertNoRowAppears(
      table: "agent_embeddings" | "task_embeddings",
      column: "agent_id" | "task_id",
      id: string,
    ): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
      expect(rows.length).toBe(0);
    }

    it("F-1402 real vector-provider-unavailable degrade: /match still succeeds, falls back to v0.1, candidate set matches pure category-match behavior", async () => {
      const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
      // A port nothing is listening on (never bound below) — a real
      // connection-refused failure, not a mocked provider.
      const unreachablePort = await getFreePort();
      process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${unreachablePort}`;

      try {
        const agentSessionToken = await login(agent);
        const createAgentResponse = await app.inject({
          method: "POST",
          url: "/agents",
          cookies: { session_token: agentSessionToken },
          payload: {
            name: "T-1401 Python 自动化脚本工程师",
            description: "编写 Python 自动化脚本，处理定时任务与数据抓取",
            category: "programming",
            skillTags: ["Python", "自动化"],
            payoutAddress: agent.address,
            protocolVersion: "v1",
          },
        });
        expect(createAgentResponse.statusCode).toBe(201);
        const degradedAgentId = (createAgentResponse.json() as { agentId: string }).agentId;

        const requesterSessionToken = await login(requester);
        const deliveryDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const budget = (500n * 10n ** 18n).toString();
        const createDraftResponse = await app.inject({
          method: "POST",
          url: "/tasks/drafts",
          cookies: { session_token: requesterSessionToken },
          headers: { "idempotency-key": `t-1401-f1402-draft-${Date.now()}` },
          payload: {
            category: "programming",
            skillTags: ["Python", "自动化"],
            title: "T-1401 Python 定时抓取脚本开发",
            description: "开发一个 Python 自动化脚本，定时抓取数据并写入数据库",
            budget,
            deliveryDeadline,
            expertType: "AUTOMATION",
          },
        });
        expect(createDraftResponse.statusCode).toBe(201);
        const degradedTaskId = (createDraftResponse.json() as { taskId: string }).taskId;

        // Real proof the failure genuinely happened (Ollama unreachable),
        // not merely that this test skipped waiting for it.
        await assertNoRowAppears("agent_embeddings", "agent_id", degradedAgentId);
        await assertNoRowAppears("task_embeddings", "task_id", degradedTaskId);

        const intentResponse = await app.inject({
          method: "POST",
          url: `/tasks/${degradedTaskId}/funding-intent`,
          cookies: { session_token: requesterSessionToken },
        });
        expect(intentResponse.statusCode).toBe(200);
        const intent = intentResponse.json() as {
          token: `0x${string}`;
          budget: string;
          deliveryDeadline: number;
          taskIdOnChain: `0x${string}`;
        };

        const requesterWallet = createWalletClient({
          account: requester,
          transport: http(rpcUrl),
        });
        const approveHash = await requesterWallet.writeContract({
          address: ydTokenAddress,
          abi: ydTokenAbi as never,
          functionName: "approve",
          args: [escrowAddress, BigInt(intent.budget)],
          chain: null,
          account: requester,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        const createTaskHash = await requesterWallet.writeContract({
          address: escrowAddress,
          abi: escrowAbi as never,
          functionName: "createTask",
          args: [
            intent.taskIdOnChain,
            intent.token,
            BigInt(intent.budget),
            BigInt(intent.deliveryDeadline),
          ],
          chain: null,
          account: requester,
        });
        await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

        const fundingVerifyResponse = await app.inject({
          method: "POST",
          url: `/tasks/${degradedTaskId}/funding-verifications`,
          cookies: { session_token: requesterSessionToken },
          payload: { txHash: createTaskHash },
        });
        expect(fundingVerifyResponse.statusCode).toBe(200);

        // Real match call — still against the real spawned Go dispatch
        // process, but with a genuinely unreachable Embedding Provider.
        const matchResponse = await app.inject({
          method: "POST",
          url: `/tasks/${degradedTaskId}/match`,
          cookies: { session_token: requesterSessionToken },
        });
        expect(matchResponse.statusCode).toBe(200);
        const matchBody = matchResponse.json() as {
          algorithmVersion: string;
          recommendationCount: number;
        };
        // AC-1402: 撮合请求仍然成功、algorithmVersion 正确回退为 v0.1.
        expect(matchBody.algorithmVersion).toBe("v0.1");
        expect(matchBody.recommendationCount).toBeGreaterThan(0);

        const recommendationsResponse = await app.inject({
          method: "GET",
          url: `/tasks/${degradedTaskId}/recommendations`,
        });
        const recommendations = (
          recommendationsResponse.json() as { recommendations: { agentId: string }[] }
        ).recommendations;
        // AC-1402: 候选集合与关闭向量功能前的 v0.1 行为一致——纯分类精确匹配即可
        // 找到这个候选，全程未依赖任何向量信号。
        expect(recommendations.some((r) => r.agentId === degradedAgentId)).toBe(true);

        const { rows: candidateRows } = await pool.query<{
          semantic_similarity: string | null;
          algorithm_version: string;
        }>(
          `SELECT rc.semantic_similarity, rr.algorithm_version
               FROM recommendation_candidates rc
               JOIN recommendation_runs rr ON rr.id = rc.run_id
              WHERE rr.task_id = $1 AND rc.agent_id = $2
              ORDER BY rr.requested_at DESC LIMIT 1`,
          [degradedTaskId, degradedAgentId],
        );
        expect(candidateRows[0]?.algorithm_version).toBe("v0.1");
        expect(candidateRows[0]?.semantic_similarity).toBeNull();

        evidenceLog("F-1402 real vector-provider-unavailable degrade", {
          taskId: degradedTaskId,
          agentId: degradedAgentId,
          unreachableOllamaBaseUrl: process.env.OLLAMA_BASE_URL,
          algorithmVersion: matchBody.algorithmVersion,
          recommendationCount: matchBody.recommendationCount,
        });
      } finally {
        if (previousOllamaBaseUrl === undefined) {
          delete process.env.OLLAMA_BASE_URL;
        } else {
          process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
        }
      }
    }, 60_000);

    it("F-1403 real eligibility-bypass-proof: a genuinely high-similarity but banned candidate is still excluded from recommendations", async () => {
      // Same real, already-verified-high-similarity cross-category pair
      // T-1400's own scenario uses (golden sample #3, real cosine
      // similarity ~0.699 against a `translation` task) — reused
      // deliberately so a real Ollama inference genuinely clears the
      // v0.2 semantic OR-branch's category-relatedness condition, making
      // this test a real proof of condition 7 (ban list) independently
      // eliminating the candidate, not a fabricated high score.
      const bannedOwner = privateKeyToAccount(generatePrivateKey());
      const bannedOwnerSessionToken = await login(bannedOwner);
      const createAgentResponse = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: bannedOwnerSessionToken },
        payload: {
          name: "T-1401 已封禁的英语电商文案编辑",
          description: "英语母语文案编辑，擅长电商营销文案与产品描述本地化",
          category: "writing",
          skillTags: ["英语文案", "本地化", "电商"],
          payoutAddress: bannedOwner.address,
          protocolVersion: "v1",
        },
      });
      expect(createAgentResponse.statusCode).toBe(201);
      const bannedAgentId = (createAgentResponse.json() as { agentId: string }).agentId;
      await waitForRow("agent_embeddings", "agent_id", bannedAgentId);

      await pool.query(
        `INSERT INTO blocked_wallets (address, reason) VALUES ($1, 'T-1401 F-1403 real eligibility-bypass-proof test')`,
        [bannedOwner.address.toLowerCase()],
      );

      const requesterSessionToken = await login(requester);
      const deliveryDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const budget = (500n * 10n ** 18n).toString();
      const createDraftResponse = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: requesterSessionToken },
        headers: { "idempotency-key": `t-1401-f1403-draft-${Date.now()}` },
        payload: {
          category: "translation",
          skillTags: ["中译英", "电商"],
          title: "T-1401 F-1403 跨境电商产品说明书翻译",
          description: "为跨境电商网站翻译产品说明书，中文译为英文，语气需符合海外消费者习惯",
          budget,
          deliveryDeadline,
          expertType: "CONTENT_GENERATION",
        },
      });
      expect(createDraftResponse.statusCode).toBe(201);
      const taskId = (createDraftResponse.json() as { taskId: string }).taskId;
      await waitForRow("task_embeddings", "task_id", taskId);

      const intentResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-intent`,
        cookies: { session_token: requesterSessionToken },
      });
      expect(intentResponse.statusCode).toBe(200);
      const intent = intentResponse.json() as {
        token: `0x${string}`;
        budget: string;
        deliveryDeadline: number;
        taskIdOnChain: `0x${string}`;
      };

      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const approveHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenAbi as never,
        functionName: "approve",
        args: [escrowAddress, BigInt(intent.budget)],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const createTaskHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: escrowAbi as never,
        functionName: "createTask",
        args: [
          intent.taskIdOnChain,
          intent.token,
          BigInt(intent.budget),
          BigInt(intent.deliveryDeadline),
        ],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

      const fundingVerifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/funding-verifications`,
        cookies: { session_token: requesterSessionToken },
        payload: { txHash: createTaskHash },
      });
      expect(fundingVerifyResponse.statusCode).toBe(200);

      const matchResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/match`,
        cookies: { session_token: requesterSessionToken },
      });
      expect(matchResponse.statusCode).toBe(200);
      const matchBody = matchResponse.json() as { algorithmVersion: string };
      // v0.2 must still be reachable (real embeddings present on both
      // sides) — otherwise this test would prove nothing about the
      // semantic OR-branch specifically.
      expect(matchBody.algorithmVersion).toBe("v0.2");

      // Codex review (T-1401 round 1, P2): the exclusion assertion below,
      // on its own, cannot distinguish "excluded because it's banned" from
      // "excluded because it never actually cleared the real 0.64
      // similarity threshold in the first place" — a false-positive path
      // if the model/pipeline ever drifted. Query the EXACT same real
      // pgvector cosine computation `getTaskSimilarityByAgentId`
      // (repository.ts) uses and assert it independently, so this test
      // proves the ban specifically did the excluding, not a coincidental
      // eligibility miss on a different condition.
      const { rows: similarityRows } = await pool.query<{ similarity: number }>(
        `SELECT 1 - (ae.embedding <=> te.embedding) AS similarity
           FROM task_embeddings te, agent_embeddings ae
          WHERE te.task_id = $1 AND ae.agent_id = $2`,
        [taskId, bannedAgentId],
      );
      const bannedCandidateSimilarity = similarityRows[0]?.similarity;
      expect(bannedCandidateSimilarity).toBeGreaterThanOrEqual(0.64);

      const recommendationsResponse = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}/recommendations`,
      });
      const recommendations = (
        recommendationsResponse.json() as { recommendations: { agentId: string }[] }
      ).recommendations;
      // AC-1403: 语义相似度无法让不合格候选进入最终推荐名单——the banned wallet's
      // Agent must be genuinely absent despite a real similarity score
      // (asserted above) that independently clears the semantic
      // OR-branch's own threshold.
      expect(recommendations.some((r) => r.agentId === bannedAgentId)).toBe(false);

      evidenceLog("F-1403 real eligibility-bypass-proof", {
        taskId,
        bannedAgentId,
        bannedWalletAddress: bannedOwner.address,
        bannedCandidateRealSemanticSimilarity: bannedCandidateSimilarity,
        algorithmVersion: matchBody.algorithmVersion,
        recommendedAgentIds: recommendations.map((r) => r.agentId),
      });
    }, 60_000);

    /** Same `listen()` shape `invocation-client.test.ts` and
     * `invocation-test-route.integration.test.ts` already use — a real
     * local HTTP server, closable independently per test rather than
     * shared mutable state across `it()` blocks. */
    function listen(
      handler: RequestListener,
    ): Promise<{ url: string; close: () => Promise<void> }> {
      return new Promise((resolve) => {
        const server: Server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address && typeof address === "object") {
            resolve({
              url: `http://127.0.0.1:${address.port}`,
              close: () => new Promise<void>((res) => server.close(() => res())),
            });
          }
        });
      });
    }

    it("F-1404 real credential redaction across save/invoke/failure paths — the raw secret never appears in any observed output", async () => {
      const FIXTURE_CREDENTIAL_VALUE = "t1402-fixture-real-secret-do-not-leak-7c4e1a";

      // --- 保存路径 ---
      const credentialOwner = privateKeyToAccount(generatePrivateKey());
      const ownerSessionToken = await login(credentialOwner);
      const createAgentResponse = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: ownerSessionToken },
        payload: {
          name: "T-1402 凭据脱敏测试 Agent",
          description: "用于验证真实密钥不会出现在任何可观测输出中",
          category: "automation",
          payoutAddress: credentialOwner.address,
          protocolVersion: "v1",
          credentialEnabled: true,
          invocationUrl: "http://127.0.0.1:1/unreachable",
        },
      });
      expect(createAgentResponse.statusCode).toBe(201);
      expect(createAgentResponse.body).not.toContain(FIXTURE_CREDENTIAL_VALUE);
      const credentialAgentId = (createAgentResponse.json() as { agentId: string }).agentId;
      const envVarName = `AGENT_${credentialAgentId.replace(/-/g, "").toUpperCase()}`;
      // Set only AFTER creation — the reference string
      // (`computeCredentialRef`) is deterministic from the real agentId,
      // so the real secret value never needs to exist in this process's
      // env before that id is known.
      process.env[envVarName] = FIXTURE_CREDENTIAL_VALUE;

      try {
        const getAgentResponse = await app.inject({
          method: "GET",
          url: `/agents/${credentialAgentId}`,
          cookies: { session_token: ownerSessionToken },
        });
        expect(getAgentResponse.statusCode).toBe(200);
        expect(getAgentResponse.body).not.toContain(FIXTURE_CREDENTIAL_VALUE);
        expect((getAgentResponse.json() as { credentialRef: string }).credentialRef).toBe(
          `env://${envVarName}`,
        );

        // --- 失败路径（经真实 HTTP 路由）：invocationUrl 不是 https，真实路由在
        // 解析凭据前拒绝——响应体不可能包含真实密钥. ---
        const routeFailureResponse = await app.inject({
          method: "POST",
          url: `/agents/${credentialAgentId}/invocation-test`,
          cookies: { session_token: ownerSessionToken },
          payload: { payload: { probe: true } },
        });
        expect(routeFailureResponse.statusCode).toBe(200);
        const routeFailureBody = routeFailureResponse.json() as {
          ok: boolean;
          reason?: string;
        };
        expect(routeFailureBody.ok).toBe(false);
        expect(routeFailureBody.reason).toBe("network_error");
        expect(routeFailureResponse.body).not.toContain(FIXTURE_CREDENTIAL_VALUE);

        // --- 调用路径（真实网络）：复用 Feature 12 已建立的测试手法
        // （invocation-client.test.ts）——`skipDestinationCheck` 只跳过目的地
        // 安全检查这一项，凭据解析/真实 HTTPS 风格请求/幂等 key 全部走真实代码
        // 路径，未 mock 任何一步。 ---
        let receivedAuth: string | undefined;
        const successServer = await listen((req, res) => {
          receivedAuth = req.headers.authorization;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ echoed: true }));
        });
        let successResult: unknown;
        try {
          successResult = await callAgent(
            { invocationUrl: successServer.url, credentialRef: `env://${envVarName}` },
            { probe: true },
            { skipDestinationCheck: true },
          );
        } finally {
          await successServer.close();
        }
        expect(successResult).toEqual({ ok: true, statusCode: 200, body: { echoed: true } });
        // Real proof credential resolution genuinely happened (not
        // stubbed) — the receiving server saw the real secret — AND the
        // client-side result never echoes it back.
        expect(receivedAuth).toBe(`Bearer ${FIXTURE_CREDENTIAL_VALUE}`);
        expect(JSON.stringify(successResult)).not.toContain(FIXTURE_CREDENTIAL_VALUE);

        // --- 失败路径（真实网络）：外部服务返回非 2xx，且响应体本身就试图回显
        // Authorization 头——即便如此，客户端结果也绝不能包含真实密钥. ---
        const failureServer = await listen((req, res) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ echoedAuth: req.headers.authorization }));
        });
        let failureResult: unknown;
        try {
          failureResult = await callAgent(
            { invocationUrl: failureServer.url, credentialRef: `env://${envVarName}` },
            { probe: true },
            { skipDestinationCheck: true },
          );
        } finally {
          await failureServer.close();
        }
        expect((failureResult as { ok: boolean }).ok).toBe(false);
        expect(JSON.stringify(failureResult)).not.toContain(FIXTURE_CREDENTIAL_VALUE);

        evidenceLog("F-1404 real credential redaction", {
          credentialAgentId,
          envVarName,
          getAgentBodyLeaked: getAgentResponse.body.includes(FIXTURE_CREDENTIAL_VALUE),
          routeFailureBodyLeaked: routeFailureResponse.body.includes(FIXTURE_CREDENTIAL_VALUE),
          successResultLeaked: JSON.stringify(successResult).includes(FIXTURE_CREDENTIAL_VALUE),
          failureResultLeaked: JSON.stringify(failureResult).includes(FIXTURE_CREDENTIAL_VALUE),
        });
      } finally {
        delete process.env[envVarName];
      }
    }, 30_000);

    it("F-1405 real idempotency: task creation rejects a same-key-different-payload conflict (T-609), and Agent invocation genuinely mints a fresh key per real call (AC-1204)", async () => {
      // --- (a) 任务创建幂等（复用一期已有的幂等测试，本 Feature 端到端场景里
      // 再跑一次；同时确认 Feature 6 T-609 修复后同 key/不同 payload 真实 409）---
      const requesterSessionToken = await login(requester);
      const idempotencyKey = `t-1402-f1405-${Date.now()}`;
      const deliveryDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const draftPayload = {
        category: "research",
        skillTags: ["市场调研"],
        title: "T-1402 F-1405 幂等测试任务",
        description: "验证同一 Idempotency-Key 重复请求的真实行为",
        budget: (100n * 10n ** 18n).toString(),
        deliveryDeadline,
        expertType: "RESEARCH",
      };

      const firstResponse = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: requesterSessionToken },
        headers: { "idempotency-key": idempotencyKey },
        payload: draftPayload,
      });
      expect(firstResponse.statusCode).toBe(201);
      const firstTaskId = (firstResponse.json() as { taskId: string }).taskId;

      // 同 key + 相同 payload → 真实回放，返回同一个 taskId，不产生新记录。
      const replayResponse = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: requesterSessionToken },
        headers: { "idempotency-key": idempotencyKey },
        payload: draftPayload,
      });
      expect(replayResponse.statusCode).toBe(201);
      expect((replayResponse.json() as { taskId: string }).taskId).toBe(firstTaskId);

      const { rows: sameKeyRows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tasks WHERE requester_address = $1 AND idempotency_key = $2`,
        [requester.address.toLowerCase(), idempotencyKey],
      );
      expect(sameKeyRows[0]?.count).toBe("1");

      // 同 key + 不同 payload（budget 不同）→ Feature 6 T-609 修复后真实 409
      // IDEMPOTENCY_KEY_CONFLICT，不静默丢弃、不误判为回放成功。
      const conflictResponse = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: requesterSessionToken },
        headers: { "idempotency-key": idempotencyKey },
        payload: { ...draftPayload, budget: (200n * 10n ** 18n).toString() },
      });
      expect(conflictResponse.statusCode).toBe(409);
      expect((conflictResponse.json() as { error: { code: string } }).error.code).toBe(
        "IDEMPOTENCY_KEY_CONFLICT",
      );

      const { rows: afterConflictRows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tasks WHERE requester_address = $1 AND idempotency_key = $2`,
        [requester.address.toLowerCase(), idempotencyKey],
      );
      expect(afterConflictRows[0]?.count).toBe("1");

      // --- (b) Agent 调用侧幂等——AC-1204 的真实保证是"每次真实调用都携带一个
      // 非空、彼此不同的 Idempotency-Key"，不是"客户端提供 key 可重放去重"（一期
      // 未实现、也未承诺后者）。经用户明确确认：本场景验证前者，而非编造一个
      // 规格本身不保证的客户端重放测试。 ---
      const invocationOwner = privateKeyToAccount(generatePrivateKey());
      const invocationOwnerSessionToken = await login(invocationOwner);
      const FIXTURE_CREDENTIAL_VALUE = "t1402-f1405-fixture-real-secret-do-not-leak-2b9f";
      const createAgentResponse = await app.inject({
        method: "POST",
        url: "/agents",
        cookies: { session_token: invocationOwnerSessionToken },
        payload: {
          name: "T-1402 F-1405 幂等 key 测试 Agent",
          description: "用于验证真实调用每次生成不同的 Idempotency-Key",
          category: "automation",
          payoutAddress: invocationOwner.address,
          protocolVersion: "v1",
          credentialEnabled: true,
        },
      });
      expect(createAgentResponse.statusCode).toBe(201);
      const invocationAgentId = (createAgentResponse.json() as { agentId: string }).agentId;
      const invocationEnvVarName = `AGENT_${invocationAgentId.replace(/-/g, "").toUpperCase()}`;
      process.env[invocationEnvVarName] = FIXTURE_CREDENTIAL_VALUE;

      try {
        const receivedKeys: (string | undefined)[] = [];
        const keyServer = await listen((req, res) => {
          receivedKeys.push(req.headers["idempotency-key"] as string | undefined);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
        try {
          await callAgent(
            { invocationUrl: keyServer.url, credentialRef: `env://${invocationEnvVarName}` },
            { probe: "same logical payload" },
            { skipDestinationCheck: true },
          );
          await callAgent(
            { invocationUrl: keyServer.url, credentialRef: `env://${invocationEnvVarName}` },
            { probe: "same logical payload" },
            { skipDestinationCheck: true },
          );
        } finally {
          await keyServer.close();
        }

        expect(receivedKeys).toHaveLength(2);
        expect(receivedKeys[0]).toBeTruthy();
        expect(receivedKeys[1]).toBeTruthy();
        expect(receivedKeys[0]).not.toBe(receivedKeys[1]);

        evidenceLog("F-1405 real idempotency", {
          taskCreationFirstTaskId: firstTaskId,
          taskCreationConflictErrorCode: "IDEMPOTENCY_KEY_CONFLICT",
          invocationAgentId,
          invocationIdempotencyKeys: receivedKeys,
        });
      } finally {
        delete process.env[invocationEnvVarName];
      }
    }, 30_000);
  },
);
