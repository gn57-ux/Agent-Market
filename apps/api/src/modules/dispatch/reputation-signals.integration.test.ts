import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { assembleReputationSignals } from "./reputation-signals.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Real task_state_history/ratings/disputes/agents rows
// throughout — F-1307/F-1308/F-1309's window and missing-value rules are
// exactly the kind of off-by-one/boundary logic a mocked query would let
// slip through.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, " +
  "chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, " +
  "sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, schema_migrations CASCADE";

const OWNER_ADDRESS = "0x8283fefc63f0cd0e873a0000c6d07ef7b77e90d7";
const REQUESTER_ADDRESS = "0x9383fefc63f0cd0e873a0000c6d07ef7b77e90d8";
const TOKEN_ADDRESS = "0xa483fefc63f0cd0e873a0000c6d07ef7b77e90d9";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

runIfOptedIn("assembleReputationSignals (integration, Feature 13/T-1306)", () => {
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
    await pool.query("DELETE FROM disputes");
    await pool.query("DELETE FROM ratings");
    await pool.query("DELETE FROM task_state_history");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM agents");
  });

  async function insertAgent(completedTaskCount = 0): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agents (owner_address, name, description, category, payout_address, completed_task_count)
       VALUES ($1, 'Agent', 'desc', 'writing', $1, $2) RETURNING id`,
      [OWNER_ADDRESS, completedTaskCount],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertAgent: no id returned");
    return id;
  }

  async function insertTask(acceptedAgentId: string, deliveryDeadline: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks
         (requester_address, category, title, description, budget, token, delivery_deadline, status, accepted_agent_id, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, $3, 'RELEASED', $4, 'AUTOMATION')
       RETURNING id`,
      [REQUESTER_ADDRESS, TOKEN_ADDRESS, deliveryDeadline, acceptedAgentId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("insertTask: no id returned");
    return id;
  }

  /** Records the ONE settlement transition F-1307's window query reads.
   * toStatus/occurredAt are the two fields that actually drive the window
   * logic; from_status/actor are filled with plausible fixed values since
   * this query never reads them. */
  async function settleTask(taskId: string, toStatus: string, occurredAt: string): Promise<void> {
    await pool.query(
      `INSERT INTO task_state_history (task_id, from_status, to_status, actor, occurred_at)
       VALUES ($1, 'SUBMITTED', $2, $3, $4)`,
      [taskId, toStatus, REQUESTER_ADDRESS, occurredAt],
    );
  }

  async function insertRating(
    taskId: string,
    score: number,
    communicationScore: number | null = null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ratings (task_id, requester_address, score, communication_score)
       VALUES ($1, $2, $3, $4)`,
      [taskId, REQUESTER_ADDRESS, score, communicationScore],
    );
  }

  async function insertDispute(taskId: string): Promise<void> {
    await pool.query(
      `INSERT INTO disputes (task_id, requester_address, reason, evidence_summary, evidence_hash)
       VALUES ($1, $2, 'reason', 'summary', $3)`,
      [taskId, REQUESTER_ADDRESS, "0x" + "a".repeat(64)],
    );
  }

  // Digest shape helpers (Feature 13, T-1307): assembleReputationSignals
  // returns { value, sampleSize } per signal, not a bare number — these
  // shorten assertions without hiding which field is actually checked.
  function entry(value: number | null, sampleSize: number) {
    return { value, sampleSize };
  }

  // F-1309/F-1312's core sentinel: an Agent with zero lifetime completed
  // tasks must get ALL FIVE signals null (not just the four window-based
  // ones) — this is what routes ScoreV2 to the dedicated "no historical
  // sample" path instead of computing a real-but-trivial score. sampleSize
  // 0 throughout is F-1313's own record of WHY each value is null.
  it("returns all five signals null (sampleSize 0) for an Agent with zero completed tasks and no window history", async () => {
    const agentId = await insertAgent(0);
    const result = await assembleReputationSignals(pool, [agentId]);
    expect(result.get(agentId)).toEqual({
      completionRate: entry(null, 0),
      qualityFeedback: entry(null, 0),
      communication: entry(null, 0),
      disputeSignal: entry(null, 0),
      historicalScale: entry(null, 0),
    });
  });

  // An Agent can have real lifetime history (historicalScale computable)
  // while having settled nothing recently (the other four null) — F-1309
  // applies per-signal, not all-or-nothing, outside the zero-completed
  // sentinel case above. historicalScale's sampleSize is the lifetime
  // completedTaskCount itself (F-1313), not a window size.
  it("computes historicalScale alone when completedTaskCount > 0 but the window is empty", async () => {
    const agentId = await insertAgent(10);
    const result = await assembleReputationSignals(pool, [agentId]);
    expect(result.get(agentId)).toEqual({
      completionRate: entry(null, 0),
      qualityFeedback: entry(null, 0),
      communication: entry(null, 0),
      disputeSignal: entry(null, 0),
      historicalScale: entry(0.5, 10), // min(10/20, 1), sampleSize = completedTaskCount
    });
  });

  it("caps historicalScale at 1 when completedTaskCount exceeds the divisor", async () => {
    const agentId = await insertAgent(45);
    const result = await assembleReputationSignals(pool, [agentId]);
    expect(result.get(agentId)?.historicalScale).toEqual(entry(1, 45));
  });

  it("computes completionRate from real on-time vs late settlements within the window", async () => {
    const agentId = await insertAgent(3);
    const deadline = daysAgo(10);
    const onTimeTask = await insertTask(agentId, deadline);
    await settleTask(onTimeTask, "RELEASED", daysAgo(11)); // before the deadline

    const lateTask = await insertTask(agentId, deadline);
    await settleTask(lateTask, "RELEASED", daysAgo(5)); // after the deadline

    const result = await assembleReputationSignals(pool, [agentId]);
    const completionRate = result.get(agentId)?.completionRate;
    expect(completionRate?.value).toBeCloseTo(0.5, 9);
    expect(completionRate?.sampleSize).toBe(2);
  });

  it("treats settlement exactly at the deadline as on-time (boundary inclusive)", async () => {
    const agentId = await insertAgent(1);
    const deadline = daysAgo(10);
    const taskId = await insertTask(agentId, deadline);
    await settleTask(taskId, "RELEASED", deadline); // occurred_at === delivery_deadline

    const result = await assembleReputationSignals(pool, [agentId]);
    expect(result.get(agentId)?.completionRate).toEqual(entry(1, 1));
  });

  it("excludes a settlement older than the 90-day window", async () => {
    const agentId = await insertAgent(2);
    const deadline = daysAgo(200);
    const oldTask = await insertTask(agentId, deadline);
    await settleTask(oldTask, "RELEASED", daysAgo(91)); // just outside the window

    // Captured once and reused for both the deadline and the settlement
    // time (not two separate daysAgo(1) calls) — on_time's `<=` comparison
    // is otherwise a real race: insertTask's own async round trip happens
    // between the two calls, so a second, independently-computed daysAgo(1)
    // is measurably (if only by milliseconds) LATER than the first,
    // occasionally flipping this task from "on time" to "late" and making
    // this assertion flaky.
    const recentDeadline = daysAgo(1);
    const recentTask = await insertTask(agentId, recentDeadline);
    await settleTask(recentTask, "RELEASED", recentDeadline); // inside the window

    const result = await assembleReputationSignals(pool, [agentId]);
    // Only the recent task counts (sampleSize 1) — if the old one leaked
    // in, sampleSize would be 2 and completionRate would reflect 2 tasks.
    expect(result.get(agentId)?.completionRate).toEqual(entry(1, 1));
  });

  it("caps the window at the 50 most recent settled tasks", async () => {
    const agentId = await insertAgent(60);
    const deadline = daysAgo(1);
    // 55 total settled tasks, all within the 90-day window, 1-day spacing
    // for unambiguous recency ordering. The 45 MOST RECENT (daysAgo 1-45)
    // are never disputed; the 10 OLDEST (daysAgo 46-55) all are. If the
    // 50-task cap is applied correctly, it keeps daysAgo 1-50 — all 45
    // non-disputed plus only the 5 most recent disputed ones (46-50) — so
    // disputeSignal = 1 - 5/50 = 0.9 with sampleSize 50. Without the cap
    // (all 55 counted), it would instead be 1 - 10/55 ≈ 0.818 with
    // sampleSize 55 — the two are far enough apart to distinguish reliably.
    for (let i = 1; i <= 45; i += 1) {
      const taskId = await insertTask(agentId, deadline);
      await settleTask(taskId, "RELEASED", daysAgo(i));
    }
    for (let i = 46; i <= 55; i += 1) {
      const taskId = await insertTask(agentId, deadline);
      await settleTask(taskId, "RELEASED", daysAgo(i));
      await insertDispute(taskId);
    }

    const result = await assembleReputationSignals(pool, [agentId]);
    const disputeSignal = result.get(agentId)?.disputeSignal;
    expect(disputeSignal?.value).toBeCloseTo(0.9, 9);
    expect(disputeSignal?.sampleSize).toBe(50);
  }, 20000);

  // Codex review round 1 (P2), N6 QA: without a deterministic tiebreaker,
  // settlements sharing the exact same occurred_at that straddle the
  // 50-task cap could have Postgres pick an arbitrary subset as "inside"
  // the window on each execution — the same database state producing
  // different reputation signals (and downstream v0.2 scores) across
  // otherwise-identical calls, violating AC-1306. This constructs exactly
  // that tie (51 settlements, ALL sharing one captured-once timestamp,
  // straddling the 50-cap boundary by one) and proves the result is
  // byte-for-byte stable across many repeated calls.
  it("stays deterministic across repeated calls when settlements tie exactly at the 50-cap boundary", async () => {
    const agentId = await insertAgent(60);
    const deadline = daysAgo(1);
    const tiedOccurredAt = daysAgo(2); // captured once, reused for all 51
    for (let i = 0; i < 51; i += 1) {
      const taskId = await insertTask(agentId, deadline);
      await settleTask(taskId, "RELEASED", tiedOccurredAt);
      if (i % 2 === 0) {
        await insertDispute(taskId);
      }
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, () => assembleReputationSignals(pool, [agentId])),
    );
    const first = results[0]?.get(agentId);
    expect(first?.disputeSignal.sampleSize).toBe(50);
    for (const result of results.slice(1)) {
      expect(result.get(agentId)).toEqual(first);
    }
  }, 20000);

  it("computes qualityFeedback and communication independently, excluding tasks missing each", async () => {
    const agentId = await insertAgent(3);
    const deadline = daysAgo(1);

    const taskA = await insertTask(agentId, deadline);
    await settleTask(taskA, "RELEASED", daysAgo(2));
    await insertRating(taskA, 5, 4); // score=5 (norm 1.0), communication=4 (norm 0.75)

    const taskB = await insertTask(agentId, deadline);
    await settleTask(taskB, "RELEASED", daysAgo(2));
    await insertRating(taskB, 3, null); // score=3 (norm 0.5), no communication score

    const taskC = await insertTask(agentId, deadline);
    await settleTask(taskC, "RELEASED", daysAgo(2));
    // No rating submitted at all for taskC.

    const result = await assembleReputationSignals(pool, [agentId]);
    const signals = result.get(agentId);
    // qualityFeedback averages over taskA+taskB only (taskC has no rating
    // row) -> sampleSize 2, not the window's full 3.
    expect(signals?.qualityFeedback.value).toBeCloseTo((1.0 + 0.5) / 2, 9);
    expect(signals?.qualityFeedback.sampleSize).toBe(2);
    // communication averages over taskA only (taskB submitted no
    // communication score) -> sampleSize 1.
    expect(signals?.communication.value).toBeCloseTo(0.75, 9);
    expect(signals?.communication.sampleSize).toBe(1);
  });

  it("computes disputeSignal as 1 minus the disputed fraction of the window", async () => {
    const agentId = await insertAgent(4);
    const deadline = daysAgo(1);

    const disputedTask = await insertTask(agentId, deadline);
    await settleTask(disputedTask, "REFUNDED", daysAgo(2));
    await insertDispute(disputedTask);

    for (let i = 0; i < 3; i += 1) {
      const taskId = await insertTask(agentId, deadline);
      await settleTask(taskId, "RELEASED", daysAgo(2));
    }

    const result = await assembleReputationSignals(pool, [agentId]);
    // 1 disputed out of 4 settled -> 1 - 1/4 = 0.75, sampleSize 4.
    expect(result.get(agentId)?.disputeSignal).toEqual({ value: 0.75, sampleSize: 4 });
  });

  it("attributes signals to the correct agent when batching multiple agents in one call", async () => {
    const agentA = await insertAgent(0);
    const agentB = await insertAgent(20);
    const deadline = daysAgo(1);
    const taskForB = await insertTask(agentB, deadline);
    await settleTask(taskForB, "RELEASED", daysAgo(2));

    const result = await assembleReputationSignals(pool, [agentA, agentB]);
    expect(result.get(agentA)).toEqual({
      completionRate: entry(null, 0),
      qualityFeedback: entry(null, 0),
      communication: entry(null, 0),
      disputeSignal: entry(null, 0),
      historicalScale: entry(null, 0),
    });
    expect(result.get(agentB)?.completionRate).toEqual(entry(1, 1));
    expect(result.get(agentB)?.historicalScale).toEqual(entry(1, 20));
  });

  it("resolves to an empty map for an empty agentIds input, without querying", async () => {
    const result = await assembleReputationSignals(pool, []);
    expect(result.size).toBe(0);
  });
});
