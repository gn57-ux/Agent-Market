import { createHash } from "node:crypto";

/**
 * Recursively sorts every object's keys (alphabetically) so two values that
 * are logically identical but were constructed with differently-ordered
 * object literals serialize to byte-identical JSON. Arrays keep their order
 * (order is semantically meaningful for `MatchRequest.candidates[]` etc — it
 * is not itself sorted, only each element's own keys are, recursively).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * SHA-256 (hex) of `value`'s canonical-JSON form (T-709, P2) — the digest
 * `matchTask` (routes.ts) stores on `recommendation_runs.input_digest` for
 * the exact `MatchRequest` sent to the Go dispatch service on this run. Two
 * calls with logically identical input but different key ordering produce
 * the same digest; any actual difference in the input produces a different
 * one. Uses only Node's built-in `crypto` — no new dependency (T-709
 * capsule's explicit constraint).
 */
export function canonicalJsonSha256(value: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(canonicalJson).digest("hex");
}
