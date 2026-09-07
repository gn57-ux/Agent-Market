// Feature 23 (production-cloud-observability), T-2300 (F-2301).
//
// N4 real finding (round 1, T-2300, P1): `storage.ts`'s composition root
// picks ONE backend for every read based purely on the CURRENT
// `DELIVERABLE_STORAGE_PROVIDER` value — it has no per-row record of which
// backend a given `deliverables.file_path` was actually written under.
// Flipping the provider from `local` to `s3` on a system with EXISTING
// local-written deliverables would make every one of those existing
// downloads fail (a real production-cutover gap, not a hypothetical one —
// this repo has real local deliverable uploads today, Feature 9).
//
// This script is the real fix: it copies every existing `LOCAL_FILE`
// deliverable's bytes into the configured S3 bucket under the EXACT SAME
// key its `deliverables.file_path` row already stores (via
// `storage.s3.ts`'s `putObjectWithKey`, not the normal `saveFile`, which
// would generate a fresh random key) — no DB row needs to change. Both
// backends independently use `randomUUID()` as their own opaque key
// format, so the key space is shared; this is what makes an in-place
// migration (rather than a data migration that rewrites every
// `file_path`) possible at all.
//
// Run as `pnpm --filter @agent-market/api migrate-local-deliverables-to-s3`
// (see package.json) AFTER configuring the real
// `DELIVERABLE_STORAGE_S3_*` env vars for the target bucket, and BEFORE
// flipping `DELIVERABLE_STORAGE_PROVIDER` to `s3` in the running system —
// this script always reads via the LOCAL backend and always writes via
// the S3 backend, regardless of `DELIVERABLE_STORAGE_PROVIDER`'s own
// current value (it does not go through the composition root, since its
// whole job is moving data FROM one specific backend TO the other, not
// following whichever one happens to be currently selected).
//
// Idempotent and resumable: every run re-verifies each row by attempting
// a real read from S3 first; a row whose object already exists there
// (byte-for-byte, re-verified via a checksum comparison) is skipped, so
// interrupting this script and re-running it later only re-copies what is
// still genuinely missing.
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/db/pool.js";
import { readFile as readLocalFile } from "../src/modules/deliverables/storage.local.js";
import {
  putObjectWithKey,
  readFile as readS3File,
} from "../src/modules/deliverables/storage.s3.js";

interface LocalDeliverableRow {
  id: string;
  file_path: string;
  mime_type: string | null;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export interface MigrationResult {
  copied: number;
  alreadyPresent: number;
  failed: { id: string; filePath: string; error: string }[];
}

export async function migrateLocalDeliverablesToS3(pool: Pool): Promise<MigrationResult> {
  const { rows } = await pool.query<LocalDeliverableRow>(
    `SELECT id, file_path, mime_type
       FROM deliverables
      WHERE storage_type = 'LOCAL_FILE' AND file_path IS NOT NULL
      ORDER BY created_at ASC`,
  );

  let copied = 0;
  let alreadyPresent = 0;
  const failed: MigrationResult["failed"] = [];

  for (const row of rows) {
    try {
      const localBuffer = await readLocalFile(row.file_path);

      try {
        const existingBuffer = await readS3File(row.file_path);
        if (sha256(existingBuffer) === sha256(localBuffer)) {
          alreadyPresent += 1;
          continue;
        }
        // A real, genuine content mismatch between the two backends for
        // the SAME key is a real data-integrity problem this script must
        // never silently paper over by re-uploading — surfaced as a
        // failure for a human to investigate, not auto-resolved.
        throw new Error(
          `object already exists in S3 under key ${row.file_path} but its content does not match the local file — refusing to overwrite`,
        );
      } catch (readError) {
        // A genuine "not found in S3 yet" is the expected, common case —
        // proceed to copy. Any OTHER error from the read attempt above
        // (including the deliberate mismatch error just thrown) must
        // propagate as a real failure, not be treated as "not found".
        const isNotFound =
          readError instanceof Error &&
          (readError.name === "NoSuchKey" || readError.message.includes("NoSuchKey"));
        if (!isNotFound) {
          throw readError;
        }
      }

      await putObjectWithKey(row.file_path, {
        buffer: localBuffer,
        mimeType: row.mime_type ?? "application/octet-stream",
      });
      copied += 1;
    } catch (error) {
      failed.push({
        id: row.id,
        filePath: row.file_path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { copied, alreadyPresent, failed };
}

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const result = await migrateLocalDeliverablesToS3(pool);
    console.log(
      `迁移完成：${result.copied} 个文件已复制到 S3，${result.alreadyPresent} 个已存在（内容一致，跳过），${result.failed.length} 个失败。`,
    );
    for (const failure of result.failed) {
      console.error(
        `  失败：deliverable ${failure.id}（file_path=${failure.filePath}）：${failure.error}`,
      );
    }
    if (result.failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
