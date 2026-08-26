import { randomUUID } from "node:crypto";
import { mkdir, readFile as fsReadFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * PRD §15.1 "限制上传文件类型、大小" — the single source of truth for both
 * limits (T-901). design.md deliberately left the exact whitelist for
 * implementation time rather than the requirements stage ("不在需求阶段预先
 * 穷举以免与实际演示素材脱节"); this is that concrete list — common
 * document/archive/image types a task deliverable would realistically be,
 * matching the demo scope this Feature targets.
 */
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
] as const;

/** 20 MiB — a reasonable ceiling for a demo-scope local filesystem, not a
 * business rule derived from any spec number (design.md left the concrete
 * value to implementation time, same as the type whitelist above). */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export class DeliverableFileTypeNotAllowedError extends Error {
  constructor(public readonly mimeType: string) {
    super(`File type not allowed: ${mimeType}`);
    this.name = "DeliverableFileTypeNotAllowedError";
  }
}

export class DeliverableFileTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`File size ${sizeBytes} exceeds maximum ${maxBytes}`);
    this.name = "DeliverableFileTooLargeError";
  }
}

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
  if (!ALLOWED_MIME_TYPES.includes(input.mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
    throw new DeliverableFileTypeNotAllowedError(input.mimeType);
  }
  if (input.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new DeliverableFileTooLargeError(input.buffer.byteLength, MAX_FILE_SIZE_BYTES);
  }

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
