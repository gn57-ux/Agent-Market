import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { SaveFileInput, SavedFile } from "./storage.local.js";
import { validateDeliverableFile } from "./storage.validation.js";

/**
 * S3-API-compatible object storage implementation (T-2300, F-2301) — the
 * exact same `saveFile`/`readFile`/`deleteFile` signatures as
 * `storage.local.ts`, so `storage.ts`'s composition root can swap between
 * the two with no change at any call site (design.md 决策 2 / AC-2301).
 *
 * Built on the standard `@aws-sdk/client-s3` SDK rather than a
 * vendor-specific client: R2 exposes an S3-compatible API, so pointing
 * `DELIVERABLE_STORAGE_S3_ENDPOINT` at R2, at a local MinIO container, or
 * leaving it unset (real AWS S3) all work through this one implementation
 * — only configuration changes, never this code (Q-2301: the target
 * platform decision does not affect this Task).
 *
 * Re-exported constants/error classes come from `storage.validation.ts`,
 * the single owner of the MIME whitelist and size limit (CLAUDE.md 原则 6)
 * — this module does not redefine or duplicate that logic.
 */
export {
  ALLOWED_MIME_TYPES,
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  MAX_FILE_SIZE_BYTES,
} from "./storage.validation.js";

export type { SaveFileInput, SavedFile } from "./storage.local.js";

/**
 * Resolved per call, not cached at module load — same reasoning as
 * `storage.local.ts`'s `storageRoot()`: this module can be imported
 * before `--env-file-if-exists` has populated `process.env` (e.g. a test
 * importing it directly and setting env vars in `beforeEach`), so reading
 * env eagerly at import time would capture a stale/empty value.
 */
function bucketName(): string {
  const bucket = process.env.DELIVERABLE_STORAGE_S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "DELIVERABLE_STORAGE_S3_BUCKET is not configured (required when DELIVERABLE_STORAGE_PROVIDER=s3)",
    );
  }
  return bucket;
}

/**
 * N4 real finding (round 2, T-2300, P2): a fresh `S3Client` (and thus a
 * fresh HTTP connection pool) was previously created for every single
 * `saveFile`/`readFile`/`deleteFile` call — under real production traffic
 * this defeats keep-alive reuse and leaks idle sockets/handles, since none
 * of those one-shot clients was ever destroyed. Cached here, keyed by the
 * effective config (not just "always the same instance"): a test that
 * changes `DELIVERABLE_STORAGE_S3_*` env vars between calls (this module's
 * own `beforeEach` convention, and `storage.test.ts`'s composition-root
 * tests) must still get a client built from ITS config, not a stale one
 * memoized under a different config.
 */
let cachedClient: { key: string; client: S3Client } | undefined;

/**
 * `forcePathStyle` is required for MinIO/R2-style endpoints (virtual-hosted
 * `bucket.endpoint` style DNS resolution does not exist for a local
 * container or a non-AWS endpoint) — only applied when an explicit
 * endpoint override is configured; real AWS S3 (no endpoint override)
 * keeps the SDK's default virtual-hosted addressing.
 */
function createClient(): S3Client {
  const endpoint = process.env.DELIVERABLE_STORAGE_S3_ENDPOINT;
  // N4 real finding (round 1, T-2300, P2): `auto` is an R2-specific
  // pseudo-region — forcing it unconditionally broke the real AWS S3
  // configuration path this module explicitly claims to support (a
  // deployment with no endpoint override, relying on the SDK's own
  // standard region resolution — `AWS_REGION`/shared config/IAM role —
  // would have every request signed against an invalid "auto" region
  // instead). `auto` is now only the default when an endpoint override IS
  // configured (R2/MinIO/any non-AWS S3-compatible service); real AWS S3
  // (no endpoint override) leaves `region` unset so the SDK's own standard
  // resolution chain applies, unless the caller explicitly set
  // `DELIVERABLE_STORAGE_S3_REGION` (always honored regardless of
  // endpoint).
  const explicitRegion = process.env.DELIVERABLE_STORAGE_S3_REGION;
  const region = explicitRegion ?? (endpoint ? "auto" : undefined);
  const accessKeyId = process.env.DELIVERABLE_STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.DELIVERABLE_STORAGE_S3_SECRET_ACCESS_KEY;

  const cacheKey = JSON.stringify({ endpoint, region, accessKeyId, secretAccessKey });
  if (cachedClient && cachedClient.key === cacheKey) {
    return cachedClient.client;
  }

  const client = new S3Client({
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    // Falls back to the SDK's default credential provider chain (env vars
    // it recognizes natively, shared config file, IAM role, etc.) when
    // these two are not both set — matching the Task's requirement to
    // support either explicit credentials or the default chain.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  cachedClient = { key: cacheKey, client };
  return client;
}

/**
 * Validates type/size under the exact same rules as `storage.local.ts`
 * (AC-904, via the shared `storage.validation.ts`) and PUTs the object
 * under a random key — same "unguessable key, not the caller's original
 * filename" property as the local implementation's `randomUUID()` path.
 */
export async function saveFile(input: SaveFileInput): Promise<SavedFile> {
  return putObjectWithKey(randomUUID(), input);
}

/**
 * N4 real finding (round 1, T-2300, P1): the composition root
 * (`storage.ts`) picks ONE backend for every read, based purely on the
 * current `DELIVERABLE_STORAGE_PROVIDER` value — it has no per-row record
 * of which backend a given `deliverables.file_path` was actually written
 * to (the schema only distinguishes `storage_type` LOCAL_FILE vs URL, an
 * orthogonal concept — see `repository.ts`). Flipping the provider from
 * `local` to `s3` on a system with EXISTING local-written deliverables
 * would make every one of those existing downloads fail — the real
 * production-cutover gap Codex's own review caught. This function is the
 * fix's other half (see `apps/api/scripts/migrate-local-deliverables-to-s3.ts`,
 * T-2300): it PUTs an object under a CALLER-SPECIFIED key rather than a
 * freshly generated one, so a migration script can copy each existing
 * local file into S3 under the EXACT SAME key its `deliverables.file_path`
 * row already stores — no DB row needs to change, and reads resolve
 * correctly the instant the provider switch takes effect, because the key
 * space is shared (both backends independently chose `randomUUID()` as
 * their own opaque key format — a real, load-bearing coincidence this
 * migration path depends on, not an assumption invented here).
 */
export async function putObjectWithKey(key: string, input: SaveFileInput): Promise<SavedFile> {
  validateDeliverableFile(input);

  const client = createClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: input.buffer,
      ContentType: input.mimeType,
      ContentLength: input.buffer.byteLength,
    }),
  );

  return { filePath: key, sizeBytes: input.buffer.byteLength, mimeType: input.mimeType };
}

/**
 * Reads back an object previously written by `saveFile`, given the exact
 * `filePath` (S3 key) value that call returned. Throws (the SDK's
 * `NoSuchKey` error) when the key does not exist — same "reading a
 * nonexistent file throws" behavior as `storage.local.ts`'s underlying
 * `fs.readFile` ENOENT, so callers that do not inspect the specific error
 * type (routes.ts does not) see identical control flow either way.
 */
export async function readFile(filePath: string): Promise<Buffer> {
  const client = createClient();
  const result = await client.send(new GetObjectCommand({ Bucket: bucketName(), Key: filePath }));
  if (!result.Body) {
    throw new Error(`S3 object ${filePath} returned no body`);
  }
  const bytes = await result.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Deletes an object previously written by `saveFile`. `DeleteObject` is
 * idempotent on S3-compatible stores — deleting an already-missing key is
 * not itself an error — matching `storage.local.ts`'s `rm(..., { force:
 * true })` best-effort-cleanup semantics (routes.ts's orphaned-file
 * cleanup after a failed DB write relies on this not throwing when the
 * key is already gone).
 */
export async function deleteFile(filePath: string): Promise<void> {
  const client = createClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: filePath }));
}
