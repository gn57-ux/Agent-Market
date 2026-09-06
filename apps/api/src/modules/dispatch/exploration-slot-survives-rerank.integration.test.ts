import { describe, expect, it } from "vitest";
import { callRerankService, type RerankRequestBody } from "./rerank-client.js";

/**
 * AC-1907/F-1911 (T-1908): "CTR 排序不能吞掉现有 v0.1/v0.2 的新人探索位
 * 设计" — a real, end-to-end proof that a brand-new agent (zero reputation
 * signals — exactly what Go's exploration slot mechanism sends: an agent
 * with no settled-task history yet, `assembleReputationSignals`'s own
 * nil→neutral-prior handling means such a candidate has `signals: null` on
 * the wire, same shape `shadow-rerank.ts` sends for a candidate with no
 * persisted reputation digest) is NOT silently dropped by a REAL Python
 * `/rerank` call sitting next to an established, high-signal candidate.
 *
 * This is not re-testing `pipeline.py`'s own `validate_full_permutation`
 * unit coverage (T-1911's own test suite already does that) — it's proving
 * the real wire-level behavior from Node's actual candidate shape, against
 * the real running service, the same "opt-in real external service"
 * convention as `rerank-client.integration.test.ts`.
 */
const runIfOptedIn =
  process.env.RUN_DISPATCH_RERANK_INTEGRATION_TESTS === "1" ? describe : describe.skip;

runIfOptedIn("exploration slot survives a real /rerank call (integration, T-1908, AC-1907)", () => {
  it(
    "keeps a brand-new agent (null signals) in the real response alongside an established agent",
    async () => {
      const request: RerankRequestBody = {
        candidates: [
          // The established candidate — real, high five-signal digest.
          {
            agentId: "established-agent",
            v0Score: 0.85,
            signals: {
              completionRate: 0.95,
              qualityFeedback: 0.9,
              communication: 0.88,
              disputeSignal: 0.0,
              historicalScale: 0.7,
            },
            semanticSimilarity: 0.6,
          },
          // The new agent — Go's exploration slot: no settled-task
          // history yet, so `signals` is `null` on the wire (same shape
          // `shadow-rerank.ts` sends for a candidate with no persisted
          // reputation digest) and `v0Score` reflects the nil→neutral
          // prior Feature 7/13 already establish for a brand-new agent.
          {
            agentId: "new-agent-exploration-slot",
            v0Score: 0.5,
            signals: null,
            semanticSimilarity: null,
          },
        ],
        taskDescription: "write a landing page",
        stage: "SHADOW",
      };

      const result = await callRerankService(request, { timeoutMs: 90_000 });

      expect(result.outcome).toBe("SUCCESS");
      expect(result.response).not.toBeNull();
      // AC-1907's own literal requirement: the new agent still has a
      // real chance to be shown — proven here as "still present in the
      // real ranking," not "never demoted" (demotion vs a stronger
      // established candidate is expected and fine; disappearing
      // entirely would defeat the whole point of the exploration slot).
      expect(result.response?.rankedAgentIds).toContain("new-agent-exploration-slot");
      expect(result.response?.rankedAgentIds).toContain("established-agent");
      expect(result.response?.rankedAgentIds).toHaveLength(2);
      // A real rationale exists for the new agent too — not silently
      // omitted just because it has no history to reason about.
      const newAgentRationale = result.response?.rationales.find(
        (r) => r.agentId === "new-agent-exploration-slot",
      );
      expect(newAgentRationale?.reason).toBeTruthy();
    },
    { timeout: 95_000 },
  );
});
