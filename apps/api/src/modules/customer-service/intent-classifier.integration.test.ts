import { afterEach, describe, expect, it } from "vitest";
import { classifyIntent } from "./intent-classifier.js";
import { INTENT_CLASSIFICATION_EXAMPLES } from "./intent-classification-examples.js";

/**
 * F-2201/T-2201: the genuinely-real local Ollama chain (actual `qwen3:8b`
 * inference, no fake server) — same convention as
 * `ollama-provider.integration.test.ts`'s own `RUN_OLLAMA_INTEGRATION_TESTS`
 * gate. No database is involved (classification is pure computation, per
 * design.md's "分类逻辑不依赖知识库内容本身"), so this suite does NOT also
 * require `RUN_DB_INTEGRATION_TESTS=1` the way that embedding suite does —
 * it needs only a real local Ollama daemon.
 *
 * This is the beginning of what T-2207 will formalize into the full
 * accuracy-measurement evaluation infra (F-2209) — here we only assert each
 * hand-written example from `intent-classification-examples.ts` actually
 * gets classified, and print the real per-example result so a human can
 * inspect real model behavior, not a synthetic pass/fail count.
 */
const runIfRealOllama = process.env.RUN_OLLAMA_INTEGRATION_TESTS === "1" ? describe : describe.skip;

runIfRealOllama("classifyIntent (real local Ollama, T-2201)", () => {
  afterEach(() => {
    delete process.env.OLLAMA_INTENT_MODEL;
  });

  it("classifies every hand-written evaluation example against the real local qwen3:8b model", async () => {
    const results: { question: string; expected: string; actual: string }[] = [];

    for (const example of INTENT_CLASSIFICATION_EXAMPLES) {
      const result = await classifyIntent(example.question);
      results.push({
        question: example.question,
        expected: example.expectedIntent,
        actual: result.intent,
      });
    }

    console.log(
      "T-2201 real qwen3:8b intent classification results:\n" +
        results
          .map(
            (r) =>
              `  [${r.actual === r.expected ? "MATCH" : "MISMATCH"}] "${r.question}" → expected=${r.expected} actual=${r.actual}`,
          )
          .join("\n"),
    );

    // N4 real finding (round 2, T-2202): this assertion previously only
    // checked category-SET membership, not correctness against
    // `expected` — that let a real, demonstrated misclassification
    // (see intent-classification-examples.ts's own "验收窗口一般是多久"
    // comment) pass silently. Every real example must now classify
    // exactly as expected; a regression here is a real product bug, not
    // an acceptable model quirk this test should tolerate.
    for (const result of results) {
      expect(result.actual).toBe(result.expected);
    }
  }, 120_000);
});
