import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import { buildSignInMessage } from "../auth/signInMessage.js";

/**
 * F-1604/F-1607 (Feature 16, T-1604, design.md 决策 5) — real end-to-end
 * coverage for AC-1604 ("免费 Agent 创建后立即在 GET /agents 可见，付费 Agent
 * 创建后不可见，直到审核通过") and the explicit-confirmation pricing-type
 * change route. Real HTTP (`app.inject`), real Postgres, real SIWE
 * signatures throughout — no mocking of any part of this module's own
 * logic.
 */
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("Agent pricing-type review routing (integration, T-1604, AC-1604)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, kb_articles, customer_service_messages, customer_service_conversations, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_review_audit_logs");
    await pool.query("DELETE FROM agent_skills");
    await pool.query("DELETE FROM agents");
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

  async function createAgent(
    token: string,
    pricingType: "FREE" | "PER_TASK" | "SUBSCRIPTION" | "HOURLY",
  ): Promise<{ agentId: string; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: {
        name: `Agent ${pricingType}`,
        description: "desc",
        category: "writing",
        skillTags: ["copywriting"],
        payoutAddress: owner.address,
        pricingType,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { agentId: body.agentId, body };
  }

  it("POST /agents rejects a request with no pricingType (now required, F-1604)", async () => {
    const token = await login(owner);
    const response = await app.inject({
      method: "POST",
      url: "/agents",
      cookies: { session_token: token },
      payload: {
        name: "No Pricing Type",
        description: "desc",
        category: "writing",
        skillTags: [],
        payoutAddress: owner.address,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("a FREE Agent is created with reviewStatus=ACTIVE and is immediately visible in GET /agents (AC-1604)", async () => {
    const token = await login(owner);
    const { agentId, body } = await createAgent(token, "FREE");
    expect(body.reviewStatus).toBe("ACTIVE");
    expect(body.pricingType).toBe("FREE");

    const listResponse = await app.inject({ method: "GET", url: "/agents" });
    const items = listResponse.json().items as Array<{ agentId: string }>;
    expect(items.map((item) => item.agentId)).toContain(agentId);
  });

  it.each(["PER_TASK", "SUBSCRIPTION", "HOURLY"] as const)(
    "a %s Agent is created with reviewStatus=PENDING_REVIEW and is NOT visible in GET /agents until approved (AC-1604)",
    async (pricingType) => {
      const token = await login(owner);
      const { agentId, body } = await createAgent(token, pricingType);
      expect(body.reviewStatus).toBe("PENDING_REVIEW");

      const listResponse = await app.inject({ method: "GET", url: "/agents" });
      const items = listResponse.json().items as Array<{ agentId: string }>;
      expect(items.map((item) => item.agentId)).not.toContain(agentId);

      // The owner (or anyone with the direct link) can still see it via
      // the detail endpoint — AC-1604 is about the MARKET LISTING, not
      // "invisible entirely."
      const detailResponse = await app.inject({
        method: "GET",
        url: `/agents/${agentId}`,
        cookies: { session_token: token },
      });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json().reviewStatus).toBe("PENDING_REVIEW");
    },
  );

  it("POST /agents/:agentId/pricing-type: FREE -> PER_TASK re-enters review (PENDING_REVIEW) and writes an audit row (design.md 决策 5's actual bypass concern)", async () => {
    const token = await login(owner);
    const { agentId } = await createAgent(token, "FREE");

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/pricing-type`,
      cookies: { session_token: token },
      payload: { pricingType: "PER_TASK" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pricingType).toBe("PER_TASK");
    expect(body.reviewStatus).toBe("PENDING_REVIEW");

    const listResponse = await app.inject({ method: "GET", url: "/agents" });
    expect(
      (listResponse.json().items as Array<{ agentId: string }>).map((item) => item.agentId),
    ).not.toContain(agentId);

    const { rows } = await pool.query<{
      from_status: string;
      to_status: string;
      actor_address: string;
    }>(
      `SELECT from_status, to_status, actor_address FROM agent_review_audit_logs WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from_status).toBe("ACTIVE");
    expect(rows[0]?.to_status).toBe("PENDING_REVIEW");
    expect(rows[0]?.actor_address).toBe(owner.address.toLowerCase());
  });

  it("POST /agents/:agentId/pricing-type: PER_TASK -> FREE goes straight to ACTIVE (FREE never needs review) and writes an audit row", async () => {
    const token = await login(owner);
    const { agentId } = await createAgent(token, "PER_TASK");

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/pricing-type`,
      cookies: { session_token: token },
      payload: { pricingType: "FREE" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pricingType).toBe("FREE");
    expect(body.reviewStatus).toBe("ACTIVE");

    const listResponse = await app.inject({ method: "GET", url: "/agents" });
    expect(
      (listResponse.json().items as Array<{ agentId: string }>).map((item) => item.agentId),
    ).toContain(agentId);

    const { rows } = await pool.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM agent_review_audit_logs WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from_status).toBe("PENDING_REVIEW");
    expect(rows[0]?.to_status).toBe("ACTIVE");
  });

  it("POST /agents/:agentId/pricing-type: PER_TASK -> SUBSCRIPTION (neither side is FREE) does NOT change reviewStatus and writes NO audit row", async () => {
    const token = await login(owner);
    const { agentId } = await createAgent(token, "PER_TASK");

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/pricing-type`,
      cookies: { session_token: token },
      payload: { pricingType: "SUBSCRIPTION" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pricingType).toBe("SUBSCRIPTION");
    expect(body.reviewStatus).toBe("PENDING_REVIEW");

    const { rows } = await pool.query(
      `SELECT id FROM agent_review_audit_logs WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(0);
  });

  it("POST /agents/:agentId/pricing-type rejects a non-owner with 403 and does not change pricingType", async () => {
    const ownerToken = await login(owner);
    const { agentId } = await createAgent(ownerToken, "PER_TASK");
    const strangerToken = await login(stranger);

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/pricing-type`,
      cookies: { session_token: strangerToken },
      payload: { pricingType: "FREE" },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await pool.query<{ pricing_type: string }>(
      `SELECT pricing_type FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.pricing_type).toBe("PER_TASK");
  });

  it("the general PATCH /agents/:agentId silently ignores a pricingType key in the body — it is NOT a valid field on that schema, so it must never change pricing_type as a side effect (design.md 决策 5's core requirement)", async () => {
    const token = await login(owner);
    const { agentId } = await createAgent(token, "PER_TASK");

    const response = await app.inject({
      method: "PATCH",
      url: `/agents/${agentId}`,
      cookies: { session_token: token },
      payload: { description: "an unrelated edit", pricingType: "FREE" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().description).toBe("an unrelated edit");

    const { rows } = await pool.query<{ pricing_type: string; review_status: string }>(
      `SELECT pricing_type, review_status FROM agents WHERE id = $1`,
      [agentId],
    );
    expect(rows[0]?.pricing_type).toBe("PER_TASK");
    expect(rows[0]?.review_status).toBe("PENDING_REVIEW");
  });

  it("N4 round-1 P1 fix — switching to FREE while REJECTED does NOT auto-reinstate ACTIVE (only admin approve/appeal may exit REJECTED)", async () => {
    const token = await login(owner);
    const { agentId } = await createAgent(token, "PER_TASK");
    // Simulates the platform having rejected this Agent (T-1605's real
    // approve/reject endpoints don't exist yet at this point in Feature
    // 16's build order) — a direct, real DB state, not a mock.
    await pool.query(`UPDATE agents SET review_status = 'REJECTED' WHERE id = $1`, [agentId]);

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/pricing-type`,
      cookies: { session_token: token },
      payload: { pricingType: "FREE" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pricingType).toBe("FREE");
    // The real assertion: still REJECTED, NOT silently bounced to ACTIVE.
    expect(body.reviewStatus).toBe("REJECTED");

    const { rows } = await pool.query(
      `SELECT id FROM agent_review_audit_logs WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(0);
  });

  it("N4 round-1 P1 fix — changing pricingType while SUSPENDED does NOT auto-move to PENDING_REVIEW (only admin/appeal may exit SUSPENDED)", async () => {
    const token = await login(owner);
    const { agentId } = await createAgent(token, "FREE");
    await pool.query(`UPDATE agents SET review_status = 'SUSPENDED' WHERE id = $1`, [agentId]);

    const response = await app.inject({
      method: "POST",
      url: `/agents/${agentId}/pricing-type`,
      cookies: { session_token: token },
      payload: { pricingType: "PER_TASK" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pricingType).toBe("PER_TASK");
    expect(body.reviewStatus).toBe("SUSPENDED");

    const { rows } = await pool.query(
      `SELECT id FROM agent_review_audit_logs WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(0);
  });

  it(
    "N4 round-1 P1 fix — two concurrent pricing-type changes on the same Agent never produce a " +
      "paid+unreviewed final state (the decision is made from data read under the SAME row " +
      "lock as the write, not a pre-transaction snapshot)",
    async () => {
      const token = await login(owner);
      const { agentId } = await createAgent(token, "PER_TASK");
      // Starts ACTIVE (a real T-1605 admin approval isn't built yet at
      // this point — directly simulating "already reviewed and approved"
      // real DB state, matching the exact scenario Codex's finding
      // described: an already-approved paid Agent).
      await pool.query(`UPDATE agents SET review_status = 'ACTIVE' WHERE id = $1`, [agentId]);

      const [responseA, responseB] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/agents/${agentId}/pricing-type`,
          cookies: { session_token: token },
          payload: { pricingType: "FREE" },
        }),
        app.inject({
          method: "POST",
          url: `/agents/${agentId}/pricing-type`,
          cookies: { session_token: token },
          payload: { pricingType: "SUBSCRIPTION" },
        }),
      ]);
      expect(responseA.statusCode).toBe(200);
      expect(responseB.statusCode).toBe(200);

      const { rows } = await pool.query<{ pricing_type: string; review_status: string }>(
        `SELECT pricing_type, review_status FROM agents WHERE id = $1`,
        [agentId],
      );
      const final = rows[0];
      // Whichever request's write actually landed last determines the
      // final pricing_type — but real-lock serialization guarantees the
      // SECOND writer always decided from the FIRST writer's already-
      // committed state (see setAgentPricingType's doc comment for the
      // full derivation of these as the only two internally-consistent
      // outcomes). The property this test actually exists to prove: it
      // is NEVER paid (non-FREE) with review_status still ACTIVE from a
      // stale decision that skipped re-review.
      const isPaidButNeverReviewed =
        final?.pricing_type !== "FREE" && final?.review_status === "ACTIVE";
      expect(isPaidButNeverReviewed).toBe(false);
      expect(["FREE", "SUBSCRIPTION"]).toContain(final?.pricing_type);
      if (final?.pricing_type === "SUBSCRIPTION") {
        expect(final.review_status).toBe("PENDING_REVIEW");
      } else {
        expect(final?.review_status).toBe("ACTIVE");
      }
    },
  );
});
