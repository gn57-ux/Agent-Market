import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { closePool, getPool } from "./pool.js";

/**
 * T-2307 (Feature 23, AC-2307) — real fault-injection finding. Before this
 * Task's fix, `getPool()` returned a `pg.Pool` with no `'error'` listener
 * attached. node-postgres's own documented behavior: an IDLE pooled client
 * that the SERVER terminates (a real, ordinary event — a restart, an admin
 * `pg_terminate_backend`, a real `docker stop` on the database container,
 * which is literally how this was first discovered) emits an `'error'`
 * event on the `Pool`. With no listener, Node's default "unhandled 'error'
 * event" behavior is to THROW — which crashes the ENTIRE process, not just
 * fail one query. This test reproduces that exact failure mode for real,
 * using a second real admin connection to terminate the pool's own idle
 * backend (no docker container needed to make this fast/deterministic in
 * CI) — without the fix in `pool.ts`, this test file itself would crash the
 * vitest worker process instead of failing a normal assertion.
 *
 * Skipped unless a human opts in with RUN_DB_INTEGRATION_TESTS=1 against a
 * confirmed-safe TEST_DATABASE_URL, same convention as every other
 * Postgres-backed integration suite in this codebase.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

runIfOptedIn("getPool() idle-client error resilience (real Postgres, T-2307)", () => {
  afterAll(async () => {
    await closePool();
  });

  it("survives the server terminating an idle pooled connection — no crash, pool keeps working", async () => {
    const testDbUrl = requireTestDatabaseUrl();
    process.env.DATABASE_URL = testDbUrl;
    const pool = getPool();

    // Real query to ensure at least one real client is checked out and
    // then returned to the pool as genuinely idle — and to capture THIS
    // connection's own backend PID (N4 real finding, round 1, P2: the
    // original version terminated every idle backend in the whole test
    // database, which would disconnect other integration suites' own
    // connections when run concurrently in CI, making unrelated failures
    // nondeterministic — terminating only this one specific PID is a
    // real, self-contained fault injection instead).
    const pidResult = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const targetPid = pidResult.rows[0]?.pid;
    if (!targetPid) throw new Error("pg_backend_pid() returned no row");

    // A SEPARATE real admin connection terminates that ONE backend from
    // the server side — the exact real-world trigger (a restart, an
    // operator killing a connection, a dropped network path) this Task's
    // fix defends against.
    const admin = new Pool({ connectionString: testDbUrl });
    await admin.query("SELECT pg_terminate_backend($1)", [targetPid]);
    await admin.end();

    // Give the pool's 'error' event a real moment to fire — before the fix,
    // it would already have thrown (crashing the process) well before this
    // next line runs at all.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The pool must still be usable — it transparently opens a fresh
    // connection for this next query, exactly like it did after the real
    // Postgres-container restart this bug was originally found with.
    const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    expect(result.rows[0]?.ok).toBe(1);
  });
});
