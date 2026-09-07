import { randomUUID } from "node:crypto";
import { mkdir, readFile as fsReadFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_MIME_TYPES,
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  MAX_FILE_SIZE_BYTES,
  validateDeliverableFile,
} from "./storage.validation.js";

/**
 * Re-exported from `storage.validation.ts` (the single source of truth,
 * T-2300) so existing imports of these names from `storage.local.ts`
 * (this module's own test file, and any pre-composition-root call site)
 * keep working unchanged — this module no longer defines them itself.
 */
export {
  ALLOWED_MIME_TYPES,
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  MAX_FILE_SIZE_BYTES,
};

/** Thrown by `readFile` when asked to read outside the configured storage
 * root — defense-in-depth against a malformed/tampered stored `file_path`
 * value ever being used to escape the storage directory, even though every
 * path this module itself writes is a random filename it generated (never
 * derived from user input). */
export class DeliverableStoragePathEscapeError extends Error {
  constructor(public readonly requestedPath: string) {
    super(`Path escapes the deliverable storage root: ${requestedPath}`);
    this.name = "DeliverableStoragePathEscapeError";
  }
}

/**
 * Resolved once per call rather than cached at module load — this module
 * is imported before `--env-file-if-exists` has necessarily populated
 * `process.env` in every entry point (e.g. a test importing it directly),
 * same reasoning as `permit.service.ts`'s `process.env.ACCEPTANCE_PERMIT_SIGNER_KEY`
 * read happening inside its function body, not at import time.
 */
function storageRoot(): string {
  return path.resolve(process.cwd(), process.env.DELIVERABLE_STORAGE_DIR ?? "var/deliverables");
}

export interface SaveFileInput {
  buffer: Buffer;
  mimeType: string;
}

export interface SavedFile {
  /** Relative to the storage root — this is the exact value persisted as
   * `deliverables.file_path`. Never an absolute filesystem path, so the
   * storage root can move (e.g. between environments) without invalidating
   * already-recorded rows. */
  filePath: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Validates type/size (AC-904) and writes `input.buffer` to a
 * random-filename path under the storage root (PRD §15.1 "本地存储路径不可
 * 被外部直接猜测遍历" — design.md's "使用不可猜测的随机文件名" — `randomUUID()`,
 * not the original filename, which is never even accepted as a parameter
 * here: the caller's original filename has no bearing on where the file
 * is actually stored). Creates the storage root directory on first write
 * rather than requiring it to pre-exist.
 */
export async function saveFile(input: SaveFileInput): Promise<SavedFile> {
  validateDeliverableFile(input);

  const root = storageRoot();
  await mkdir(root, { recursive: true });
  const filePath = randomUUID();
  await writeFile(path.join(root, filePath), input.buffer);

  return { filePath, sizeBytes: input.buffer.byteLength, mimeType: input.mimeType };
}

/**
 * Reads back a file previously written by `saveFile`, given the exact
 * `filePath` value that call returned (and that the caller is expected to
 * have persisted as `deliverables.file_path`).
 */
/**
 * Single place that turns a stored `filePath` into an absolute path AND
 * enforces it stays inside the storage root — `readFile` and `deleteFile`
 * both need exactly this check, so it lives once here rather than being
 * copied into each (CLAUDE.md 原则 6: 设计知识只能有一个归属).
 */
function resolveWithinRoot(filePath: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, filePath);
  // `path.resolve` collapses `..` segments — this check only passes when
  // the resolved path is still inside `root`, catching any `filePath` that
  // would otherwise escape the storage directory (e.g. `../../etc/passwd`).
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new DeliverableStoragePathEscapeError(filePath);
  }
  return resolved;
}

export async function readFile(filePath: string): Promise<Buffer> {
  return fsReadFile(resolveWithinRoot(filePath));
}

/**
 * Deletes a file previously written by `saveFile` — used by
 * `routes.ts`'s POST handler to clean up an orphaned file when the
 * subsequent database write fails (N4 round 1 P2, Codex): without this,
 * a DB-insert failure after a successful `saveFile` call leaves an
 * unreferenced file on disk forever, since nothing else ever points back
 * to it. `force: true` so deleting an already-missing file (e.g. a
 * concurrent cleanup, or the file having never been written) is not
 * itself an error — this is a best-effort cleanup, not a operation whose
 * own failure should mask the original database error it's responding
 * to.
 */
export async function deleteFile(filePath: string): Promise<void> {
  await rm(resolveWithinRoot(filePath), { force: true });
}
