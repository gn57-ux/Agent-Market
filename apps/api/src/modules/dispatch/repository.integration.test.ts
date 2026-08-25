import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import {
  assembleCandidateSnapshots,
  insertRecommendationRunWithPermits,
  resolveAcceptingAgentId,
  type SignedAcceptancePermit,
} from "./repository.js";

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
  "DROP TABLE IF EXISTS recommendation_candidates, recommendation_runs, acceptance_permits, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, blocked_wallets, agent_skills, agents, " +
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
       (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id)
     VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', $3, $4)`,
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
         (requester_address, category, title, description, budget, token, delivery_deadline, status)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN')
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

    // T-806, user's item #1's last sentence: concurrent repeated `/match`
    // calls for the SAME task must each complete their own three-table write
    // as an uninterrupted unit — no interleaving, and no rejection either
    // (repeated /match is a legitimate operation, not something to block).
    it("serializes two concurrent calls for the same task — both succeed, each with its own complete run/candidates/permits, no cross-write", async () => {
      const taskId = await insertOpenTask();
      const agentA = await insertAgent(pool);
      const agentB = await insertAgent(pool);

      const [resultA, resultB] = await Promise.all([
        insertRecommendationRunWithPermits(pool, {
          taskId,
          algorithmVersion: "v0.1",
          candidateCount: 1,
          candidates: [
            { agentId: agentA, rank: 1, slotType: "TOP_SCORE", score: 0.9, reasons: ["a"] },
          ],
          permits: [buildSignedPermit(agentA, { nonce: "301" })],
        }),
        insertRecommendationRunWithPermits(pool, {
          taskId,
          algorithmVersion: "v0.1",
          candidateCount: 1,
          candidates: [
            { agentId: agentB, rank: 1, slotType: "TOP_SCORE", score: 0.8, reasons: ["b"] },
          ],
          permits: [buildSignedPermit(agentB, { nonce: "302" })],
        }),
      ]);

      expect(resultA.runId).not.toBe(resultB.runId);

      const { rows: runRows } = await pool.query<{ id: string }>(
        `SELECT id FROM recommendation_runs WHERE task_id = $1`,
        [taskId],
      );
      expect(runRows).toHaveLength(2);

      // Every candidate row belongs to its OWN run — no cross-write (e.g. run
      // A's candidate ending up attached to run B).
      const { rows: candidateRows } = await pool.query<{ run_id: string; agent_id: string }>(
        `SELECT rc.run_id, rc.agent_id FROM recommendation_candidates rc
       JOIN recommendation_runs rr ON rr.id = rc.run_id
       WHERE rr.task_id = $1`,
        [taskId],
      );
      expect(candidateRows).toHaveLength(2);
      const runIdForA = candidateRows.find((r) => r.agent_id === agentA)?.run_id;
      const runIdForB = candidateRows.find((r) => r.agent_id === agentB)?.run_id;
      expect(runIdForA).toBe(resultA.runId);
      expect(runIdForB).toBe(resultB.runId);

      const { rows: permitRows } = await pool.query<{ agent_id: string; nonce: string }>(
        `SELECT agent_id, nonce FROM acceptance_permits WHERE task_id = $1 ORDER BY nonce`,
        [taskId],
      );
      expect(permitRows).toHaveLength(2);
      expect(permitRows.map((r) => `${r.agent_id}:${r.nonce}`).sort()).toEqual(
        [`${agentA}:301`, `${agentB}:302`].sort(),
      );
    });
  },
);

describe("resolveAcceptingAgentId (integration, T-806)", () => {
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
         (requester_address, category, title, description, budget, token, delivery_deadline, status)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN')
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
