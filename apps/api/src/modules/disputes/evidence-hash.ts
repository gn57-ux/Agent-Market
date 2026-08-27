import { createHash } from "node:crypto";

/**
 * The single implementation of "证据摘要哈希" this module owns
 * (design.md's F-1003: "证据正文链下、摘要哈希链上"). SHA-256 of the
 * trimmed evidence text, lowercase-hex, `0x`-prefixed — the exact shape
 * `disputes.evidence_hash`'s CHECK constraint (0011_create_disputes.sql)
 * and `TaskEscrow.openDispute`'s `bytes32 disputeEvidenceHash` parameter
 * both require.
 *
 * Deliberately a SEPARATE implementation from `deliverables/digest.ts`'s
 * `computeUrlDigest` rather than importing it, even though both are
 * "SHA-256 of a trimmed string" — evidence hashing is this module's own
 * concern (disputes), not deliverables', and the two Features' digest
 * rules are free to diverge in the future without either accidentally
 * depending on the other's internal choice (narrow module boundaries over
 * a two-line shared helper, matching this codebase's established
 * `ResultSubmittedLogScanner`-vs-`ChainRpcClient` precedent for the same
 * reasoning).
 */
export function computeEvidenceHash(evidenceSummary: string): `0x${string}` {
  return `0x${createHash("sha256").update(evidenceSummary.trim(), "utf8").digest("hex")}`;
}
