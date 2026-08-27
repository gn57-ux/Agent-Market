import { createHash } from "node:crypto";

/**
 * The single implementation of "规范化成果摘要" (design.md's `digest.ts` —
 * "唯一的摘要生成来源"). Every value this module returns is a lowercase
 * `0x`-prefixed 32-byte hex string — the exact shape `deliverables.result_hash`
 * (0009_create_deliverables.sql's CHECK) and `TaskEscrow.submitResult`'s
 * `bytes32 resultHash` parameter both require, so a value returned here
 * never needs reformatting before either use.
 *
 * SHA-256 (not keccak256/viem) — the contract treats `resultHash` as an
 * opaque `bytes32` with no algorithm requirement of its own (it is never
 * recomputed or verified on-chain, only stored and later compared for
 * equality against what the requester/tests independently compute), so
 * this module is free to pick the algorithm a "content hash" most commonly
 * means outside a blockchain context.
 */
function toHexDigest(buffer: Buffer): `0x${string}` {
  return `0x${createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * The hash T-906's three-way consistency test asserts equals both
 * `deliverables.result_hash` and the on-chain `submitResult` argument for a
 * LOCAL_FILE deliverable: a direct SHA-256 of the exact bytes stored by
 * `storage.local.ts`'s `saveFile` — no re-encoding, whitespace trimming, or
 * other transformation between "what was uploaded" and "what gets hashed".
 */
export function computeFileDigest(buffer: Buffer): `0x${string}` {
  return toHexDigest(buffer);
}

/**
 * For a URL-type deliverable there is no local file content to hash (F-901;
 * "一期不保证外部 URL 永久可用" — design.md never fetches/mirrors the URL's
 * remote content). The "规范化成果摘要" for this case is instead a hash of
 * the URL string itself, after trimming surrounding whitespace — the one
 * normalization step that matters here, since two requests that only differ
 * by incidental leading/trailing whitespace should produce the same digest.
 */
export function computeUrlDigest(url: string): `0x${string}` {
  return toHexDigest(Buffer.from(url.trim(), "utf8"));
}
