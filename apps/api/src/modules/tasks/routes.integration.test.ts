import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. Proves T-602's F-601 (POST /tasks/drafts, idempotency
// key), F-602 (PATCH /tasks/:taskId/draft), and AC-601 (draft carries
// category/tags/budget/deadline) end to end through the real HTTP route
// against a real database — not just schema.ts's Zod rules in isolation.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const VALID_DRAFT_PAYLOAD = {
  category: "writing",
  skillTags: ["copywriting", "seo"],
  title: "Write a landing page",
  description: "Need 500 words of marketing copy.",
  budget: "125500000000000000000",
  deliveryDeadline: "2099-01-01T00:00:00.000Z",
  expertType: "CONTENT_GENERATION",
};

runIfOptedIn(
  "POST /tasks/drafts, PATCH /tasks/:taskId/draft (integration, F-601/F-602/AC-601)",
  () => {
    let pool: Pool;
    let app: ReturnType<typeof buildApp>;
    const requester = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      app = buildApp({ pool });
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      await pool.query("DELETE FROM task_state_history");
      await pool.query("DELETE FROM chain_events");
      await pool.query("DELETE FROM chain_transactions");
      await pool.query("DELETE FROM task_skills");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM sessions");
      await pool.query("DELETE FROM auth_nonces");
      await pool.query("DELETE FROM users");
    });

    async function login(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
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
      if (!match?.[1]) throw new Error("no session_token cookie in verify response");
      return match[1];
    }

    async function createDraft(
      token: string,
      payload: Partial<typeof VALID_DRAFT_PAYLOAD> = {},
      idempotencyKey?: string,
    ) {
      return app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: token },
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
        payload: { ...VALID_DRAFT_PAYLOAD, ...payload },
      });
    }

    it("creates a DRAFT task with the submitted fields, stored correctly in the database (AC-601)", async () => {
      const token = await login(requester);
      const response = await createDraft(token);
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.status).toBe("DRAFT");
      expect(typeof body.taskId).toBe("string");

      const { rows } = await pool.query(
        `SELECT requester_address, category, title, description, budget, delivery_deadline, status
       FROM tasks WHERE id = $1`,
        [body.taskId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.requester_address).toBe(requester.address.toLowerCase());
      expect(row.category).toBe(VALID_DRAFT_PAYLOAD.category);
      expect(row.title).toBe(VALID_DRAFT_PAYLOAD.title);
      expect(row.description).toBe(VALID_DRAFT_PAYLOAD.description);
      expect(row.budget).toBe("125500000000000000000");
      expect(row.status).toBe("DRAFT");

      const skillTagsResult = await pool.query(
        `SELECT skill_tag FROM task_skills WHERE task_id = $1 ORDER BY skill_tag`,
        [body.taskId],
      );
      expect(skillTagsResult.rows.map((r) => r.skill_tag)).toEqual(["copywriting", "seo"]);
    });

    it("returns skillTags on the create response body itself, and on a subsequent GET /tasks/:taskId (P1 regression: task detail showed 无标签 after real creation)", async () => {
      const token = await login(requester);
      const createResponse = await createDraft(token);
      expect(createResponse.statusCode).toBe(201);
      const createBody = createResponse.json();
      expect(createBody.skillTags).toEqual(["copywriting", "seo"]);

      const getResponse = await app.inject({
        method: "GET",
        url: `/tasks/${createBody.taskId}`,
        cookies: { session_token: token },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json().skillTags).toEqual(["copywriting", "seo"]);
    });

    it("round-trips a large minimal-unit integer budget byte-identical through create + PATCH", async () => {
      // `budget` is a minimal-unit (wei-equivalent) unsigned integer string
      // — never a human decimal (schema.ts's BUDGET_SCHEMA comment: T-604
      // hands this straight to TaskEscrow.createTask's `uint256 budget`).
      // This is still a real precision-preservation test: a 30-digit
      // integer well beyond JS's safe-integer range must survive
      // create/PATCH byte-identical, proving the string never gets coerced
      // through a JS `number` anywhere on the way to/from NUMERIC.
      const token = await login(requester);
      const largeBudget = "100000000000000000000000000001";
      const createResponse = await createDraft(token, { budget: largeBudget });
      expect(createResponse.statusCode).toBe(201);
      const taskId = createResponse.json().taskId;

      const { rows: afterCreate } = await pool.query(`SELECT budget FROM tasks WHERE id = $1`, [
        taskId,
      ]);
      expect(afterCreate[0].budget).toBe(largeBudget);

      // An unrelated PATCH (doesn't mention budget) must not disturb the
      // stored precision, mirroring agents/mutations.integration.test.ts's
      // referencePrice regression test.
      const unrelatedEdit = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { title: "Renamed" },
      });
      expect(unrelatedEdit.statusCode).toBe(200);
      expect(unrelatedEdit.json().budget).toBe(largeBudget);

      // A PATCH that explicitly sets a new large integer budget also
      // round-trips byte-identical.
      const otherLargeBudget = "999999999999999999123456789012345678";
      const editBudget = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { budget: otherLargeBudget },
      });
      expect(editBudget.statusCode).toBe(200);
      expect(editBudget.json().budget).toBe(otherLargeBudget);
    });

    it("rejects a decimal budget with 400 (budget is a minimal-unit integer, not a human decimal)", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { budget: "125.5" });
      expect(response.statusCode).toBe(400);
    });

    it("returns the same taskId for a repeated Idempotency-Key with the IDENTICAL payload, without creating a second row (F-601 core contract)", async () => {
      const token = await login(requester);
      const idempotencyKey = "client-generated-key-1";

      const first = await createDraft(token, {}, idempotencyKey);
      expect(first.statusCode).toBe(201);
      const firstTaskId = first.json().taskId;

      // A genuine retry (network blip, double-click) resends the SAME
      // payload — this must hit the idempotent-replay path, not create a
      // second row.
      const second = await createDraft(token, {}, idempotencyKey);
      expect(second.statusCode).toBe(201);
      expect(second.json().taskId).toBe(firstTaskId);

      const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM tasks WHERE requester_address = $1 AND idempotency_key = $2`,
        [requester.address.toLowerCase(), idempotencyKey],
      );
      expect(rows[0].count).toBe(1);

      const { rows: taskRows } = await pool.query(`SELECT title FROM tasks WHERE id = $1`, [
        firstTaskId,
      ]);
      expect(taskRows[0].title).toBe(VALID_DRAFT_PAYLOAD.title);
    });

    // T-609 (Feature 14, F-1405): a same-key replay whose payload genuinely
    // differs from the original is a client bug — reusing an Idempotency-
    // Key for a materially different logical request — not a legitimate
    // retry. Previously this silently returned the ORIGINAL task as if the
    // new data had been accepted, discarding the caller's actual intent
    // without any signal that anything was wrong.
    it("rejects a repeated Idempotency-Key whose payload differs from the original, with 409 IDEMPOTENCY_KEY_CONFLICT (T-609)", async () => {
      const token = await login(requester);
      const idempotencyKey = "client-generated-key-conflict";

      const first = await createDraft(token, {}, idempotencyKey);
      expect(first.statusCode).toBe(201);
      const firstTaskId = first.json().taskId;

      const second = await createDraft(
        token,
        { title: "A genuinely different title" },
        idempotencyKey,
      );
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        error: { code: "IDEMPOTENCY_KEY_CONFLICT" },
      });

      // No second row, and the original is untouched.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM tasks WHERE requester_address = $1 AND idempotency_key = $2`,
        [requester.address.toLowerCase(), idempotencyKey],
      );
      expect(rows[0].count).toBe(1);
      const { rows: taskRows } = await pool.query(`SELECT title FROM tasks WHERE id = $1`, [
        firstTaskId,
      ]);
      expect(taskRows[0].title).toBe(VALID_DRAFT_PAYLOAD.title);
    });

    // T-609: every client-controlled field individually triggers the
    // conflict, not just `title` — proves the comparison isn't accidentally
    // narrowed to one field.
    it.each([
      ["category", { category: "translation" }],
      ["description", { description: "A different description entirely." }],
      ["budget", { budget: "1" }],
      ["deliveryDeadline", { deliveryDeadline: "2099-06-01T00:00:00.000Z" }],
      ["expertType", { expertType: "RESEARCH" }],
      ["skillTags", { skillTags: ["a-totally-different-tag"] }],
    ])(
      "rejects a repeated Idempotency-Key when only %s differs (T-609)",
      async (_label, overrides) => {
        const token = await login(requester);
        const idempotencyKey = `client-generated-key-${_label}`;

        const first = await createDraft(token, {}, idempotencyKey);
        expect(first.statusCode).toBe(201);

        const second = await createDraft(token, overrides, idempotencyKey);
        expect(second.statusCode).toBe(409);
        expect(second.json()).toMatchObject({
          error: { code: "IDEMPOTENCY_KEY_CONFLICT" },
        });
      },
    );

    // T-609: reordering (and duplicating) the same set of skill tags must
    // NOT be treated as a conflict — the comparison is a set, not an
    // ordered array, matching `createDraft`'s own de-duplication.
    it("does not treat a reordered/duplicated-but-equivalent skillTags array as a conflict (T-609)", async () => {
      const token = await login(requester);
      const idempotencyKey = "client-generated-key-skilltags-reorder";

      const first = await createDraft(token, { skillTags: ["copywriting", "seo"] }, idempotencyKey);
      expect(first.statusCode).toBe(201);
      const firstTaskId = first.json().taskId;

      const second = await createDraft(
        token,
        { skillTags: ["seo", "copywriting", "seo"] },
        idempotencyKey,
      );
      expect(second.statusCode).toBe(201);
      expect(second.json().taskId).toBe(firstTaskId);
    });

    // Codex review (T-609 P2): BUDGET_SCHEMA's pattern accepts leading
    // zeros, but PostgreSQL's NUMERIC column normalizes them away on
    // read-back — a raw string comparison would wrongly treat this
    // genuinely identical replay as a conflict.
    it("does not treat a leading-zero budget as different from its normalized stored value (T-609)", async () => {
      const token = await login(requester);
      const idempotencyKey = "client-generated-key-budget-leading-zero";

      const first = await createDraft(token, { budget: "007" }, idempotencyKey);
      expect(first.statusCode).toBe(201);
      const firstTaskId = first.json().taskId;

      const { rows } = await pool.query(`SELECT budget FROM tasks WHERE id = $1`, [firstTaskId]);
      expect(rows[0].budget).toBe("7");

      // The exact same literal request (still "007") replayed — must be
      // treated as identical, not a conflict.
      const second = await createDraft(token, { budget: "007" }, idempotencyKey);
      expect(second.statusCode).toBe(201);
      expect(second.json().taskId).toBe(firstTaskId);

      // A genuinely different numeric value must still be a real conflict.
      const third = await createDraft(token, { budget: "8" }, idempotencyKey);
      expect(third.statusCode).toBe(409);
    });

    it("honors an Idempotency-Key longer than 200 characters, not silently as if absent (Codex round 1 P2)", async () => {
      const token = await login(requester);
      const longKey = "k".repeat(500);

      const first = await createDraft(token, {}, longKey);
      expect(first.statusCode).toBe(201);
      const firstTaskId = first.json().taskId;

      // A genuine identical-payload retry — the long key's own truncation
      // question is orthogonal to T-609's payload-comparison change.
      const second = await createDraft(token, {}, longKey);
      expect(second.statusCode).toBe(201);
      // If the long key had been silently dropped (treated as absent), this
      // retry would have created a brand-new task instead of hitting the
      // idempotent-replay path.
      expect(second.json().taskId).toBe(firstTaskId);
    });

    it("distinguishes Idempotency-Key by requester — a different requester's identical key creates its own task", async () => {
      const requesterToken = await login(requester);
      const strangerToken = await login(stranger);
      const sharedKey = "shared-literal-key";

      const first = await createDraft(requesterToken, {}, sharedKey);
      const second = await createDraft(strangerToken, {}, sharedKey);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json().taskId).not.toBe(first.json().taskId);
    });

    it("rejects an unauthenticated draft creation with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        payload: VALID_DRAFT_PAYLOAD,
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a draft creation missing required fields with 400", async () => {
      const token = await login(requester);
      const response = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: token },
        payload: { category: "writing" },
      });
      expect(response.statusCode).toBe(400);
    });

    // Feature 12 (F-1205/AC-1205): expertType round-trips through create,
    // the create response body itself, and a subsequent GET detail — same
    // three-path proof agents/mutations.integration.test.ts uses for
    // protocolVersion/credentialRef.
    it("round-trips expertType through create, the create response, and GET detail (AC-1205)", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { expertType: "SOFTWARE_DEVELOPMENT" });
      expect(response.statusCode).toBe(201);
      expect(response.json().expertType).toBe("SOFTWARE_DEVELOPMENT");
      const taskId = response.json().taskId;

      const { rows } = await pool.query(`SELECT expert_type FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].expert_type).toBe("SOFTWARE_DEVELOPMENT");

      const detail = await app.inject({
        method: "GET",
        url: `/tasks/${taskId}`,
        cookies: { session_token: token },
      });
      expect(detail.json().expertType).toBe("SOFTWARE_DEVELOPMENT");
    });

    it("rejects a draft creation omitting expertType with 400 (F-1205: no default, must be explicit)", async () => {
      const token = await login(requester);
      const payloadWithoutExpertType: Record<string, unknown> = { ...VALID_DRAFT_PAYLOAD };
      delete payloadWithoutExpertType.expertType;
      const response = await app.inject({
        method: "POST",
        url: "/tasks/drafts",
        cookies: { session_token: token },
        payload: payloadWithoutExpertType,
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an unrecognized expertType, including a lowercase variant, with 400 (AC-1205)", async () => {
      const token = await login(requester);
      const lowercase = await createDraft(token, { expertType: "software_development" });
      expect(lowercase.statusCode).toBe(400);
      const unknown = await createDraft(token, { expertType: "PROJECT_MANAGEMENT" });
      expect(unknown.statusCode).toBe(400);
    });

    it("accepts each of the 5 legal expertType values (AC-1205)", async () => {
      const token = await login(requester);
      for (const expertType of [
        "DATA_ANALYSIS",
        "CONTENT_GENERATION",
        "SOFTWARE_DEVELOPMENT",
        "RESEARCH",
        "AUTOMATION",
      ]) {
        const response = await createDraft(token, { expertType });
        expect(response.statusCode).toBe(201);
        expect(response.json().expertType).toBe(expertType);
      }
    });

    it("rejects a draft creation with a malformed deliveryDeadline with 400", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { deliveryDeadline: "not-a-date" });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a draft creation with a deliveryDeadline in the past with 400", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { deliveryDeadline: "2020-01-01T00:00:00.000Z" });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a negative budget with 400", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { budget: "-5" });
      expect(response.statusCode).toBe(400);
    });

    // uint256's max value (2^256 - 1) — schema.ts's BUDGET_SCHEMA MAX_UINT256
    // boundary (Codex round 1 P2: a budget accepted here but unencodable as
    // a uint256 would leave a draft permanently unfundable).
    const MAX_UINT256 =
      "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    it("accepts a budget exactly at the uint256 maximum (2^256 - 1)", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { budget: MAX_UINT256 });
      expect(response.statusCode).toBe(201);
      const taskId = response.json().taskId;

      const { rows } = await pool.query(`SELECT budget FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].budget).toBe(MAX_UINT256);
    });

    it("rejects a budget one above the uint256 maximum (2^256) with 400", async () => {
      const token = await login(requester);
      const overMax =
        "115792089237316195423570985008687907853269984665640564039457584007913129639936";
      const response = await createDraft(token, { budget: overMax });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a zero budget with 400 (TaskEscrow.createTask reverts ZeroBudget, Codex round 2 P1)", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { budget: "0" });
      expect(response.statusCode).toBe(400);
    });

    it("accepts a budget of 1 (the smallest valid positive minimal-unit amount)", async () => {
      const token = await login(requester);
      const response = await createDraft(token, { budget: "1" });
      expect(response.statusCode).toBe(201);
    });

    it("applies a partial PATCH edit, leaving unspecified fields unchanged", async () => {
      const token = await login(requester);
      const created = await createDraft(token);
      const taskId = created.json().taskId;

      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { title: "Updated title" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe("Updated title");
      expect(body.description).toBe(VALID_DRAFT_PAYLOAD.description);
      expect(body.category).toBe(VALID_DRAFT_PAYLOAD.category);
      expect(body.skillTags.sort()).toEqual(["copywriting", "seo"]);
    });

    it("PATCH updates expertType when provided, and omitting it leaves the current value unchanged (F-1205: optional on update)", async () => {
      const token = await login(requester);
      const created = await createDraft(token, { expertType: "AUTOMATION" });
      const taskId = created.json().taskId;

      const changed = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { expertType: "RESEARCH" },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().expertType).toBe("RESEARCH");

      const unrelatedEdit = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { title: "Still Research" },
      });
      expect(unrelatedEdit.json().expertType).toBe("RESEARCH");
    });

    it("rejects a PATCH with an invalid expertType value with 400", async () => {
      const token = await login(requester);
      const created = await createDraft(token);
      const taskId = created.json().taskId;

      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { expertType: "not_a_real_type" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("replaces the full skillTags set when provided in a PATCH", async () => {
      const token = await login(requester);
      const created = await createDraft(token);
      const taskId = created.json().taskId;

      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { skillTags: ["design"] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().skillTags).toEqual(["design"]);
    });

    it("rejects a PATCH from a non-owner session with 403, leaving the draft unchanged", async () => {
      const ownerToken = await login(requester);
      const created = await createDraft(ownerToken);
      const taskId = created.json().taskId;
      const strangerToken = await login(stranger);

      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: strangerToken },
        payload: { title: "Hijacked" },
      });
      expect(response.statusCode).toBe(403);

      const { rows } = await pool.query(`SELECT title FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].title).toBe(VALID_DRAFT_PAYLOAD.title);
    });

    it("returns 404 editing a nonexistent task", async () => {
      const token = await login(requester);
      const response = await app.inject({
        method: "PATCH",
        url: "/tasks/00000000-0000-0000-0000-000000000000/draft",
        cookies: { session_token: token },
        payload: { title: "Ghost" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects a PATCH with no session cookie", async () => {
      const created = await createDraft(await login(requester));
      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${created.json().taskId}/draft`,
        payload: { title: "No Auth" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a PATCH once the task is no longer DRAFT, with the TASK_STATE_CONFLICT error code, data unchanged", async () => {
      const token = await login(requester);
      const created = await createDraft(token);
      const taskId = created.json().taskId;

      // No state-transition endpoint exists yet (that's later Features'
      // scope) — manually flip status to construct this scenario, per this
      // Task's own instructions.
      await pool.query(`UPDATE tasks SET status = 'OPEN' WHERE id = $1`, [taskId]);

      const response = await app.inject({
        method: "PATCH",
        url: `/tasks/${taskId}/draft`,
        cookies: { session_token: token },
        payload: { title: "Too Late" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("TASK_STATE_CONFLICT");

      const { rows } = await pool.query(`SELECT title FROM tasks WHERE id = $1`, [taskId]);
      expect(rows[0].title).toBe(VALID_DRAFT_PAYLOAD.title);
    });
  },
);

/**
 * Real-HTTP concurrency proof for F-601's idempotency contract
 * (0005_create_tasks.sql's comment: "a concurrent retry of POST
 * /tasks/drafts with the same Idempotency-Key header ... instead of racing
 * to create two tasks"). `app.inject()` runs requests through Fastify
 * in-process, sequentially with respect to each other's async work in a way
 * that doesn't reliably exercise the actual race — two genuinely concurrent
 * TCP requests are needed to prove both requests can reach service.ts's
 * pre-insert check before either has committed, so the DB-level UNIQUE
 * constraint (not application-level luck) is what resolves the race,
 * mirroring agents/mutations.integration.test.ts's real-HTTP pattern for
 * T-505's Content-Type regression.
 */
runIfOptedIn("POST /tasks/drafts concurrent Idempotency-Key retry (integration, F-601)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  let baseUrl: string;
  const requester = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
    await pool.query(DROP_ALL_TABLES_SQL);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM task_skills");
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  async function loginOverHttp(): Promise<string> {
    const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: requester.address }),
    });
    const { nonce, issuedAt, expiresAt } = await nonceResponse.json();
    const message = buildSignInMessage({
      domain: "localhost",
      address: requester.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await requester.signMessage({ message });
    const verifyResponse = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: requester.address, signature, nonce }),
    });
    const setCookie = verifyResponse.headers.get("set-cookie");
    const match = /session_token=([^;]+)/.exec(String(setCookie));
    if (!match?.[1]) throw new Error("no session_token cookie in verify response");
    return match[1];
  }

  it("produces exactly one task row when two requests with the same Idempotency-Key race", async () => {
    const cookie = await loginOverHttp();
    const idempotencyKey = "concurrent-key-1";

    const fire = () =>
      fetch(`${baseUrl}/tasks/drafts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": idempotencyKey,
          cookie: `session_token=${cookie}`,
        },
        body: JSON.stringify(VALID_DRAFT_PAYLOAD),
      });

    const [firstResponse, secondResponse] = await Promise.all([fire(), fire()]);
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const [firstBody, secondBody] = await Promise.all([
      firstResponse.json(),
      secondResponse.json(),
    ]);
    expect(firstBody.taskId).toBe(secondBody.taskId);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM tasks WHERE requester_address = $1 AND idempotency_key = $2`,
      [requester.address.toLowerCase(), idempotencyKey],
    );
    expect(rows[0].count).toBe(1);
  });
});
