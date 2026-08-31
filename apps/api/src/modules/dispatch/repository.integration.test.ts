import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { generatePrivateKey } from "viem/accounts";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { canonicalJsonSha256 } from "./input-digest.js";
import { deriveOnChainTaskId } from "../tasks/onchain-task-id.js";
import { issueAcceptancePermit } from "./permit.service.js";
import {
  assembleCandidateSnapshots,
  consumeAcceptancePermits,
  getLatestRecommendationRunId,
  getOutstandingPermitsForRun,
  getRecommendationCandidatesForRun,
  hasUnexpiredOutstandingPermits,
  insertPermitsForRunIfAbsent,
  insertRecommendationRunWithPermits,
  invalidateOtherOutstandingPermits,
  PermitsStillOutstandingError,
  resolveAcceptingAgentId,
  StaleRecommendationRunError,
  TaskNotOpenForPermitsError,
  type SignedAcceptancePermit,
} from "./repository.js";

const TEST_DIGEST = "test-digest";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-705's dedicated verification that
// assembleCandidateSnapshots correctly reads real agents/agent_skills/
// blocked_wallets data into the wire-format CandidateSnapshot[] POST /match
// expects.
//
// T-806 (human N6 BLOCK fix): T-705's original `insertRecommendationRun`
// (run + candidates only, no permits, no row lock) has been REMOVED —
// `matchTask` (routes.ts) now exclusively calls
// `insertRecommendationRunWithPermits` (run + candidates + permits, one
// atomic transaction, locks the task row), so that is now the single
// production code path this suite verifies; a separate direct test of the
// old narrower function would just be testing dead code. This file also now
// covers T-806's fault-injection (real FK violation, real ROLLBACK),
// concurrent-/match serialization, and `resolveAcceptingAgentId`'s exact
// nonce-matching behavior.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, schema_migrations CASCADE";

const OWNER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const BANNED_OWNER_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const REQUESTER_ADDRESS = "0x6683fefc63f0cd0e873a0000c6d07ef7b77e90d5";
const TOKEN_ADDRESS = "0x7783fefc63f0cd0e873a0000c6d07ef7b77e90d6";

async function insertAgent(
  pool: Pool,
  overrides: Partial<{
    ownerAddress: string;
    status: string;
    category: string;
    level: string;
  }> = {},
): Promise<string> {
  const ownerAddress = overrides.ownerAddress ?? OWNER_ADDRESS;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agents (owner_address, name, description, category, payout_address, status, level)
     VALUES ($1, 'Agent', 'desc', $2, $1, $3, $4)
     RETURNING id`,
    [
      ownerAddress,
      overrides.category ?? "writing",
      overrides.status ?? "ACTIVE",
      overrides.level ?? "BEGINNER",
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insertAgent: no id returned");
  return id;
}

async function insertTask(pool: Pool, status: string, acceptedAgentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO tasks
       (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
     VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', $3, $4, 'AUTOMATION')`,
    [REQUESTER_ADDRESS, TOKEN_ADDRESS, status, acceptedAgentId],
  );
}

runIfOptedIn(
  "assembleCandidateSnapshots / insertRecommendationRunWithPermits (integration, T-705/T-806)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      for (const address of [OWNER_ADDRESS, BANNED_OWNER_ADDRESS, REQUESTER_ADDRESS]) {
        await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
          address,
        ]);
      }
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM recommendation_candidates");
      await pool.query("DELETE FROM recommendation_runs");
      await pool.query("DELETE FROM acceptance_permits");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM agent_skills");
      await pool.query("DELETE FROM agents");
      await pool.query("DELETE FROM blocked_wallets");
    });

    it("assembles ACTIVE agents with skill tags, activeTaskCount, and isBanned correctly; excludes INACTIVE agents", async () => {
      const activeAgentId = await insertAgent(pool, { category: "writing", level: "EXPERT" });
      await pool.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, $2), ($1, $3)`, [
        activeAgentId,
        "copywriting",
        "seo",
      ]);
      await insertTask(pool, "ACCEPTED", activeAgentId);
      await insertTask(pool, "SUBMITTED", activeAgentId);
      await insertTask(pool, "RELEASED", activeAgentId); // not occupying

      const bannedAgentId = await insertAgent(pool, { ownerAddress: BANNED_OWNER_ADDRESS });
      await pool.query(`INSERT INTO blocked_wallets (address) VALUES ($1)`, [BANNED_OWNER_ADDRESS]);

      const inactiveAgentId = await insertAgent(pool, { status: "INACTIVE" });

      const snapshots = await assembleCandidateSnapshots(pool, "writing");

      expect(snapshots.some((s) => s.agentId === inactiveAgentId)).toBe(false);

      const active = snapshots.find((s) => s.agentId === activeAgentId);
      expect(active).toBeDefined();
      expect(active?.walletAddress).toBe(OWNER_ADDRESS);
      expect(active?.status).toBe("ACTIVE");
      expect(active?.category).toBe("writing");
      expect(active?.level).toBe("EXPERT");
      expect(active?.skillTags.sort()).toEqual(["copywriting", "seo"]);
      expect(active?.activeTaskCount).toBe(2);
      expect(active?.isBanned).toBe(false);

      const banned = snapshots.find((s) => s.agentId === bannedAgentId);
      expect(banned).toBeDefined();
      expect(banned?.isBanned).toBe(true);
      expect(banned?.activeTaskCount).toBe(0);
      expect(banned?.skillTags).toEqual([]);
    });

    it("returns an empty array when there are no ACTIVE agents", async () => {
      await insertAgent(pool, { status: "INACTIVE" });
      const snapshots = await assembleCandidateSnapshots(pool, "writing");
      expect(snapshots).toEqual([]);
    });

    it("does not filter by taskCategory — agents of any category are included (eligibility's job, not this function's)", async () => {
      await insertAgent(pool, { category: "design" });
      const snapshots = await assembleCandidateSnapshots(pool, "writing");
      expect(snapshots).toHaveLength(1);
    });

    /** Shared by every `insertRecommendationRunWithPermits` test below —
     * inserts a fresh OPEN task, since that function now opens with `SELECT
     * ... FOR UPDATE` on the task row. */
    async function insertOpenTask(): Promise<string> {
      const taskInsert = await pool.query<{ id: string }>(
        `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS],
      );
      const taskId = taskInsert.rows[0]?.id;
      if (!taskId) throw new Error("task insert returned no id");
      return taskId;
    }

    function buildSignedPermit(
      agentId: string,
      overrides: Partial<SignedAcceptancePermit> = {},
    ): SignedAcceptancePermit {
      return {
        agentId,
        agentWalletAddress: OWNER_ADDRESS,
        nonce: "1",
        expiry: Math.floor(Date.now() / 1000) + 3600,
        chainId: 31337,
        verifyingContract: "0x1234567890123456789012345678901234567890",
        signature: "0x" + "ab".repeat(65),
        ...overrides,
      };
    }

    // T-806 (replacing T-705's now-removed `insertRecommendationRun` test):
    // this is the sole production path (`matchTask`, routes.ts, calls this
    // exact function) — run + candidates + permits, persisted atomically in
    // one transaction.
    it("insertRecommendationRunWithPermits persists the run, its candidates, and one acceptance_permits row per signed permit, atomically", async () => {
      const agentId = await insertAgent(pool);
      const taskId = await insertOpenTask();

      const { runId } = await insertRecommendationRunWithPermits(pool, {
        taskId,
        algorithmVersion: "v0.1",
        candidateCount: 5,
        inputDigest: TEST_DIGEST,
        candidates: [
          { agentId, rank: 1, slotType: "TOP_SCORE", score: 0.87, reasons: ["技能匹配"] },
        ],
        permits: [buildSignedPermit(agentId)],
      });

      const { rows: runRows } = await pool.query<{
        candidate_count: number;
        algorithm_version: string;
      }>(`SELECT candidate_count, algorithm_version FROM recommendation_runs WHERE id = $1`, [
        runId,
      ]);
      expect(runRows[0]?.candidate_count).toBe(5);
      expect(runRows[0]?.algorithm_version).toBe("v0.1");

      const { rows: candidateRows } = await pool.query<{
        agent_id: string;
        rank: number;
        slot_type: string;
        score: string;
        reasons: string[];
      }>(
        `SELECT agent_id, rank, slot_type, score, reasons FROM recommendation_candidates WHERE run_id = $1`,
        [runId],
      );
      expect(candidateRows).toHaveLength(1);
      expect(candidateRows[0]?.agent_id).toBe(agentId);
      expect(candidateRows[0]?.rank).toBe(1);
      expect(candidateRows[0]?.slot_type).toBe("TOP_SCORE");
      expect(Number(candidateRows[0]?.score)).toBeCloseTo(0.87);
      expect(candidateRows[0]?.reasons).toEqual(["技能匹配"]);

      const { rows: permitRows } = await pool.query<{
        agent_id: string;
        accepting_address: string;
        status: string;
        nonce: string;
      }>(
        `SELECT agent_id, accepting_address, status, nonce FROM acceptance_permits WHERE task_id = $1`,
        [taskId],
      );
      expect(permitRows).toHaveLength(1);
      expect(permitRows[0]?.agent_id).toBe(agentId);
      expect(permitRows[0]?.accepting_address).toBe(OWNER_ADDRESS);
      expect(permitRows[0]?.status).toBe("OUTSTANDING");
      expect(permitRows[0]?.nonce).toBe("1");
    });

    // Regression for Codex round 2 P2: the task-row lock alone does not
    // reject a task that has already left OPEN — this transaction must
    // check the locked row's actual status and refuse to persist a new run
    // or any OUTSTANDING permits for it.
    it("rejects and persists nothing when the task is no longer OPEN, even under the lock", async () => {
      const agentId = await insertAgent(pool);
      const taskId = await insertOpenTask();
      await pool.query(`UPDATE tasks SET status = 'ACCEPTED' WHERE id = $1`, [taskId]);

      await expect(
        insertRecommendationRunWithPermits(pool, {
          taskId,
          algorithmVersion: "v0.1",
          candidateCount: 1,
          inputDigest: TEST_DIGEST,
          candidates: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.87, reasons: ["x"] }],
          permits: [buildSignedPermit(agentId)],
        }),
      ).rejects.toThrow();

      const runRows = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
        taskId,
      ]);
      const permitRows = await pool.query(`SELECT id FROM acceptance_permits WHERE task_id = $1`, [
        taskId,
      ]);
      expect(runRows.rows).toHaveLength(0);
      expect(permitRows.rows).toHaveLength(0);
    });

    // Every recommended candidate gets its OWN permit — no wallet-level
    // dedup (T-806, direct reversal of T-803 round 2's rejected design).
    it("persists one independent acceptance_permits row per candidate, even when two candidates share a wallet", async () => {
      const taskId = await insertOpenTask();
      const agentA = await insertAgent(pool); // OWNER_ADDRESS
      const agentB = await insertAgent(pool); // same OWNER_ADDRESS, different agentId

      await insertRecommendationRunWithPermits(pool, {
        taskId,
        algorithmVersion: "v0.1",
        candidateCount: 2,
        inputDigest: TEST_DIGEST,
        candidates: [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
          { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
        ],
        permits: [
          buildSignedPermit(agentA, { nonce: "101" }),
          buildSignedPermit(agentB, { nonce: "202" }),
        ],
      });

      const { rows } = await pool.query<{ agent_id: string; nonce: string }>(
        `SELECT agent_id, nonce FROM acceptance_permits WHERE task_id = $1 ORDER BY nonce`,
        [taskId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.agent_id)).toEqual([agentA, agentB]);
      expect(rows.map((r) => r.nonce)).toEqual(["101", "202"]);
    });

    // T-806, user's item #1: fault injection — proves the ROLLBACK is real,
    // not just a return-value contract. The second candidate's permit is
    // given an agentId that doesn't exist in `agents` at all, which trips the
    // REAL `acceptance_permits.agent_id` foreign-key constraint (a genuine
    // database-level failure, not a mock) partway through the batch.
    it("rolls back the ENTIRE transaction — zero rows in all three tables — when a later permit insert hits a real FK violation", async () => {
      const taskId = await insertOpenTask();
      const agentA = await insertAgent(pool);
      const nonexistentAgentId = "00000000-0000-4000-8000-000000000000"; // valid UUID, no `agents` row

      await expect(
        insertRecommendationRunWithPermits(pool, {
          taskId,
          algorithmVersion: "v0.1",
          candidateCount: 2,
          inputDigest: TEST_DIGEST,
          candidates: [
            { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
            // A candidate row for a real agentId is fine at the recommendation_candidates
            // level (no FK there in this test's path since it also references agentA);
            // the FK violation is deliberately isolated to the SECOND permit's agent_id.
          ],
          permits: [
            buildSignedPermit(agentA, { nonce: "1" }),
            buildSignedPermit(nonexistentAgentId, { nonce: "2" }), // triggers a real FK violation
          ],
        }),
      ).rejects.toThrow();

      const runRows = await pool.query(`SELECT id FROM recommendation_runs WHERE task_id = $1`, [
        taskId,
      ]);
      const candidateRows = await pool.query(
        `SELECT rc.id FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
        [taskId],
      );
      const permitRows = await pool.query(`SELECT id FROM acceptance_permits WHERE task_id = $1`, [
        taskId,
      ]);
      // Real SQL query results, not an assumption from the thrown error alone:
      // every table this function writes to has exactly zero rows for this
      // task after the ROLLBACK.
      expect(runRows.rows).toHaveLength(0);
      expect(candidateRows.rows).toHaveLength(0);
      expect(permitRows.rows).toHaveLength(0);
    });

    // T-806, user's item #1's last sentence: concurrent calls for the SAME
    // task each complete their own three-table write as an uninterrupted
    // unit — no interleaving. Feature 7 sync (T-709) changes the OUTCOME
    // for a permit-free task's first-ever pair of concurrent /match calls:
    // "repeated /match always succeeds with a fresh independent run" is no
    // longer true once ANY unexpired OUTSTANDING permit exists — a new
    // round can only be created once the current one's permits have
    // expired. Under real concurrency starting from zero permits, exactly
    // one of the two racing calls wins (creates the task's one allowed
    // round) and the other is rejected with PermitsStillOutstandingError —
    // never both, never neither.
    it("real concurrency: of two genuinely simultaneous calls for the same (permit-free) task, exactly one wins and the other is rejected with PermitsStillOutstandingError", async () => {
      const taskId = await insertOpenTask();
      const agentA = await insertAgent(pool);
      const agentB = await insertAgent(pool);

      const results = await Promise.allSettled([
        insertRecommendationRunWithPermits(pool, {
          taskId,
          algorithmVersion: "v0.1",
          candidateCount: 1,
          inputDigest: TEST_DIGEST,
          candidates: [
            { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["a"] },
          ],
          permits: [buildSignedPermit(agentA, { nonce: "301" })],
        }),
        insertRecommendationRunWithPermits(pool, {
          taskId,
          algorithmVersion: "v0.1",
          candidateCount: 1,
          inputDigest: TEST_DIGEST,
          candidates: [
            { agentId: agentB, rank: 1, slotType: "TOP_SCORE", score: 0.8, reasons: ["b"] },
          ],
          permits: [buildSignedPermit(agentB, { nonce: "302" })],
        }),
      ]);

      // The task-row lock means these two writes never interleaved: the
      // loser sees the winner's freshly-committed unexpired permit and is
      // rejected by hasUnexpiredOutstandingPermits.
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        PermitsStillOutstandingError,
      );

      const { rows: runRows } = await pool.query<{ id: string }>(
        `SELECT id FROM recommendation_runs WHERE task_id = $1`,
        [taskId],
      );
      expect(runRows).toHaveLength(1);

      const { rows: outstandingRows } = await pool.query(
        `SELECT run_id FROM acceptance_permits WHERE task_id = $1 AND status = 'OUTSTANDING'`,
        [taskId],
      );
      expect(outstandingRows).toHaveLength(1);
    });
  },
);

runIfOptedIn("resolveAcceptingAgentId (integration, T-806)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    for (const address of [OWNER_ADDRESS, REQUESTER_ADDRESS]) {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [address]);
    }
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM acceptance_permits");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  async function insertTaskAndAgent(): Promise<{ taskId: string; agentId: string }> {
    const taskInsert = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const taskId = taskInsert.rows[0]?.id;
    if (!taskId) throw new Error("task insert returned no id");
    const agentId = await insertAgent(pool);
    return { taskId, agentId };
  }

  it("returns the exact agentId for a matching (task_id, accepting_address, nonce)", async () => {
    const { taskId, agentId } = await insertTaskAndAgent();
    await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [
        {
          agentId,
          agentWalletAddress: OWNER_ADDRESS,
          nonce: "555",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          chainId: 31337,
          verifyingContract: "0x1234567890123456789012345678901234567890",
          signature: "0x" + "ab".repeat(65),
        },
      ],
    });

    const resolved = await resolveAcceptingAgentId(pool, taskId, OWNER_ADDRESS, "555");
    expect(resolved).toBe(agentId);
  });

  it("returns null for a nonce that was never issued", async () => {
    const { taskId, agentId } = await insertTaskAndAgent();
    await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [
        {
          agentId,
          agentWalletAddress: OWNER_ADDRESS,
          nonce: "555",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          chainId: 31337,
          verifyingContract: "0x1234567890123456789012345678901234567890",
          signature: "0x" + "ab".repeat(65),
        },
      ],
    });

    const resolved = await resolveAcceptingAgentId(pool, taskId, OWNER_ADDRESS, "999999");
    expect(resolved).toBeNull();
  });

  it("does not confuse two candidates sharing a wallet with different nonces", async () => {
    const taskId = (await insertTaskAndAgent()).taskId;
    const agentA = await insertAgent(pool);
    const agentB = await insertAgent(pool);

    await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 2,
      inputDigest: TEST_DIGEST,
      candidates: [
        { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        { agentId: agentB, rank: 2, slotType: "EXPLORATION", score: 0.5, reasons: ["y"] },
      ],
      permits: [
        {
          agentId: agentA,
          agentWalletAddress: OWNER_ADDRESS,
          nonce: "111",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          chainId: 31337,
          verifyingContract: "0x1234567890123456789012345678901234567890",
          signature: "0x" + "ab".repeat(65),
        },
        {
          agentId: agentB,
          agentWalletAddress: OWNER_ADDRESS,
          nonce: "222",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          chainId: 31337,
          verifyingContract: "0x1234567890123456789012345678901234567890",
          signature: "0x" + "ab".repeat(65),
        },
      ],
    });

    expect(await resolveAcceptingAgentId(pool, taskId, OWNER_ADDRESS, "111")).toBe(agentA);
    expect(await resolveAcceptingAgentId(pool, taskId, OWNER_ADDRESS, "222")).toBe(agentB);
  });

  it("returns null when the matching row is not OUTSTANDING (e.g. already CONSUMED)", async () => {
    const { taskId, agentId } = await insertTaskAndAgent();
    await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [
        {
          agentId,
          agentWalletAddress: OWNER_ADDRESS,
          nonce: "777",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          chainId: 31337,
          verifyingContract: "0x1234567890123456789012345678901234567890",
          signature: "0x" + "ab".repeat(65),
        },
      ],
    });
    await pool.query(
      `UPDATE acceptance_permits SET status = 'CONSUMED' WHERE task_id = $1 AND nonce = '777'`,
      [taskId],
    );

    const resolved = await resolveAcceptingAgentId(pool, taskId, OWNER_ADDRESS, "777");
    expect(resolved).toBeNull();
  });
});

// Feature 7 sync (T-709) combined regression coverage: round-gating +
// run_id binding + exact-nonce attribution (T-806) + CONSUMED/INVALIDATED
// state transitions, all exercised together against the merged schema —
// not just each mechanism in isolation. Uses the REAL issueAcceptancePermit
// (permit.service.ts) to sign every permit, matching this project's
// established "real signing, not a hand-built fixture" convention.
runIfOptedIn("round-gating + run_id + exact-nonce + CONSUMED (integration, Feature 7 sync)", () => {
  let pool: Pool;
  const PERMIT_ENV_KEYS = [
    "ACCEPTANCE_PERMIT_SIGNER_KEY",
    "CHAIN_ID",
    "TASK_ESCROW_ADDRESS",
    "YD_TOKEN_ADDRESS",
    "YD_FAUCET_ADDRESS",
  ] as const;
  const savedEnv: Partial<Record<(typeof PERMIT_ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    for (const address of [OWNER_ADDRESS, REQUESTER_ADDRESS]) {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [address]);
    }
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  beforeEach(() => {
    for (const key of PERMIT_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = generatePrivateKey();
    process.env.CHAIN_ID = "31337";
    process.env.TASK_ESCROW_ADDRESS = "0x3333333333333333333333333333333333333333";
    process.env.YD_TOKEN_ADDRESS = "0x4444444444444444444444444444444444444444";
    process.env.YD_FAUCET_ADDRESS = "0x5555555555555555555555555555555555555555";
  });

  afterEach(async () => {
    for (const key of PERMIT_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    await pool.query("DELETE FROM acceptance_permits");
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  async function insertOpenTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertOpenTask: no id returned");
    return id;
  }

  async function signPermit(taskId: string, agentId: string): Promise<SignedAcceptancePermit> {
    const issued = await issueAcceptancePermit(
      deriveOnChainTaskId(taskId),
      OWNER_ADDRESS as `0x${string}`,
    );
    return {
      agentId,
      agentWalletAddress: OWNER_ADDRESS,
      nonce: issued.nonce.toString(),
      expiry: issued.expiry,
      chainId: issued.chainId,
      verifyingContract: issued.verifyingContract,
      signature: issued.signature,
    };
  }

  it("refuses a second recommendation run while the first round's permits are still unexpired", async () => {
    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);
    const permitA = await signPermit(taskId, agentA);
    const { runId: firstRunId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [permitA],
    });

    const agentB = await insertAgent(pool);
    const permitB = await signPermit(taskId, agentB);
    await expect(
      insertRecommendationRunWithPermits(pool, {
        taskId,
        algorithmVersion: "v0.1",
        candidateCount: 1,
        inputDigest: TEST_DIGEST,
        candidates: [
          { agentId: agentB, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["y"] },
        ],
        permits: [permitB],
      }),
    ).rejects.toThrow(PermitsStillOutstandingError);

    const { rows: runRows } = await pool.query(
      `SELECT id FROM recommendation_runs WHERE task_id = $1`,
      [taskId],
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.id).toBe(firstRunId);
  });

  it("combined: round 1's permit expires -> round 2 is allowed, invalidates round 1's row, and exact-nonce/run_id attribution + CONSUMED transition all work together on round 2's winner", async () => {
    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);

    // Round 1: persisted normally, then its permit is driven to an expired
    // state via direct SQL (equivalent to "an hour has passed") rather than
    // waiting a real hour — same technique this project's other expiry
    // tests use.
    const { runId: round1RunId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [await signPermit(taskId, agentA)],
    });
    await pool.query(`UPDATE acceptance_permits SET expiry = $2 WHERE run_id = $1`, [
      round1RunId,
      Math.floor(Date.now() / 1000) - 3600,
    ]);
    expect(await hasUnexpiredOutstandingPermits(pool, taskId)).toBe(false);

    // Round 2: now allowed (round 1's permit is expired, not just
    // INVALIDATED-by-flag) — a fresh candidate, fresh run.
    const agentB = await insertAgent(pool);
    const permitB = await signPermit(taskId, agentB);
    const { runId: round2RunId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentB, rank: 1, slotType: "TOP_SCORE", score: 0.8, reasons: ["y"] }],
      permits: [permitB],
    });
    expect(round2RunId).not.toBe(round1RunId);

    // Round 1's (already-expired) permit is now also marked INVALIDATED —
    // bookkeeping, confirmed separately from the expiry check above.
    const { rows: round1Rows } = await pool.query<{ status: string }>(
      `SELECT status FROM acceptance_permits WHERE run_id = $1`,
      [round1RunId],
    );
    expect(round1Rows[0]?.status).toBe("INVALIDATED");

    // getLatestRecommendationRunId correctly identifies round 2 as current.
    expect(await getLatestRecommendationRunId(pool, taskId)).toBe(round2RunId);

    // Exact-nonce attribution (T-806) resolves round 2's winner precisely —
    // scoped by (task_id, accepting_address, nonce), not by run_id, and
    // still correct now that run_id exists on every row.
    const resolvedAgentId = await resolveAcceptingAgentId(
      pool,
      taskId,
      OWNER_ADDRESS,
      permitB.nonce,
    );
    expect(resolvedAgentId).toBe(agentB);

    // CONSUMED transition + invalidation of every other OUTSTANDING row
    // (T-806's accept-time bookkeeping), now operating correctly on top of
    // the round-gated, run_id-bound schema.
    await consumeAcceptancePermits(pool, taskId, agentB, permitB.nonce, "0x" + "cd".repeat(32));
    await invalidateOtherOutstandingPermits(pool, taskId, agentB, permitB.nonce);

    const { rows: finalRows } = await pool.query<{
      agent_id: string;
      run_id: string;
      status: string;
      consumed_tx_hash: string | null;
    }>(
      `SELECT agent_id, run_id, status, consumed_tx_hash FROM acceptance_permits WHERE task_id = $1`,
      [taskId],
    );
    const winner = finalRows.find((r) => r.agent_id === agentB);
    expect(winner?.status).toBe("CONSUMED");
    expect(winner?.run_id).toBe(round2RunId);
    expect(winner?.consumed_tx_hash).toBe("0x" + "cd".repeat(32));
    // Every other row (round 1's already-INVALIDATED permit) stays
    // INVALIDATED, not flipped to CONSUMED.
    const others = finalRows.filter((r) => r.agent_id !== agentB);
    expect(others.every((r) => r.status === "INVALIDATED")).toBe(true);
  });

  it("insertPermitsForRunIfAbsent: idempotent reissue returns the existing OUTSTANDING permits unchanged, bound to the correct run_id", async () => {
    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);
    const permitA = await signPermit(taskId, agentA);
    const { runId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [permitA],
    });

    const reSigned = await signPermit(taskId, agentA);
    const second = await insertPermitsForRunIfAbsent(pool, {
      runId,
      taskId,
      permits: [reSigned],
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.nonce).toBe(permitA.nonce);
    expect(second[0]?.nonce).not.toBe(reSigned.nonce);

    const { rows } = await pool.query(`SELECT id FROM acceptance_permits WHERE run_id = $1`, [
      runId,
    ]);
    expect(rows).toHaveLength(1);

    const outstanding = await getOutstandingPermitsForRun(pool, runId);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.agentId).toBe(agentA);
  });

  it("insertPermitsForRunIfAbsent throws StaleRecommendationRunError when a newer run has superseded runId, once the superseded run's own permits have expired", async () => {
    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);
    const { runId: staleRunId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [],
    });
    // Simulates issuePermitsForTask (routes.ts) having read the stale run as
    // "latest" before a concurrent /match committed a newer one. Round A
    // was created with zero permits, so hasUnexpiredOutstandingPermits is
    // already false and round-gating does not block round B below.
    const agentB = await insertAgent(pool);
    const permitB = await signPermit(taskId, agentB);
    await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentB, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["y"] }],
      permits: [permitB],
    });

    const permitA = await signPermit(taskId, agentA);
    await expect(
      insertPermitsForRunIfAbsent(pool, { runId: staleRunId, taskId, permits: [permitA] }),
    ).rejects.toThrow(StaleRecommendationRunError);

    const { rows } = await pool.query(`SELECT id FROM acceptance_permits WHERE run_id = $1`, [
      staleRunId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("insertRecommendationRunWithPermits and insertPermitsForRunIfAbsent both throw TaskNotOpenForPermitsError and persist nothing when the task is no longer OPEN", async () => {
    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);
    const permitA = await signPermit(taskId, agentA);
    const { runId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [],
    });
    await pool.query(`UPDATE tasks SET status = 'ACCEPTED' WHERE id = $1`, [taskId]);

    await expect(
      insertRecommendationRunWithPermits(pool, {
        taskId,
        algorithmVersion: "v0.1",
        candidateCount: 1,
        inputDigest: TEST_DIGEST,
        candidates: [
          { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] },
        ],
        permits: [permitA],
      }),
    ).rejects.toThrow(TaskNotOpenForPermitsError);

    await expect(
      insertPermitsForRunIfAbsent(pool, { runId, taskId, permits: [permitA] }),
    ).rejects.toThrow(TaskNotOpenForPermitsError);

    const { rows } = await pool.query(`SELECT id FROM acceptance_permits WHERE task_id = $1`, [
      taskId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("input digest: identical logical input (different key order) produces the same digest, is persisted, and is queryable back from recommendation_runs", async () => {
    const a = canonicalJsonSha256({ taskId: "t1", candidates: [{ agentId: "a1", rank: 1 }] });
    const b = canonicalJsonSha256({ candidates: [{ rank: 1, agentId: "a1" }], taskId: "t1" });
    const c = canonicalJsonSha256({ taskId: "t2", candidates: [{ agentId: "a1", rank: 1 }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);

    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);
    const { runId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: a,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["x"] }],
      permits: [],
    });

    const { rows } = await pool.query<{ input_digest: string }>(
      `SELECT input_digest FROM recommendation_runs WHERE id = $1`,
      [runId],
    );
    expect(rows[0]?.input_digest).toBe(a);
  });

  // Human review finding (T-806, post-cap): issuePermitsForTask (routes.ts)
  // previously read candidates via getLatestRecommendationCandidates() and
  // the run id via a SEPARATE getLatestRecommendationRunId() call. If a
  // concurrent /match committed a newer run B in the gap between those two
  // reads, the function would sign run A's candidates but persist them
  // under run_id = B — insertPermitsForRunIfAbsent's own "is runId still
  // latest" recheck could not catch this, since B genuinely WAS latest by
  // the time it ran; the corruption was already baked into the mismatched
  // (candidates from A, runId of B) pair passed in. The fix: establish
  // runId FIRST, then read candidates scoped to that EXACT runId via
  // getRecommendationCandidatesForRun — never a second independent "latest"
  // lookup. This test proves that invariant directly: read run A's id, then
  // (simulating the concurrent /match landing in that exact window) create
  // run B, then confirm querying run A's candidates BY ITS OWN id still
  // returns exactly run A's original candidates — completely unaffected by
  // B's existence, because a recommendation_candidates row is immutable and
  // permanently tied to the run_id it was inserted under.
  it("getRecommendationCandidatesForRun scoped to an explicit runId is unaffected by a newer run being created afterward — a run's candidate snapshot can never be split across two rounds", async () => {
    const taskId = await insertOpenTask();
    const agentA = await insertAgent(pool);

    // Run A: zero permits, so round-gating does not block run B below (this
    // test is isolating the candidates/runId snapshot bug, not re-testing
    // round-gating, which has its own dedicated tests above).
    const { runId: runAId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["a"] }],
      permits: [],
    });

    // The exact sequence issuePermitsForTask now follows: establish runId
    // FIRST (this is what "reading run A's id" represents)...
    const observedRunId = await getLatestRecommendationRunId(pool, taskId);
    expect(observedRunId).toBe(runAId);

    // ...THEN, simulating a concurrent /match landing in the window between
    // that read and the candidates read, a newer run B is committed.
    const agentB = await insertAgent(pool);
    const { runId: runBId } = await insertRecommendationRunWithPermits(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 1,
      inputDigest: TEST_DIGEST,
      candidates: [{ agentId: agentB, rank: 1, slotType: "TOP_SCORE", score: 0.8, reasons: ["b"] }],
      permits: [],
    });
    expect(runBId).not.toBe(runAId);

    // Candidates read SCOPED TO THE ALREADY-ESTABLISHED runId (run A) — not
    // "latest" again. Must still be exactly run A's original candidate,
    // never run B's, regardless of B now being the actual latest run.
    const candidatesForA = await getRecommendationCandidatesForRun(pool, observedRunId as string);
    expect(candidatesForA).toHaveLength(1);
    expect(candidatesForA[0]?.agentId).toBe(agentA);

    // Sanity: run B's own candidates are exactly run B's, confirming the
    // scoping genuinely isolates the two rounds rather than coincidentally
    // returning the right answer.
    const candidatesForB = await getRecommendationCandidatesForRun(pool, runBId);
    expect(candidatesForB).toHaveLength(1);
    expect(candidatesForB[0]?.agentId).toBe(agentB);
  });
});
