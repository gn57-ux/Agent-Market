// Feature 13 (vector-recall-scoring), T-1301. Ollama-localized in T-1308
// (see specs/13-vector-recall-scoring/design.md v1.2's Provider comparison
// table) — `openai-provider.ts` is gone; `ollama-provider.ts` is the one
// module allowed to know what Ollama's API actually looks like.
//
// F-1302: a narrow interface — `embed(text)` is the entire contract. No
// vendor-specific type (a raw API response shape, an SDK client type, an
// error class) is exposed here. A future alternative Provider only ever
// needs to implement this one interface — every caller (embed-on-save.ts,
// T-1302) depends on this file, never on a concrete Provider module
// directly.

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimension: number;
  /** Provider identifier (e.g. `"ollama"`) — F-1315 needs this to compose
   * `embedding_version` generically, without embed-on-save.ts (the only
   * caller) having to know which concrete Provider produced a given
   * result. */
  provider: string;
  /** Content-addressed model identity (Ollama's image digest, from
   * `GET /api/tags`) — distinguishes "same model tag, different underlying
   * weights" (e.g. after a local `ollama pull` updates `bge-m3:latest`)
   * from a genuine no-op re-embed. Free-form per Provider; this interface
   * doesn't interpret its contents beyond treating it as an opaque string
   * (F-1315). */
  modelDigest: string;
}

/**
 * The one operation this module's callers ever need. Implementations are
 * expected to enforce their own timeout/budget/rate-limit handling
 * internally and never throw for an expected failure mode (timeout, rate
 * limit, no API key, budget exhausted) — F-1304's "召回降级" depends on
 * every one of those failure modes reaching the caller as a rejected
 * promise so `embed-on-save.ts` can catch it uniformly, not on
 * distinguishing "why" via a thrown type hierarchy. Callers only need to
 * know "did this succeed or not," not which of the several ways it could
 * fail actually happened.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
}
