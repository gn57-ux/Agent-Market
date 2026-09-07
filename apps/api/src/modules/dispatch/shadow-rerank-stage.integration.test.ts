import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "@agent-market/domain";
import type { RerankRequestBody } from "./rerank-client.js";
import { insertCtrModel, setActiveModel } from "../ctr-training/ctr-model-repository.js";
import { DEFAULT_FUSION_WEIGHTS } from "../ctr-training/fusion-weights.js";

/**
 * T-1907, N4 P1 fix: proves `runShadowRerank` reads the REAL, current
 * `release_stage_state` on every call — not a hardcoded `"SHADOW"` literal
 * — and forwards it both to Python's request body and to the persisted
 * `dispatch_rerank_runs.stage` column. Mocks `callRerankService` (unlike
 * `shadow-rerank.integration.test.ts`'s genuinely real Python+Ollama
 * end-to-end test) so this narrow wiring question can be verified fast and
 * without any real external service — the real Python call path itself is
 * already covered elsewhere.
 *
 * Explicitly does NOT claim more than this: advancing past SHADOW here
 * changes what Python is TOLD and what gets RECORDED — it does not (and,
 * per `runShadowRerank`'s own doc comment, structurally cannot yet) change
 * what a real user is actually shown. That remains unimplemented, on
 * purpose, pending a separate future decision.
 */
const callRerankServiceMock = vi.fn();
vi.mock("./rerank-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rerank-client.js")>();
  return {
    ...actual,
    callRerankService: (...args: Parameters<typeof actual.callRerankService>) =>
      callRerankServiceMock(...args),
  };
});

const { runShadowRerank } = await import("./shadow-rerank.js");

const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const DROP_ALL_TABLES_SQL =
  "DROP TABLE IF EXISTS ratings, audit_logs, disputes, pending_result_submissions, recommendation_candidates, recommendation_runs, acceptance_permits, deliverables, task_state_history, chain_events, chain_transactions, task_skills, tasks, agent_embeddings, task_embeddings, embedding_budget_usage, blocked_wallets, agent_skills, agents, sessions, auth_nonces, users, consumed_privy_tokens, agent_review_audit_logs, admin_role_audit_logs, admin_roles, task_dag_node_skills, task_dag_edges, task_dag_nodes, task_dags, outbox_events, chain_indexed_events, processed_events, indexer_scan_checkpoints, interaction_events, ctr_training_datasets, ctr_models, dispatch_rerank_runs, shadow_ranking_results, evaluation_appeals, evaluation_results, evaluation_submissions, evaluation_tasks, evaluation_rubrics, risk_signals, risk_hold_audit_logs, release_stage_state, release_stage_audit_logs, arbitration_committee_members, arbitration_upgrade_log, arbitration_decisions, arbitration_recusals, dispute_evidence_submissions, schema_migrations CASCADE";

const REQUESTER_ADDRESS = "0xa283fefc63f0cd0e873a0000c6d07ef7b77e91da";
const TOKEN_ADDRESS = "0x8883fefc63f0cd0e873a0000c6d07ef7b77e90d7";

runIfOptedIn(
  "runShadowRerank reads the real release stage/ranking policy (integration, T-1907)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        REQUESTER_ADDRESS,
      ]);
    });

    afterAll(async () => {
      await pool.query(DROP_ALL_TABLES_SQL);
      await pool.end();
    });

    afterEach(async () => {
      callRerankServiceMock.mockReset();
      await pool.query("DELETE FROM shadow_ranking_results");
      await pool.query("DELETE FROM dispatch_rerank_runs");
      await pool.query("DELETE FROM recommendation_runs");
      await pool.query("DELETE FROM tasks");
      await pool.query("DELETE FROM ctr_models");
      await pool.query(`UPDATE release_stage_state SET stage = 'SHADOW' WHERE id = true`);
    });

    async function seedRun(): Promise<string> {
      const {
        rows: [task],
      } = await pool.query<{ id: string }>(
        `INSERT INTO tasks (requester_address, category, title, description, budget, token, delivery_deadline, status, expert_type)
       VALUES ($1, 'writing', 'Task', 'desc', 100, $2, now() + interval '7 days', 'OPEN', 'AUTOMATION')
       RETURNING id`,
        [REQUESTER_ADDRESS, TOKEN_ADDRESS],
      );
      const taskId = task?.id ?? "";
      const {
        rows: [run],
      } = await pool.query<{ id: string }>(
        `INSERT INTO recommendation_runs (task_id, algorithm_version, candidate_count, input_digest)
       VALUES ($1, 'v0.2', 1, 'digest') RETURNING id`,
        [taskId],
      );
      return run?.id ?? "";
    }

    it("defaults to SHADOW when no advancement has ever happened", async () => {
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: null,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-1",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-1",
      });

      expect(callRerankServiceMock).toHaveBeenCalledTimes(1);
      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.stage).toBe("SHADOW");

      const { rows } = await pool.query<{ stage: string }>(
        `SELECT stage FROM dispatch_rerank_runs WHERE run_id = $1`,
        [runId],
      );
      expect(rows[0]?.stage).toBe("SHADOW");
    });

    it("reflects a real advanced release stage in both the Python request and the persisted audit row", async () => {
      await pool.query(`UPDATE release_stage_state SET stage = 'GRADUAL' WHERE id = true`);
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: null,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-2",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-2",
      });

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.stage).toBe("GRADUAL");

      const { rows } = await pool.query<{ stage: string; adopted: boolean }>(
        `SELECT stage, adopted FROM dispatch_rerank_runs WHERE run_id = $1`,
        [runId],
      );
      expect(rows[0]?.stage).toBe("GRADUAL");
      // The explicit, documented limitation: even in GRADUAL, nothing is
      // actually adopted into a real response yet — this function's own
      // return value stays void regardless of stage.
      expect(rows[0]?.adopted).toBe(false);
    });

    // N4 P1 fix (round 2): a real failure reading `release_stage_state`
    // (here: the table renamed out from under the query, producing a real
    // Postgres error, not a simulated one) must NEVER propagate out of
    // `runShadowRerank` — this function's own "never throws" contract
    // (routes.ts calls it unguarded) must hold even for this new read, not
    // just for the Python call.
    it("never throws when reading the real release stage fails — falls back to SHADOW", async () => {
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: null,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-3",
      });
      const runId = await seedRun();

      await pool.query(
        `ALTER TABLE release_stage_state RENAME TO release_stage_state_temp_renamed`,
      );
      try {
        await expect(
          runShadowRerank(pool, {
            runId,
            taskDescription: "test",
            recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
            reputationSignalsDigestByAgentId: new Map(),
            semanticSimilarityByAgentId: new Map(),
            traceId: "trace-3",
          }),
        ).resolves.toBeUndefined();
      } finally {
        await pool.query(
          `ALTER TABLE release_stage_state_temp_renamed RENAME TO release_stage_state`,
        );
      }

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.stage).toBe("SHADOW");
      const { rows } = await pool.query<{ stage: string }>(
        `SELECT stage FROM dispatch_rerank_runs WHERE run_id = $1`,
        [runId],
      );
      expect(rows[0]?.stage).toBe("SHADOW");
    });

    // --- T-1907 round 3 (用户 2026-09-06 决策): real ranking_policy_version
    // propagation. Every persisted row below comes from a REAL call to
    // `runShadowRerank` (this codebase's own real write path) — never a
    // hand-written INSERT — only the outermost Python HTTP boundary is
    // stubbed, matching the stage tests above and this file's own module
    // doc comment. ---

    it("sends the real active ctr_models row's own id and weights as rankingPolicy", async () => {
      const modelId = await insertCtrModel(pool, {
        modelVersion: `test-model-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      await setActiveModel(pool, modelId);
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: modelId,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-4",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-4",
      });

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.rankingPolicy).toEqual({
        version: modelId,
        weights: DEFAULT_FUSION_WEIGHTS,
      });
    });

    it("omits rankingPolicy entirely when no ctr_models row is active", async () => {
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: null,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-5",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-5",
      });

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.rankingPolicy ?? null).toBeNull();
    });

    it("persists exactly what the response says was used, into BOTH dispatch_rerank_runs and shadow_ranking_results", async () => {
      const modelId = await insertCtrModel(pool, {
        modelVersion: `test-model-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      await setActiveModel(pool, modelId);
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: modelId,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-6",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-6",
      });

      const { rows: rerankRows } = await pool.query<{ ranking_policy_version: string }>(
        `SELECT ranking_policy_version FROM dispatch_rerank_runs WHERE run_id = $1`,
        [runId],
      );
      expect(rerankRows[0]?.ranking_policy_version).toBe(modelId);
      const { rows: shadowRows } = await pool.query<{ ctr_model_id: string }>(
        `SELECT ctr_model_id FROM shadow_ranking_results WHERE run_id = $1`,
        [runId],
      );
      expect(shadowRows[0]?.ctr_model_id).toBe(modelId);
    });

    // N4-lesson: Node must NEVER just trust what it originally SENT — a
    // real, well-behaved Python service only echoes back a version it
    // genuinely used, and a mismatch/omission in the RESPONSE (simulated
    // here) must win over what Node requested. This is the literal
    // "确保版本来自实际执行的模型策略而非客户端输入或常量猜测" requirement:
    // Node is the client from Python's perspective, and its own request
    // must not be self-certifying.
    it("persists NULL when the response says no real policy was used, even though a real active model existed and was requested", async () => {
      const modelId = await insertCtrModel(pool, {
        modelVersion: `test-model-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      await setActiveModel(pool, modelId);
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          // Simulates a well-behaved real Python service that, for
          // whatever real reason, could not use the requested policy.
          rankingPolicyVersion: null,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-7",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-7",
      });

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.rankingPolicy).toEqual({
        version: modelId,
        weights: DEFAULT_FUSION_WEIGHTS,
      });
      const { rows } = await pool.query<{ ranking_policy_version: string | null }>(
        `SELECT ranking_policy_version FROM dispatch_rerank_runs WHERE run_id = $1`,
        [runId],
      );
      expect(rows[0]?.ranking_policy_version).toBeNull();
    });

    // N4 P1 fix (round 2): a real active model existed and was requested,
    // but the (simulated) Python response names a DIFFERENT real,
    // existing `ctr_models` id — a version-drifted or buggy Python
    // process, not a mismatch this codebase invented. Must fail closed
    // (persist NULL) rather than trust an unconfirmed attribution, even
    // though the named id would pass the `ctr_model_id` foreign key just
    // as validly as the correct one.
    it("persists NULL (fail-closed) when the response names a DIFFERENT real model than the one actually requested", async () => {
      const requestedModelId = await insertCtrModel(pool, {
        modelVersion: `test-model-requested-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      await setActiveModel(pool, requestedModelId);
      const otherRealModelId = await insertCtrModel(pool, {
        modelVersion: `test-model-other-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          // A real, existing model id — just not the one this call
          // actually requested.
          rankingPolicyVersion: otherRealModelId,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-mismatch",
      });
      const runId = await seedRun();

      await runShadowRerank(pool, {
        runId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-mismatch",
      });

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.rankingPolicy).toEqual({
        version: requestedModelId,
        weights: DEFAULT_FUSION_WEIGHTS,
      });
      const { rows } = await pool.query<{ ranking_policy_version: string | null }>(
        `SELECT ranking_policy_version FROM dispatch_rerank_runs WHERE run_id = $1`,
        [runId],
      );
      expect(rows[0]?.ranking_policy_version).toBeNull();

      const shadowRows = await pool.query<{ ctr_model_id: string | null }>(
        `SELECT ctr_model_id FROM shadow_ranking_results WHERE run_id = $1`,
        [runId],
      );
      expect(shadowRows.rows[0]?.ctr_model_id).toBeNull();
    });

    // N4-lesson: mixed-version data must stay correctly attributed — a
    // second, different real active model's real call must never be
    // conflated with the first's.
    it("keeps two different real active-model eras correctly attributed to their own real calls", async () => {
      const firstModelId = await insertCtrModel(pool, {
        modelVersion: `test-model-a-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      await setActiveModel(pool, firstModelId);
      callRerankServiceMock.mockResolvedValueOnce({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: firstModelId,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-8a",
      });
      const firstRunId = await seedRun();
      await runShadowRerank(pool, {
        runId: firstRunId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-8a",
      });

      const secondModelId = await insertCtrModel(pool, {
        modelVersion: `test-model-b-${Math.random()}`,
        dataSnapshotVersion: "snap-test",
        featureVersion: "v1",
        offlineMetrics: {},
        fusionWeights: DEFAULT_FUSION_WEIGHTS,
      });
      await setActiveModel(pool, secondModelId);
      callRerankServiceMock.mockResolvedValueOnce({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-2"],
          rationales: [{ agentId: "agent-2", reason: "y" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: secondModelId,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-8b",
      });
      const secondRunId = await seedRun();
      await runShadowRerank(pool, {
        runId: secondRunId,
        taskDescription: "test",
        recommendations: [{ agentId: "agent-2", rank: 1, score: 0.9 }],
        reputationSignalsDigestByAgentId: new Map(),
        semanticSimilarityByAgentId: new Map(),
        traceId: "trace-8b",
      });

      const { rows } = await pool.query<{ run_id: string; ranking_policy_version: string }>(
        `SELECT run_id, ranking_policy_version FROM dispatch_rerank_runs WHERE run_id = ANY($1)`,
        [[firstRunId, secondRunId]],
      );
      const byRun = new Map(rows.map((r) => [r.run_id, r.ranking_policy_version]));
      expect(byRun.get(firstRunId)).toBe(firstModelId);
      expect(byRun.get(secondRunId)).toBe(secondModelId);
    });

    // N4 P1 fix (round 2)'s own convention, applied to the new read: a real
    // failure looking up the active model must never propagate either.
    it("never throws when reading the active ranking_policy_version fails — omits rankingPolicy", async () => {
      callRerankServiceMock.mockResolvedValue({
        outcome: "SUCCESS",
        response: {
          rankedAgentIds: ["agent-1"],
          rationales: [{ agentId: "agent-1", reason: "x" }],
          rerankServiceVersion: "test",
          rankingPolicyVersion: null,
          llmAdopted: true,
        },
        latencyMs: 10,
        traceId: "trace-9",
      });
      const runId = await seedRun();

      await pool.query(`ALTER TABLE ctr_models RENAME TO ctr_models_temp_renamed`);
      try {
        await expect(
          runShadowRerank(pool, {
            runId,
            taskDescription: "test",
            recommendations: [{ agentId: "agent-1", rank: 1, score: 0.9 }],
            reputationSignalsDigestByAgentId: new Map(),
            semanticSimilarityByAgentId: new Map(),
            traceId: "trace-9",
          }),
        ).resolves.toBeUndefined();
      } finally {
        await pool.query(`ALTER TABLE ctr_models_temp_renamed RENAME TO ctr_models`);
      }

      const [sentRequest] = callRerankServiceMock.mock.calls[0] as [RerankRequestBody];
      expect(sentRequest.rankingPolicy ?? null).toBeNull();
    });
  },
);
