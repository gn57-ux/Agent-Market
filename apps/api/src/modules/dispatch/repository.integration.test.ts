import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { assembleCandidateSnapshots, insertRecommendationRun } from "./repository.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-705's dedicated verification that
// assembleCandidateSnapshots correctly reads real agents/agent_skills/
// blocked_wallets data into the wire-format CandidateSnapshot[] POST /match
// expects, and that insertRecommendationRun persists a run + its candidates
// atomically.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS recommendation_candidates, recommendation_runs, task_state_history, " +
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

runIfOptedIn("assembleCandidateSnapshots / insertRecommendationRun (integration, T-705)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    for (const address of [OWNER_ADDRESS, BANNED_OWNER_ADDRESS, REQUESTER_ADDRESS]) {
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [address]);
    }
  });

  afterAll(async () => {
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM recommendation_candidates");
    await pool.query("DELETE FROM recommendation_runs");
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

  it("insertRecommendationRun persists the run and its candidates atomically", async () => {
    const agentId = await insertAgent(pool);
    const taskInsert = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2030-01-01T00:00:00Z', 'OPEN')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS],
    );
    const taskId = taskInsert.rows[0]?.id;
    if (!taskId) throw new Error("task insert returned no id");

    const { runId } = await insertRecommendationRun(pool, {
      taskId,
      algorithmVersion: "v0.1",
      candidateCount: 5,
      candidates: [{ agentId, rank: 1, slotType: "TOP_SCORE", score: 0.87, reasons: ["技能匹配"] }],
    });

    const { rows: runRows } = await pool.query<{
      candidate_count: number;
      algorithm_version: string;
    }>(`SELECT candidate_count, algorithm_version FROM recommendation_runs WHERE id = $1`, [runId]);
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
  });
});
