import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../app.js";
import { runMigrations } from "../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../modules/auth/signInMessage.js";
import { findResultSubmittedLog } from "@agent-market/domain";
import type { RawEventLog } from "@agent-market/domain";

/**
 * T-906 — Feature 9's own designated high-risk N6 acceptance test
 * (specs/09-deliverable-submission/tasks.md; the user's Feature 9
 * authorization explicitly required "真实 Hardhat 验证，确认文件内容哈希 =
 * DB resultHash = 链上事件 resultHash，以及 reviewDeadline 逐字节匹配事件").
 *
 * This is a genuinely real end-to-end run, not a simulation: a real
 * `hardhat node` JSON-RPC server is spawned as a child process, real
 * `YDToken`/`TaskEscrow` contracts are deployed to it from this repo's own
 * compiled artifacts, a real task is created/accepted/funded on that
 * chain, a real file is uploaded through this backend's own real HTTP
 * routes (`app.inject()`, `buildApp()` — the exact same Fastify app
 * `server.ts` runs), a real `submitResult` transaction is signed and
 * broadcast, and the real `POST /tasks/:taskId/result-verifications`
 * route (createChainRpcClient() pointed at the real spawned node) is what
 * actually performs the event-sync this test verifies — nothing here is a
 * fake `ChainRpcClient` or a hand-constructed event log.
 *
 * Layered opt-in, on top of the existing `RUN_DB_INTEGRATION_TESTS=1` +
 * `TEST_DATABASE_URL` gate: `RUN_HARDHAT_E2E_TESTS=1`. Spawning a real
 * JSON-RPC server and deploying real contracts is materially heavier and
 * slower than this project's other DB-only integration tests, and — per
 * this Feature's own documented risk note ("若 CI 环境搭建 Hardhat 节点有困
 * 难，需在交付记录中说明替代验证方式及其局限性") — may not be reliably
 * available in every CI environment (subprocess spawning, a free TCP
 * port, the `contracts` package's compiled `artifacts/` already present
 * via `pnpm --filter @agent-market/contracts compile`). It therefore does
 * NOT run as part of the default `pnpm test`/CI `RUN_DB_INTEGRATION_TESTS=1`
 * pass — it requires this additional, explicit human opt-in, matching this
 * project's established "risky infra needs its own opt-in" convention
 * (db/migrate.integration.test.ts's own header comment). The regular
 * `RUN_DB_INTEGRATION_TESTS=1` suite already covers this Feature's own
 * logic with fast, deterministic fake-RPC tests — this suite exists
 * specifically to catch anything only a REAL chain could ever surface
 * (real ABI encoding/decoding drift, a real contract revert this repo's
 * hand-written ABI fragments got subtly wrong, a real confirmation-timing
 * edge case).
 */
const runIfOptedIn =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_HARDHAT_E2E_TESTS === "1"
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

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, schema_migrations CASCADE";

// Hardhat Network's well-known default accounts (deterministic — the
// standard "test test test test test test test test test test test junk"
// mnemonic every plain `hardhat node` invocation uses unless configured
// otherwise). Not a secret — these are publicly documented and hold no
// real value; using them (rather than inventing throwaway keys) is what
// lets this test start a node with zero custom configuration.
const HARDHAT_ACCOUNT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;

const REVIEW_WINDOW_SECONDS = 259_200; // 72h — same value used throughout this Feature's own test fixtures.

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

function buildMultipartPayload(params: { filename: string; mimeType: string; content: Buffer }): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = "----t906e2eboundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${params.filename}"\r\n`),
    Buffer.from(`Content-Type: ${params.mimeType}\r\n\r\n`),
    params.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

runIfOptedIn("deliverable submission consistency (real Hardhat e2e, T-906, AC-902/AC-908)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let storageDir: string;
  let hardhatProcess: ChildProcessByStdio<null, Readable, Readable>;
  let hardhatStderr = "";
  let rpcUrl: string;
  let chainId: number;
  let ydTokenAddress: `0x${string}`;
  let escrowAddress: `0x${string}`;
  // Human N4 follow-up (round 1 P2, Codex): every env var this suite sets
  // must be restored to whatever it was BEFORE this suite ran, not
  // unconditionally deleted — a `.env`/shell-provided value would
  // otherwise be permanently wiped for the rest of this Vitest process
  // (which reuses one process across files run sequentially).
  const previousEnv: Partial<Record<string, string | undefined>> = {};
  const MANAGED_ENV_KEYS = [
    "DELIVERABLE_STORAGE_DIR",
    "BACKEND_RPC_URL",
    "FUNDING_REQUIRED_CONFIRMATIONS",
    "CHAIN_ID",
    "YD_FAUCET_ADDRESS",
    "YD_TOKEN_ADDRESS",
    "TASK_ESCROW_ADDRESS",
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
  const authorizedSigner = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[3]);
  const arbitrator = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[4]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      requester.address.toLowerCase(),
      agent.address.toLowerCase(),
    ]);

    storageDir = await mkdtemp(path.join(tmpdir(), "t906-e2e-deliverables-"));
    setManagedEnv("DELIVERABLE_STORAGE_DIR", storageDir);

    const port = await getFreePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    hardhatProcess = spawn(
      path.join(contractsDir, "node_modules/.bin/hardhat"),
      ["node", "--port", String(port), "--hostname", "127.0.0.1"],
      { cwd: contractsDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    hardhatProcess.stderr.on("data", (chunk: Buffer) => {
      hardhatStderr += chunk.toString();
    });
    // Human N4 follow-up (round 1 P2, Codex): a spawn failure (missing
    // binary, permission denied, ENOENT) fires the child's own `error`
    // event asynchronously — with no listener attached, Node treats that
    // as an unhandled event and crashes the whole test process instead of
    // rejecting this setup the same way a `waitForRpcReady` timeout does.
    // Racing the two turns EITHER failure mode into one ordinary rejected
    // promise this `try/catch` already handles.
    const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
      hardhatProcess.once("error", reject);
    });
    try {
      await Promise.race([waitForRpcReady(rpcUrl, 30_000), spawnErrorPromise]);
    } catch (error) {
      // Surface the spawned node's own stderr — the most useful
      // diagnostic when it never became ready (missing binary, port
      // already in use, a compile-time error in the node's own startup).
      throw new Error(`${String(error)}\nhardhat node stderr:\n${hardhatStderr}`);
    }

    setManagedEnv("BACKEND_RPC_URL", rpcUrl);
    setManagedEnv("FUNDING_REQUIRED_CONFIRMATIONS", "1");

    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    chainId = await publicClient.getChainId();
    setManagedEnv("CHAIN_ID", String(chainId));
    setManagedEnv("YD_FAUCET_ADDRESS", "0x9876543210987654321098765432109876543210");

    const deployerWallet = createWalletClient({ account: deployer, transport: http(rpcUrl) });

    const ydTokenArtifact = readArtifact("artifacts/src/YDToken.sol/YDToken.json");
    const initialSupply = 1_000_000n * 10n ** 18n;
    const ydTokenDeployHash = await deployerWallet.deployContract({
      abi: ydTokenArtifact.abi as never,
      bytecode: ydTokenArtifact.bytecode,
      args: [requester.address, initialSupply],
      chain: null,
    });
    const ydTokenReceipt = await publicClient.waitForTransactionReceipt({
      hash: ydTokenDeployHash,
    });
    if (!ydTokenReceipt.contractAddress) throw new Error("YDToken deployment produced no address");
    ydTokenAddress = ydTokenReceipt.contractAddress;
    setManagedEnv("YD_TOKEN_ADDRESS", ydTokenAddress);

    const taskEscrowArtifact = readArtifact("artifacts/src/TaskEscrow.sol/TaskEscrow.json");
    const escrowDeployHash = await deployerWallet.deployContract({
      abi: taskEscrowArtifact.abi as never,
      bytecode: taskEscrowArtifact.bytecode,
      args: [ydTokenAddress, authorizedSigner.address, REVIEW_WINDOW_SECONDS, arbitrator.address],
      chain: null,
    });
    const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowDeployHash });
    if (!escrowReceipt.contractAddress)
      throw new Error("TaskEscrow deployment produced no address");
    escrowAddress = escrowReceipt.contractAddress;
    setManagedEnv("TASK_ESCROW_ADDRESS", escrowAddress);

    // The agent needs its own YD to stake — mint everything to the
    // requester (YDToken's constructor) and transfer a slice, same
    // pattern contracts/test/TaskEscrow.settlement.t.ts's own
    // `mintAndApprove` helper uses.
    const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
    const transferHash = await requesterWallet.writeContract({
      address: ydTokenAddress,
      abi: ydTokenArtifact.abi as never,
      functionName: "transfer",
      args: [agent.address, 10_000n * 10n ** 18n],
      chain: null,
      account: requester,
    });
    await publicClient.waitForTransactionReceipt({ hash: transferHash });

    app = buildApp({ pool, logger: false });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    hardhatProcess?.kill();
    await pool?.query(DROP_ALL_TABLES_SQL);
    await pool?.end();
    // Restore each managed var to whatever it held before this suite ran
    // (undefined -> delete, otherwise put the original value back) rather
    // than unconditionally deleting — see `previousEnv`'s own doc comment.
    for (const key of MANAGED_ENV_KEYS) {
      const original = previousEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  async function login(account: typeof requester): Promise<string> {
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

  it(
    "file content hash = deliverables.resultHash = on-chain ResultSubmitted event's resultHash, " +
      "and tasks.reviewDeadline byte-for-byte equals the event's own reviewDeadline",
    async () => {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      const ydTokenArtifact = readArtifact("artifacts/src/YDToken.sol/YDToken.json");
      const taskEscrowArtifact = readArtifact("artifacts/src/TaskEscrow.sol/TaskEscrow.json");
      const requesterWallet = createWalletClient({ account: requester, transport: http(rpcUrl) });
      const agentWallet = createWalletClient({ account: agent, transport: http(rpcUrl) });

      // 1. A real task row (the draft/funding lifecycle itself is Feature
      // 6/8's own scope, already independently verified there — this
      // test starts from a task already ACCEPTED, mirroring how
      // T-905/T-907's own integration tests insert directly at that
      // status, matching what `checkSubmissionAllowed` actually requires).
      const budget = 1_000n * 10n ** 18n;
      const latestBlock = await publicClient.getBlock();
      const deliveryDeadlineUnix = latestBlock.timestamp + 7n * 24n * 60n * 60n; // +7 days
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO tasks
             (requester_address, category, title, description, budget, token, delivery_deadline,
              status, accepted_agent_address, accepted_at, expert_type)
           VALUES ($1, 'writing', 'T-906 e2e task', 'desc', $2, $3,
                   to_timestamp($4), 'ACCEPTED', $5, now(), 'AUTOMATION')
           RETURNING id`,
        [
          requester.address.toLowerCase(),
          budget.toString(),
          ydTokenAddress,
          Number(deliveryDeadlineUnix),
          agent.address.toLowerCase(),
        ],
      );
      const taskId = rows[0]?.id;
      if (!taskId) throw new Error("failed to insert the e2e task row");
      const taskIdOnChain = keccak256(toBytes(taskId));

      // 2. The SAME task, for real, on the real deployed TaskEscrow —
      // approve, createTask, sign+accept via a real AcceptancePermit.
      const approveHash = await requesterWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenArtifact.abi as never,
        functionName: "approve",
        args: [escrowAddress, budget],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const createTaskHash = await requesterWallet.writeContract({
        address: escrowAddress,
        abi: taskEscrowArtifact.abi as never,
        functionName: "createTask",
        args: [taskIdOnChain, ydTokenAddress, budget, deliveryDeadlineUnix],
        chain: null,
        account: requester,
      });
      await publicClient.waitForTransactionReceipt({ hash: createTaskHash });

      const permit = {
        taskId: taskIdOnChain,
        agent: agent.address,
        nonce: BigInt(Date.now()), // unique per test run, never reused
        expiry: deliveryDeadlineUnix,
        chainId: BigInt(chainId),
        verifyingContract: escrowAddress,
      };
      const permitSignature = await authorizedSigner.signTypedData({
        domain: {
          name: "AgentMarketTaskEscrow",
          version: "1",
          chainId,
          verifyingContract: escrowAddress,
        },
        types: {
          AcceptancePermit: [
            { name: "taskId", type: "bytes32" },
            { name: "agent", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "expiry", type: "uint256" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
        primaryType: "AcceptancePermit",
        message: permit,
      });

      const agentStakeApproveHash = await agentWallet.writeContract({
        address: ydTokenAddress,
        abi: ydTokenArtifact.abi as never,
        functionName: "approve",
        args: [escrowAddress, budget], // generous — real stake is 6% of budget
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: agentStakeApproveHash });

      const acceptTaskHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: taskEscrowArtifact.abi as never,
        functionName: "acceptTask",
        args: [permit, permitSignature],
        chain: null,
        account: agent,
      });
      await publicClient.waitForTransactionReceipt({ hash: acceptTaskHash });

      // 3. A real file, uploaded through the real HTTP route.
      const fileContent = Buffer.from(
        `T-906 real end-to-end deliverable content — ${taskId}`,
        "utf8",
      );
      const expectedFileHash: `0x${string}` = `0x${createHash("sha256")
        .update(fileContent)
        .digest("hex")}`;
      const agentSessionToken = await login(agent);
      const { payload, contentType } = buildMultipartPayload({
        filename: "result.txt",
        mimeType: "text/plain",
        content: fileContent,
      });
      const uploadResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/deliverables`,
        cookies: { session_token: agentSessionToken },
        headers: { "content-type": contentType },
        payload,
      });
      expect(uploadResponse.statusCode).toBe(201);
      const uploadBody = uploadResponse.json() as { resultHash: `0x${string}` };
      // AC: 文件内容哈希 = deliverables.resultHash — asserted against a hash
      // computed HERE, independently of `computeFileDigest` (digest.ts),
      // not by calling that function itself (which would be circular).
      expect(uploadBody.resultHash).toBe(expectedFileHash);

      // 4. A real `submitResult` transaction, signed and broadcast by
      // the agent against the real deployed contract.
      const submitResultHash = await agentWallet.writeContract({
        address: escrowAddress,
        abi: taskEscrowArtifact.abi as never,
        functionName: "submitResult",
        args: [taskIdOnChain, uploadBody.resultHash],
        chain: null,
        account: agent,
      });
      const submitReceipt = await publicClient.waitForTransactionReceipt({
        hash: submitResultHash,
      });
      expect(submitReceipt.status).toBe("success");

      // Decoded via this backend's OWN real production decoder
      // (result-submitted-event.ts) — not a hand-rolled ABI decode in
      // the test itself — so this assertion exercises the exact same
      // decoding logic `verifyResultSubmission` relies on.
      const rawLogs: RawEventLog[] = submitReceipt.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: log.logIndex ?? 0,
      }));
      const decodedEvent = findResultSubmittedLog(rawLogs, escrowAddress);
      if (!decodedEvent) throw new Error("ResultSubmitted event not found in the real receipt");
      expect(decodedEvent.resultHash.toLowerCase()).toBe(expectedFileHash.toLowerCase());

      // 5. The real event-sync path: the actual
      // `POST /tasks/:taskId/result-verifications` route, which
      // internally builds a real `createChainRpcClient()` pointed at
      // this spawned node (BACKEND_RPC_URL) and independently re-fetches
      // + re-decodes the receipt itself — this call is what performs
      // the real projection this test is verifying, not a shortcut.
      const verifyResponse = await app.inject({
        method: "POST",
        url: `/tasks/${taskId}/result-verifications`,
        cookies: { session_token: agentSessionToken },
        payload: { txHash: submitResultHash },
      });
      expect(verifyResponse.statusCode).toBe(200);
      const verifyBody = verifyResponse.json() as { status: string; confirmations: number };
      expect(verifyBody.status).toBe("SUBMITTED");

      // 6. The three-way hash equality and the byte-for-byte
      // reviewDeadline projection, read directly from the database —
      // exactly what AC-902/AC-908 require.
      const { rows: deliverableRows } = await pool.query<{ result_hash: string }>(
        `SELECT result_hash FROM deliverables WHERE task_id = $1 ORDER BY sequence_no DESC LIMIT 1`,
        [taskId],
      );
      expect(deliverableRows[0]?.result_hash.toLowerCase()).toBe(expectedFileHash.toLowerCase());

      const { rows: taskRows } = await pool.query<{
        status: string;
        submitted_at: Date;
        review_deadline: Date;
      }>(`SELECT status, submitted_at, review_deadline FROM tasks WHERE id = $1`, [taskId]);
      const taskRow = taskRows[0];
      if (!taskRow) throw new Error("task row disappeared");
      expect(taskRow.status).toBe("SUBMITTED");

      // "逐字节相等" (AC-908): compare the exact Unix-second integer the
      // contract emitted against what got stored — not a tolerance
      // window, not a recomputed `submittedAt + reviewWindow` expression
      // (there is deliberately none anywhere in this backend, F-905).
      const storedReviewDeadlineUnix = BigInt(Math.floor(taskRow.review_deadline.getTime() / 1000));
      const storedSubmittedAtUnix = BigInt(Math.floor(taskRow.submitted_at.getTime() / 1000));
      expect(storedReviewDeadlineUnix).toBe(decodedEvent.reviewDeadline);
      expect(storedSubmittedAtUnix).toBe(decodedEvent.submittedAt);
    },
    60_000,
  );
});
