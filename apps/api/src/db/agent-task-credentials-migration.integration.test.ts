import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";
import { requireTestDatabaseUrl } from "./test-support.js";
import { computeCredentialRef } from "../modules/agents/credential.js";

// See migrate.integration.test.ts's header comment: skipped unless a human
// opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. T-1200's own verification that
// 0013_add_agent_task_credentials.sql actually enforces, at the database
// layer, the constraints specs/12-agent-task-fields-credentials/
// requirements.md AC-1201 requires.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const OWNER_ADDRESS = "0x5283fefc63f0cd0e873a0000c6d07ef7b77e90d4";
const REQUESTER_ADDRESS = "0x6283fefc63f0cd0e873a0000c6d07ef7b77e90d5";
const TOKEN_ADDRESS = "0x7283fefc63f0cd0e873a0000c6d07ef7b77e90d6";

runIfOptedIn(
  "agents.protocol_version/credential_ref, tasks.expert_type migration (integration)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      await pool.query(`INSERT INTO users (address) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
        OWNER_ADDRESS,
        REQUESTER_ADDRESS,
      ]);
    });

    afterAll(async () => {
      await pool.query(
        "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, schema_migrations CASCADE",
      );
      await pool.end();
    });

    async function insertAgent(overrides: { protocolVersion?: string }) {
      return pool.query(
        `INSERT INTO agents (owner_address, name, description, category, payout_address, protocol_version)
       VALUES ($1, 'Test Agent', 'desc', 'writing', $1, $2)
       RETURNING id, protocol_version, credential_ref`,
        [OWNER_ADDRESS, overrides.protocolVersion ?? "v1"],
      );
    }

    // T-1300: credential_ref is now a deterministic function of the row's
    // own real id (0013's CHECK), which doesn't exist before the row is
    // inserted — so setting it is necessarily a second, separate UPDATE,
    // matching exactly what repository.ts's insertAgent does in the real
    // application code (never a value passed into the INSERT itself).
    async function setCredentialRef(agentId: string, credentialRef: string | null) {
      return pool.query<{ credential_ref: string | null }>(
        `UPDATE agents SET credential_ref = $2 WHERE id = $1 RETURNING credential_ref`,
        [agentId, credentialRef],
      );
    }

    async function insertTask(expertType: string) {
      return pool.query(
        `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT', $3)
       RETURNING expert_type`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS, expertType],
      );
    }

    it("defaults protocol_version to 'v1' and leaves credential_ref NULL when omitted", async () => {
      const { rows } = await pool.query<{
        protocol_version: string;
        credential_ref: string | null;
      }>(
        `INSERT INTO agents (owner_address, name, description, category, payout_address)
       VALUES ($1, 'Bare Agent', 'desc', 'writing', $1) RETURNING protocol_version, credential_ref`,
        [OWNER_ADDRESS],
      );
      expect(rows[0]?.protocol_version).toBe("v1");
      expect(rows[0]?.credential_ref).toBeNull();
    });

    it("rejects a protocol_version other than 'v1'", async () => {
      await expect(insertAgent({ protocolVersion: "v2" })).rejects.toThrow();
    });

    it("accepts setting credential_ref to exactly this row's own computed reference", async () => {
      const { rows: created } = await insertAgent({});
      const agentId = created[0]?.id as string;
      const expectedRef = computeCredentialRef(agentId);
      const { rows } = await setCredentialRef(agentId, expectedRef);
      expect(rows[0]?.credential_ref).toBe(expectedRef);
    });

    // T-1300 (Codex round 1, P1 — surfaced against this already-shipped
    // T-1203 code): the CHECK no longer accepts owner-chosen free text at
    // all — it requires credential_ref to equal EXACTLY `env://AGENT_` +
    // this row's own id (dashes stripped, hex uppercased). This is what
    // closes the front-running vector (an attacker pre-claiming a victim's
    // future env://AGENT_<victim id> reference before the operator
    // provisions it) — see the migration's own doc comment for the full
    // writeup.
    it("rejects a credential_ref that doesn't match the env://AGENT_<own id> shape at all", async () => {
      const { rows: created } = await insertAgent({});
      const agentId = created[0]?.id as string;
      await expect(setCredentialRef(agentId, "just-a-raw-string")).rejects.toThrow();
      await expect(setCredentialRef(agentId, "http://not-an-env-ref")).rejects.toThrow();
      await expect(
        setCredentialRef(agentId, `env://agent_${agentId.replace(/-/g, "")}`),
      ).rejects.toThrow();
    });

    it("rejects a credential_ref that doesn't start with the AGENT_ prefix, even though it's otherwise env:// shaped (P1 regression: arbitrary process env-var exfiltration)", async () => {
      const { rows: created } = await insertAgent({});
      const agentId = created[0]?.id as string;
      await expect(setCredentialRef(agentId, "env://DATABASE_URL")).rejects.toThrow();
      await expect(
        setCredentialRef(agentId, "env://ACCEPTANCE_PERMIT_SIGNER_KEY"),
      ).rejects.toThrow();
    });

    it("rejects a credential_ref that is exactly the AGENT_ prefix with an empty suffix", async () => {
      const { rows: created } = await insertAgent({});
      const agentId = created[0]?.id as string;
      await expect(setCredentialRef(agentId, "env://AGENT_")).rejects.toThrow();
    });

    // T-1300 (replaces the old free-text-reuse test): a well-formed
    // env://AGENT_<32-hex> reference is rejected UNLESS it's exactly this
    // row's own id — proving the binding is real, not just "any
    // AGENT_-prefixed 32-hex string is accepted."
    it("rejects a credential_ref that is well-formed but belongs to a DIFFERENT Agent's id", async () => {
      const { rows: agentA } = await insertAgent({});
      const { rows: agentB } = await insertAgent({});
      const idA = agentA[0]?.id as string;
      const idB = agentB[0]?.id as string;
      await expect(setCredentialRef(idA, computeCredentialRef(idB))).rejects.toThrow();
    });

    it("multiple Agents may each independently have NO credential configured (NULL doesn't collide with itself)", async () => {
      const { rows: agentA } = await insertAgent({});
      const { rows: agentB } = await insertAgent({});
      await setCredentialRef(agentA[0]?.id as string, null);
      await setCredentialRef(agentB[0]?.id as string, null);
    });

    it("accepts each of the 5 legal expert_type values", async () => {
      for (const expertType of [
        "DATA_ANALYSIS",
        "CONTENT_GENERATION",
        "SOFTWARE_DEVELOPMENT",
        "RESEARCH",
        "AUTOMATION",
      ]) {
        const { rows } = await insertTask(expertType);
        expect(rows[0]?.expert_type).toBe(expertType);
      }
    });

    it("rejects an unrecognized expert_type (including a lowercase variant)", async () => {
      await expect(insertTask("data_analysis")).rejects.toThrow();
      await expect(insertTask("PROJECT_MANAGEMENT")).rejects.toThrow();
    });

    // T-1201b (2026-08-30) dropped the compatibility DEFAULT this test used
    // to lock in — `runMigrations` in this file's `beforeAll` now always
    // applies 0014_drop_expert_type_default.sql too, so omitting
    // expert_type here would (correctly) throw, not default to AUTOMATION.
    // The "before" and "after" halves of that transition are both proven
    // with real DB evidence in drop-expert-type-default-migration.
    // integration.test.ts instead (the "after" state directly, and the
    // "before" state via that same file's rollback-then-insert test) —
    // this file's own scope is 0013 in isolation, which no longer exists
    // as an independently-observable state once 0014 is also on disk.

    it("rollback removes all three columns and the schema_migrations row, and the migration can be reapplied", async () => {
      // Codex review (T-1201b round 1, P2): 0014_drop_expert_type_default.sql
      // depends on 0013's expert_type column existing — rolling back 0013
      // alone while 0014's schema_migrations row is left in place would
      // record 0014 as "applied" even though 0013's rollback just dropped
      // the very column it modified. A later `runMigrations` call would
      // then see 0014 as already-applied and skip it, silently leaving
      // expert_type with its DEFAULT once 0013 is reapplied — the opposite
      // of what this codebase's actual final schema requires. 0014 must be
      // rolled back first, matching real dependency order.
      const rollbackDir = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../migrations/rollback",
      );
      const fs = await import("node:fs");
      await pool.query(
        fs.readFileSync(
          path.join(rollbackDir, "0014_drop_expert_type_default.rollback.sql"),
          "utf8",
        ),
      );
      await pool.query(
        fs.readFileSync(
          path.join(rollbackDir, "0013_add_agent_task_credentials.rollback.sql"),
          "utf8",
        ),
      );

      const { rows: columns } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('agents', 'tasks')
         AND column_name IN ('protocol_version', 'credential_ref', 'expert_type')`,
      );
      expect(columns).toHaveLength(0);

      const { rows: migrationRows } = await pool.query(
        `SELECT id FROM schema_migrations WHERE id IN ('0013_add_agent_task_credentials.sql', '0014_drop_expert_type_default.sql')`,
      );
      expect(migrationRows).toHaveLength(0);

      // Reapply (up/down/up): both migrations must be idempotently
      // re-runnable after a rollback, and the final state must match the
      // real current schema — expert_type has no DEFAULT once 0014 has
      // genuinely re-run, not merely been skipped as already-applied.
      const result = await runMigrations(pool, migrationsDir);
      expect(result.applied).toEqual([
        "0013_add_agent_task_credentials.sql",
        "0014_drop_expert_type_default.sql",
      ]);

      await expect(
        pool.query(
          `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status)
           VALUES ($1, 'writing', 'Task', 'desc', '1000', $2, '2033-01-01T00:00:00Z', 'DRAFT')`,
          [REQUESTER_ADDRESS, TOKEN_ADDRESS],
        ),
      ).rejects.toThrow();
    });
  },
);
