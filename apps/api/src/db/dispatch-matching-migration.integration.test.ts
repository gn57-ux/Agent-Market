import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";

// See tasks-migration.integration.test.ts's header comment: skipped unless
// a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite is T-700's dedicated verification that
// 0006_add_dispatch_matching_fields.sql actually enforces, at the database
// layer, what specs/07-dispatch-matching/requirements.md's AC-710/AC-711
// require: the level/required_agent_level CHECK constraints, the
// max_concurrent_tasks range, the accepted_agent_id foreign key, the
// accepted_agent_address format, that occupancy counting is scoped by
// agent_id (never by wallet address, since one wallet can own multiple
// Agents whose occupancy must not blend), and blocked_wallets' own
// self-contained constraints (PK uniqueness, address format, no FK
// requirement on users). The behavioral parts of AC-711 — eligibility
// actually eliminating a banned candidate, batching the lookup instead of
// querying per-candidate, and keeping `reason` out of any Go request/API
// response — are application-layer concerns that belong to T-701/T-705
// (same Task-boundary convention this suite already follows for
// countActiveTasksByAgentIds, which T-705 implements, not this suite).
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const OWNER_ADDRESS = "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3";
const REQUESTER_ADDRESS = "0x5583fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const TOKEN_ADDRESS = "0x6683fefc63f0cd0e873a0000c6d07ef7b77e90d5";
const AGENT_ADDRESS_A = "0x7783fefc63f0cd0e873a0000c6d07ef7b77e90d6";

function insertAgent(pool: Pool, overrides: Partial<Record<string, unknown>> = {}) {
  const values = {
    owner_address: OWNER_ADDRESS,
    name: "Test Agent",
    description: "desc",
    category: "writing",
    payout_address: OWNER_ADDRESS,
    level: undefined as string | undefined,
    max_concurrent_tasks: undefined as number | undefined,
    ...overrides,
  };
  const columns = ["owner_address", "name", "description", "category", "payout_address"];
  const params: unknown[] = [
    values.owner_address,
    values.name,
    values.description,
    values.category,
    values.payout_address,
  ];
  if (values.level !== undefined) {
    columns.push("level");
    params.push(values.level);
  }
  if (values.max_concurrent_tasks !== undefined) {
    columns.push("max_concurrent_tasks");
    params.push(values.max_concurrent_tasks);
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  return pool.query<{ id: string; level: string; max_concurrent_tasks: number }>(
    `INSERT INTO agents (${columns.join(", ")})
     VALUES (${placeholders})
     RETURNING id, level, max_concurrent_tasks`,
    params,
  );
}

function insertTask(pool: Pool, overrides: Partial<Record<string, unknown>> = {}) {
  const values = {
    requester_address: REQUESTER_ADDRESS,
    category: "writing",
    title: "Test Task",
    description: "desc",
    budget: "1000",
    token: TOKEN_ADDRESS,
    delivery_deadline: "2030-01-01T00:00:00Z",
    status: "DRAFT",
    required_agent_level: undefined as string | undefined,
    accepted_agent_id: undefined as string | null | undefined,
    accepted_agent_address: undefined as string | null | undefined,
    ...overrides,
  };
  const columns = [
    "requester_address",
    "category",
    "title",
    "description",
    "budget",
    "token",
    "delivery_deadline",
    "status",
    // T-1201b: 0014_drop_expert_type_default.sql removed the column's
    // compatibility DEFAULT — every raw INSERT INTO tasks in this codebase
    // (production or test fixture) must now supply it explicitly.
    "expert_type",
  ];
  const params: unknown[] = [
    values.requester_address,
    values.category,
    values.title,
    values.description,
    values.budget,
    values.token,
    values.delivery_deadline,
    values.status,
    "AUTOMATION",
  ];
  if (values.required_agent_level !== undefined) {
    columns.push("required_agent_level");
    params.push(values.required_agent_level);
  }
  if (values.accepted_agent_id !== undefined) {
    columns.push("accepted_agent_id");
    params.push(values.accepted_agent_id);
  }
  if (values.accepted_agent_address !== undefined) {
    columns.push("accepted_agent_address");
    params.push(values.accepted_agent_address);
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  return pool.query<{
    id: string;
    required_agent_level: string;
    accepted_agent_id: string | null;
    accepted_agent_address: string | null;
    accepted_at: string | null;
  }>(
    `INSERT INTO tasks (${columns.join(", ")})
     VALUES (${placeholders})
     RETURNING id, required_agent_level, accepted_agent_id, accepted_agent_address, accepted_at`,
    params,
  );
}

runIfOptedIn("dispatch-matching fields migration (integration, AC-710)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      OWNER_ADDRESS,
    ]);
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      REQUESTER_ADDRESS,
    ]);
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, schema_migrations CASCADE",
    );
    await pool.end();
  });

  // 1. agents.level
  it("defaults a new agent's level to BEGINNER when not supplied", async () => {
    const { rows } = await insertAgent(pool);
    expect(rows[0]?.level).toBe("BEGINNER");
  });

  it("accepts all three legal agent levels", async () => {
    for (const level of ["BEGINNER", "INTERMEDIATE", "EXPERT"]) {
      const { rows } = await insertAgent(pool, { level });
      expect(rows[0]?.level).toBe(level);
    }
  });

  it("rejects an agent level outside the three-value enum", async () => {
    await expect(insertAgent(pool, { level: "GOD" })).rejects.toThrow(/agents_level_check|check/i);
  });

  // 2. tasks.required_agent_level
  it("defaults a new task's required_agent_level to BEGINNER when not supplied", async () => {
    const { rows } = await insertTask(pool);
    expect(rows[0]?.required_agent_level).toBe("BEGINNER");
  });

  it("accepts all three legal required_agent_level values", async () => {
    for (const level of ["BEGINNER", "INTERMEDIATE", "EXPERT"]) {
      const { rows } = await insertTask(pool, { required_agent_level: level });
      expect(rows[0]?.required_agent_level).toBe(level);
    }
  });

  it("rejects a required_agent_level outside the three-value enum", async () => {
    await expect(insertTask(pool, { required_agent_level: "GOD" })).rejects.toThrow(/check/i);
  });

  // 3. agents.max_concurrent_tasks
  it("defaults max_concurrent_tasks to 1 when not supplied", async () => {
    const { rows } = await insertAgent(pool);
    expect(rows[0]?.max_concurrent_tasks).toBe(1);
  });

  it("accepts the 1 and 100 boundary values", async () => {
    const low = await insertAgent(pool, { max_concurrent_tasks: 1 });
    expect(low.rows[0]?.max_concurrent_tasks).toBe(1);
    const high = await insertAgent(pool, { max_concurrent_tasks: 100 });
    expect(high.rows[0]?.max_concurrent_tasks).toBe(100);
  });

  it("rejects max_concurrent_tasks outside the 1..100 range", async () => {
    await expect(insertAgent(pool, { max_concurrent_tasks: 0 })).rejects.toThrow(/check/i);
    await expect(insertAgent(pool, { max_concurrent_tasks: 101 })).rejects.toThrow(/check/i);
    await expect(insertAgent(pool, { max_concurrent_tasks: -1 })).rejects.toThrow(/check/i);
  });

  // 4. tasks.accepted_agent_id foreign key
  it("allows accepted_agent_id to be NULL", async () => {
    const { rows } = await insertTask(pool, { accepted_agent_id: null });
    expect(rows[0]?.accepted_agent_id).toBeNull();
  });

  it("rejects accepted_agent_id referencing a non-existent agent", async () => {
    await expect(
      insertTask(pool, { accepted_agent_id: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("accepts accepted_agent_id referencing a real agent", async () => {
    const { rows: agentRows } = await insertAgent(pool);
    const agentId = agentRows[0]?.id;
    const { rows: taskRows } = await insertTask(pool, { accepted_agent_id: agentId });
    expect(taskRows[0]?.accepted_agent_id).toBe(agentId);
  });

  // 5. tasks.accepted_agent_address format
  it("rejects a non-normalized accepted_agent_address", async () => {
    await expect(
      insertTask(pool, { accepted_agent_address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01" }),
    ).rejects.toThrow(/check/i);
    await expect(insertTask(pool, { accepted_agent_address: "not-an-address" })).rejects.toThrow(
      /check/i,
    );
  });

  it("accepts a lowercase-normalized accepted_agent_address, and allows NULL", async () => {
    const withAddress = await insertTask(pool, { accepted_agent_address: AGENT_ADDRESS_A });
    expect(withAddress.rows[0]?.accepted_agent_address).toBe(AGENT_ADDRESS_A);
    const withoutAddress = await insertTask(pool, { accepted_agent_address: null });
    expect(withoutAddress.rows[0]?.accepted_agent_address).toBeNull();
  });

  // 6. concurrent-capacity is scoped by agent_id, never by wallet address —
  // two Agents sharing one owner wallet must not blend occupancy.
  it("scopes occupancy by agent_id: one wallet owning two Agents keeps their occupancy separate", async () => {
    const sharedOwner = "0x9983fefc63f0cd0e873a0000c6d07ef7b77e90d8";
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      sharedOwner,
    ]);
    const { rows: agentARows } = await insertAgent(pool, {
      owner_address: sharedOwner,
      payout_address: sharedOwner,
    });
    const { rows: agentBRows } = await insertAgent(pool, {
      owner_address: sharedOwner,
      payout_address: sharedOwner,
    });
    const agentAId = agentARows[0]?.id;
    const agentBId = agentBRows[0]?.id;
    expect(agentAId).not.toBe(agentBId);

    await insertTask(pool, {
      status: "ACCEPTED",
      accepted_agent_id: agentAId,
      accepted_agent_address: AGENT_ADDRESS_A,
    });
    await insertTask(pool, {
      status: "ACCEPTED",
      accepted_agent_id: agentAId,
      accepted_agent_address: AGENT_ADDRESS_A,
    });

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM tasks WHERE accepted_agent_id = $1 AND status IN ('ACCEPTED','SUBMITTED','DISPUTED')`,
      [agentAId],
    );
    expect(Number(countRows[0]?.count)).toBe(2);

    const { rows: bCountRows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM tasks WHERE accepted_agent_id = $1 AND status IN ('ACCEPTED','SUBMITTED','DISPUTED')`,
      [agentBId],
    );
    expect(Number(bCountRows[0]?.count)).toBe(0);
  });

  // 7. Occupancy status set: ACCEPTED/SUBMITTED/DISPUTED count, others don't.
  it("counts only ACCEPTED/SUBMITTED/DISPUTED tasks toward an agent's occupancy", async () => {
    const { rows: agentRows } = await insertAgent(pool);
    const agentId = agentRows[0]?.id;

    const occupying = ["ACCEPTED", "SUBMITTED", "DISPUTED"];
    const notOccupying = ["OPEN", "DRAFT", "AWAITING_FUNDING", "RELEASED", "REFUNDED", "CANCELLED"];

    for (const status of occupying) {
      await insertTask(pool, { status, accepted_agent_id: agentId });
    }
    for (const status of notOccupying) {
      await insertTask(pool, { status, accepted_agent_id: agentId });
    }

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM tasks WHERE accepted_agent_id = $1 AND status IN ('ACCEPTED','SUBMITTED','DISPUTED')`,
      [agentId],
    );
    expect(Number(rows[0]?.count)).toBe(occupying.length);
  });

  // blocked_wallets (F-712/AC-711) — DB-level constraint verification only;
  // eligibility elimination, batch-not-N+1 querying, and keeping `reason`
  // out of any Go request/API response are T-701/T-705's behavioral tests.
  it("blocks a wallet that already belongs to a registered Agent", async () => {
    await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
      AGENT_ADDRESS_A,
    ]);
    const { rows: agentRows } = await insertAgent(pool, {
      owner_address: AGENT_ADDRESS_A,
      payout_address: AGENT_ADDRESS_A,
    });
    const { rows: blockedRows } = await pool.query<{ address: string }>(
      `INSERT INTO blocked_wallets (address, reason) VALUES ($1, $2) RETURNING address`,
      [AGENT_ADDRESS_A, "fraud report"],
    );
    expect(blockedRows[0]?.address).toBe(AGENT_ADDRESS_A);
    expect(agentRows[0]?.id).toBeTruthy();
  });

  it("allows blocking a wallet that has never registered on this platform (no FK to users)", async () => {
    const neverRegistered = "0xaa83fefc63f0cd0e873a0000c6d07ef7b77e90d9";
    const { rows } = await pool.query<{ address: string }>(
      `INSERT INTO blocked_wallets (address) VALUES ($1) RETURNING address`,
      [neverRegistered],
    );
    expect(rows[0]?.address).toBe(neverRegistered);
  });

  it("rejects a non-lowercase-normalized address in blocked_wallets", async () => {
    await expect(
      pool.query(`INSERT INTO blocked_wallets (address) VALUES ($1)`, [
        "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
      ]),
    ).rejects.toThrow(/check/i);
  });

  it("rejects a duplicate address insert into blocked_wallets (primary key)", async () => {
    const address = "0xbb83fefc63f0cd0e873a0000c6d07ef7b77e90da";
    await pool.query(`INSERT INTO blocked_wallets (address) VALUES ($1)`, [address]);
    await expect(
      pool.query(`INSERT INTO blocked_wallets (address) VALUES ($1)`, [address]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows a NULL reason and defaults blocked_at", async () => {
    const address = "0xcc83fefc63f0cd0e873a0000c6d07ef7b77e90db";
    const { rows } = await pool.query<{ reason: string | null; blocked_at: string }>(
      `INSERT INTO blocked_wallets (address) VALUES ($1) RETURNING reason, blocked_at`,
      [address],
    );
    expect(rows[0]?.reason).toBeNull();
    expect(rows[0]?.blocked_at).toBeTruthy();
  });

  it("lets an unblocked wallet's address simply not appear in a batch blocked_wallets lookup", async () => {
    const notBlocked = "0xdd83fefc63f0cd0e873a0000c6d07ef7b77e90dc";
    const { rows } = await pool.query<{ address: string }>(
      `SELECT address FROM blocked_wallets WHERE address = ANY($1)`,
      [[notBlocked]],
    );
    expect(rows).toEqual([]);
  });

  // 9. Existing-data compatibility: a pre-migration-style insert (no new
  // columns supplied) backfills every new column to its documented default.
  it("backfills existing-style inserts (no new columns supplied) to documented defaults", async () => {
    const { rows: agentRows } = await insertAgent(pool);
    expect(agentRows[0]?.level).toBe("BEGINNER");
    expect(agentRows[0]?.max_concurrent_tasks).toBe(1);

    const { rows: taskRows } = await insertTask(pool);
    expect(taskRows[0]?.required_agent_level).toBe("BEGINNER");
    expect(taskRows[0]?.accepted_agent_id).toBeNull();
    expect(taskRows[0]?.accepted_agent_address).toBeNull();
    expect(taskRows[0]?.accepted_at).toBeNull();
  });

  // 8. migration up/down repeatability — actually executes the rollback SQL
  // file (not just asserted-by-comment) against the real database, verifies
  // the added columns/index/schema_migrations row are gone, then re-applies
  // the forward migration and verifies everything comes back (Codex review,
  // T-700 round 1, P2: the earlier version of this suite claimed
  // migrate.integration.test.ts covered this, but that file only exercises
  // forward-apply idempotency and never runs 0006's rollback script at all).
  // Placed last in this file since it drops the columns every other test in
  // this suite depends on.
  it("rollback SQL removes all added columns/index/migration record, and the forward migration re-applies cleanly afterward", async () => {
    const rollbackSqlPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../migrations/rollback/0006_add_dispatch_matching_fields.rollback.sql",
    );
    const rollbackSql = await readFile(rollbackSqlPath, "utf8");
    await pool.query(rollbackSql);

    const { rows: columnRows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'agents' AND column_name IN ('level', 'max_concurrent_tasks'))
          OR (table_name = 'tasks' AND column_name IN (
               'required_agent_level', 'accepted_agent_id', 'accepted_agent_address', 'accepted_at'
             ))`,
    );
    expect(columnRows).toEqual([]);

    const { rows: indexRows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'tasks_accepted_agent_status_idx'`,
    );
    expect(indexRows).toEqual([]);

    const { rows: blockedWalletsTableRows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'blocked_wallets'`,
    );
    expect(blockedWalletsTableRows).toEqual([]);

    const { rows: migrationRows } = await pool.query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = '0006_add_dispatch_matching_fields.sql'`,
    );
    expect(migrationRows).toEqual([]);

    // Re-apply: the forward migration must succeed cleanly a second time
    // (this is what "up/down repeatable" actually means — not just that
    // rollback ran once).
    const reapplyResult = await runMigrations(pool, migrationsDir);
    expect(reapplyResult.applied).toEqual(["0006_add_dispatch_matching_fields.sql"]);

    const { rows: agentRows } = await insertAgent(pool);
    expect(agentRows[0]?.level).toBe("BEGINNER");
    const { rows: taskRows } = await insertTask(pool);
    expect(taskRows[0]?.required_agent_level).toBe("BEGINNER");
    const { rows: blockedRows } = await pool.query<{ address: string }>(
      `INSERT INTO blocked_wallets (address) VALUES ($1) RETURNING address`,
      ["0xee83fefc63f0cd0e873a0000c6d07ef7b77e90dd"],
    );
    expect(blockedRows[0]?.address).toBe("0xee83fefc63f0cd0e873a0000c6d07ef7b77e90dd");
  });
});
