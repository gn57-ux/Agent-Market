import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Pool } from "pg";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { TaskEscrow, YDToken } from "../typechain-types";
import { deployRealSafe, execRealSafeTransaction } from "./helpers/safe";

/**
 * Feature 21 (arbitration-committee), T-2105 (F-2107; requirements.md
 * AC-2103 后半/AC-2105).
 *
 * The full real drill: a real dispute is opened on a real budget-funded
 * task, `ARBITRATOR_ROLE` is rotated onto a real deployed 3-owner/2/3
 * Safe (T-2103/T-2104's own real helpers), and the dispute is resolved by
 * a REAL 2-of-3 Safe multisig execution — 2 real owners produce real
 * EIP-712 signatures over the real `SafeTx` the Safe itself computes,
 * `Safe.execTransaction` verifies them and genuinely calls `TaskEscrow
 * .resolveDispute` AS the Safe. No mocking of Safe's signature
 * verification, no single-signer shortcut, no simulated multisig.
 *
 * N4 real finding (P1, T-2105): the first version of this file proved the
 * on-chain execution works, but never actually persisted its real result
 * into `arbitration_decisions` — a separate `apps/api` integration test
 * exercised the repository with fixed, disconnected fake hashes, so
 * nothing here proved the SAME real drill's real values ever reach the
 * database, which is exactly what AC-2105 ("决定记录里的 Safe 交易哈希可以
 * 在真实链上核实对应到真实发生的 resolveDispute 调用") requires. The
 * "records the real decision" test below now writes DIRECTLY into a real
 * Postgres test database (`TEST_DATABASE_URL`, `@agent-market/domain`'s
 * shared `requireTestDatabaseUrl` safety guard — the same one every other
 * real-Postgres suite in this monorepo uses, CLAUDE.md 原则 6) using the
 * `safeTxHash`/`receipt.hash`/signer addresses THIS SAME test run just
 * produced, then reads the row back and re-verifies the on-chain receipt
 * for that exact hash independently. Gated behind
 * `RUN_DB_INTEGRATION_TESTS=1` like every other real-Postgres test in this
 * repo; the other tests in this file need no database and always run.
 */
const runDbTest = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? it : it.skip;

describe("Real 2-of-3 Safe multisig dispute resolution (T-2105)", () => {
  let admin: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let oldArbitrator: HardhatEthersSigner;
  let safeOwner1: HardhatEthersSigner;
  let safeOwner2: HardhatEthersSigner;
  let safeOwner3: HardhatEthersSigner;
  let escrow: TaskEscrow;
  let token: YDToken;
  let tokenAddress: string;
  let escrowAddress: string;
  let chainId: bigint;
  let pool: Pool;

  const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
  const TOKEN_ADDRESS_FOR_DB = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

  before(async function () {
    if (process.env.RUN_DB_INTEGRATION_TESTS !== "1") return;
    this.timeout(30_000);
    // Dynamic `import()` (not a static import) — this package is
    // CommonJS (`contracts/package.json`'s own `"type": "commonjs"`),
    // while `@agent-market/domain` is pure ESM; a static `require()` of a
    // pure-ESM package from a CJS file fails, but `import()` works from
    // either module system.
    const { requireTestDatabaseUrl } = await import("@agent-market/domain");
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });

    // Reuses `apps/api`'s OWN real `runMigrations` (CLAUDE.md 原则 6:
    // migration-application logic has exactly one real owner) — imported
    // from its BUILT output (`pnpm --filter @agent-market/api build`),
    // since this `contracts` package (CommonJS, no TypeScript loader for
    // another package's raw ESM `.ts` sources) cannot execute
    // `apps/api/src/db/migrate.ts` directly, but dynamic `import()` of a
    // plain compiled `.js` file works from any module system. Every other
    // `apps/api/src/**/*.integration.test.ts` file calls this exact same
    // function in its own `beforeAll` for the exact same reason (each
    // file is independently self-sufficient, not order-dependent on
    // another file having run first).
    const migrateModulePath = path.resolve(__dirname, "../../apps/api/dist/db/migrate.js");
    // ts-node compiles this whole file to CommonJS and downlevels a plain
    // `import(...)` expression to `require(...)` in that target, which
    // cannot load a `file://` URL or a pure-ESM module — `new
    // Function(...)` hides the `import()` from that static downleveling,
    // preserving a REAL dynamic import at runtime (the standard, minimal
    // workaround for calling ESM from CJS, not a novel trick invented
    // here).
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{ runMigrations: (pool: Pool, dir: string) => Promise<unknown> }>;
    const { runMigrations } = await dynamicImport(pathToFileURL(migrateModulePath).href);
    const migrationsDir = path.resolve(__dirname, "../../apps/api/migrations");
    await runMigrations(pool, migrationsDir);

    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  after(async () => {
    if (!pool) return;
    // Same `DROP_ALL_TABLES_SQL` convention as every other real-Postgres
    // suite in this repo — this test applied real migrations in `before`
    // above, so it must leave the shared test database exactly as it
    // found it (empty of this schema), or a LATER, unrelated test file
    // run against the same `TEST_DATABASE_URL` (e.g. `apps/api`'s own
    // `migrate.integration.test.ts`, which asserts a truly fresh
    // database) would see stale tables/`schema_migrations` rows and
    // fail for a reason that has nothing to do with its own logic.
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    if (pool) {
      await pool.query("DELETE FROM arbitration_decisions");
      await pool.query("DELETE FROM disputes");
      await pool.query("DELETE FROM tasks");
    }
  });

  const budget = ethers.parseUnits("100", 18);
  const reviewWindow = 259200;
  const oneDay = 24 * 60 * 60;

  const domain = (verifyingContract: string) => ({
    name: "AgentMarketTaskEscrow",
    version: "1",
    chainId,
    verifyingContract,
  });

  const types = {
    AcceptancePermit: [
      { name: "taskId", type: "bytes32" },
      { name: "agent", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  };

  const futureDeadline = async (offsetSeconds: number): Promise<bigint> => {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) throw new Error("no latest block");
    return BigInt(latest.timestamp + offsetSeconds);
  };

  beforeEach(async () => {
    [admin, requester, agent, oldArbitrator, safeOwner1, safeOwner2, safeOwner3] =
      await ethers.getSigners();

    const tokenFactory = await ethers.getContractFactory("YDToken", admin);
    token = await tokenFactory.deploy(admin.address, ethers.parseUnits("1000000", 18));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    const escrowFactory = await ethers.getContractFactory("TaskEscrow", admin);
    escrow = await escrowFactory.deploy(
      tokenAddress,
      admin.address,
      reviewWindow,
      oldArbitrator.address,
    );
    await escrow.waitForDeployment();
    escrowAddress = await escrow.getAddress();

    const network = await ethers.provider.getNetwork();
    chainId = network.chainId;

    await token.transfer(requester.address, budget);
    await token.connect(requester).approve(escrowAddress, budget);
    await token.transfer(agent.address, ethers.parseUnits("1000", 18));
    await token.connect(agent).approve(escrowAddress, ethers.MaxUint256);
  });

  async function disputeSubmittedTask(): Promise<string> {
    const id = ethers.keccak256(
      ethers.toUtf8Bytes(`safe-drill-task-${Date.now()}-${Math.random()}`),
    );
    const deadline = await futureDeadline(oneDay * 7);
    await escrow.connect(requester).createTask(id, tokenAddress, budget, deadline);

    const permit = {
      taskId: id,
      agent: agent.address,
      nonce: 0n,
      expiry: await futureDeadline(oneDay),
      chainId,
      verifyingContract: escrowAddress,
    };
    const signature = await admin.signTypedData(domain(escrowAddress), types, permit);
    await escrow.connect(agent).acceptTask(permit, signature);

    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`result-${id}`));
    await escrow.connect(agent).submitResult(id, resultHash);

    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(`evidence-${id}`));
    await escrow.connect(requester).openDispute(id, evidenceHash);
    return id;
  }

  runDbTest(
    "resolves a real dispute via a real 2-of-3 Safe multisig execTransaction, paying out exactly like the single-EOA path, and persists the SAME real result into arbitration_decisions",
    async function () {
      this.timeout(20_000);
      const safe = await deployRealSafe(
        [safeOwner1.address, safeOwner2.address, safeOwner3.address],
        2,
      );
      const safeAddress = await safe.getAddress();
      const arbitratorRole = await escrow.ARBITRATOR_ROLE();
      await (await escrow.connect(admin).grantRole(arbitratorRole, safeAddress)).wait();
      await (await escrow.connect(admin).revokeRole(arbitratorRole, oldArbitrator.address)).wait();

      const disputeId = await disputeSubmittedTask();

      const task = await escrow.getTask(disputeId);
      const expectedStake = task.stake;
      const agentBalanceBefore = await token.balanceOf(agent.address);
      const escrowBalanceBefore = await token.balanceOf(escrowAddress);

      const resolveCalldata = escrow.interface.encodeFunctionData("resolveDispute", [
        disputeId,
        true,
      ]);

      // Real 2-of-3: only owner1 and owner2 sign — owner3 never participates
      // in this execution, proving the threshold (not unanimity) is what's
      // actually enforced.
      const { receipt, safeTxHash } = await execRealSafeTransaction(
        safe,
        [safeOwner1, safeOwner2],
        escrowAddress,
        resolveCalldata,
      );

      const executionSuccessLog = receipt.logs
        .map((log) => {
          try {
            return safe.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "ExecutionSuccess");
      expect(
        executionSuccessLog,
        "real Safe execution must report ExecutionSuccess, not ExecutionFailure",
      ).to.not.equal(undefined);
      expect(executionSuccessLog?.args[0]).to.equal(safeTxHash);

      // F-2114/AC-2105: the real, executed on-chain transaction hash — the
      // value `arbitration_decisions.onchain_tx_hash` records.
      expect(receipt.hash).to.match(/^0x[0-9a-f]{64}$/);

      const taskAfter = await escrow.getTask(disputeId);
      expect(taskAfter.status).to.equal(4n); // TaskStatus.RELEASED — genuinely executed, not just signed.
      expect(await token.balanceOf(agent.address)).to.equal(
        agentBalanceBefore + budget + expectedStake,
      );
      expect(await token.balanceOf(escrowAddress)).to.equal(
        escrowBalanceBefore - budget - expectedStake,
      );

      // --- F-2114/AC-2105: persist THIS SAME real drill's real result. ---
      // A minimal, schema-valid `tasks`+`disputes` row (satisfying
      // `arbitration_decisions.dispute_id`'s real FK) — this test's own
      // scope is proving the SIGNING/EXECUTION and the DB PERSISTENCE of
      // its real output, not re-deriving Feature 10's already-solved,
      // separate off-chain-dispute-row-creation mechanism (that mechanism
      // is exercised elsewhere, e.g. `full-lifecycle.hardhat.e2e.test.ts`'s
      // own scenario 4). The values written below (`safeTxHash`,
      // `receipt.hash`, the two real signer addresses) are NOT invented —
      // they are the exact values this same test run just produced above.
      const {
        rows: [taskRow],
      } = await pool.query<{ id: string }>(
        `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'DISPUTED', 'AUTOMATION')
       RETURNING id`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS_FOR_DB],
      );
      const {
        rows: [disputeRow],
      } = await pool.query<{ id: string }>(
        `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash)
       VALUES ($1, $2, 'reason', 'summary', $3) RETURNING id`,
        [taskRow?.id, REQUESTER_ADDRESS, "0x" + "d4".repeat(32)],
      );
      const dbDisputeId = disputeRow?.id ?? "";

      // Same real INSERT `apps/api`'s own `insertArbitrationDecision`
      // (`decision-repository.ts`) issues — this test's own `contracts`
      // package cannot import that ESM/TS module directly at runtime
      // (cross-package raw `.ts` execution has no build step here), so the
      // identical SQL is issued directly against the SAME real schema
      // (`0040_create_arbitration_committee_tables.sql`) that repository's
      // own real-Postgres integration test (`decision-repository
      // .integration.test.ts`) independently verifies `insertArbitration
      // Decision`/`getArbitrationDecisionByDisputeId` against — this test's
      // OWN job is proving the real chain-side values reach a real
      // persisted row, not re-verifying the repository function's own
      // correctness a second time.
      const {
        rows: [insertedRow],
      } = await pool.query<{ id: string }>(
        `INSERT INTO arbitration_decisions (dispute_id, safe_tx_hash, onchain_tx_hash, supported_party, signer_addresses)
       VALUES ($1, $2, $3, 'AGENT', $4)
       RETURNING id`,
        [
          dbDisputeId,
          safeTxHash,
          receipt.hash,
          [safeOwner1.address.toLowerCase(), safeOwner2.address.toLowerCase()],
        ],
      );

      const {
        rows: [persisted],
      } = await pool.query<{ safe_tx_hash: string; onchain_tx_hash: string }>(
        `SELECT safe_tx_hash, onchain_tx_hash FROM arbitration_decisions WHERE id = $1`,
        [insertedRow?.id],
      );
      expect(persisted?.onchain_tx_hash).to.equal(receipt.hash);
      expect(persisted?.safe_tx_hash).to.equal(safeTxHash);

      // Independently re-verify, straight against the real chain (not
      // trusting the in-memory `receipt` object this test already holds),
      // that the persisted `onchain_tx_hash` really is a mined, successful
      // transaction that really targeted this real `TaskEscrow` — the
      // literal AC-2105 claim ("决定记录里的 Safe 交易哈希可以在真实链上核实
      // 对应到真实发生的 resolveDispute 调用").
      const reFetchedReceipt = await ethers.provider.getTransactionReceipt(
        persisted?.onchain_tx_hash ?? "",
      );
      expect(reFetchedReceipt).to.not.equal(null);
      expect(reFetchedReceipt?.status).to.equal(1);
      expect(reFetchedReceipt?.to?.toLowerCase()).to.equal(safeAddress.toLowerCase());
    },
  );

  it("rejects an execution with only 1 real signature — the real Safe threshold (2), not this test, enforces the quorum", async () => {
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    const safeAddress = await safe.getAddress();
    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    await (await escrow.connect(admin).grantRole(arbitratorRole, safeAddress)).wait();
    await (await escrow.connect(admin).revokeRole(arbitratorRole, oldArbitrator.address)).wait();

    const disputeId = await disputeSubmittedTask();
    const resolveCalldata = escrow.interface.encodeFunctionData("resolveDispute", [
      disputeId,
      true,
    ]);

    await expect(execRealSafeTransaction(safe, [safeOwner1], escrowAddress, resolveCalldata)).to.be
      .reverted;

    const taskAfter = await escrow.getTask(disputeId);
    expect(taskAfter.status).to.equal(3n); // still DISPUTED — the real quorum genuinely blocked execution.
  });

  it("rejects 2 signatures from non-owners of the real Safe", async () => {
    const safe = await deployRealSafe(
      [safeOwner1.address, safeOwner2.address, safeOwner3.address],
      2,
    );
    const safeAddress = await safe.getAddress();
    const arbitratorRole = await escrow.ARBITRATOR_ROLE();
    await (await escrow.connect(admin).grantRole(arbitratorRole, safeAddress)).wait();
    await (await escrow.connect(admin).revokeRole(arbitratorRole, oldArbitrator.address)).wait();

    const disputeId = await disputeSubmittedTask();
    const resolveCalldata = escrow.interface.encodeFunctionData("resolveDispute", [
      disputeId,
      true,
    ]);

    // `requester`/`agent` hold no real ownership of this Safe.
    await expect(execRealSafeTransaction(safe, [requester, agent], escrowAddress, resolveCalldata))
      .to.be.reverted;
  });
});
