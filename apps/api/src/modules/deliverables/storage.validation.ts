/**
 * Shared validation rules for every `saveFile` implementation
 * (`storage.local.ts`, `storage.s3.ts`, and any future one) — extracted so
 * the MIME whitelist and size limit have exactly one owner (CLAUDE.md 原则
 * 6: 设计知识只能有一个归属) instead of being copy-pasted into each storage
 * backend and silently drifting apart. `storage.local.ts` re-exports the
 * constants/error classes below for backward compatibility with existing
 * imports (its own test file, `routes.ts` prior to the T-2300 composition
 * root) — this module is the single source of truth, not a competing one.
 */

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

/** 20 MiB — a reasonable ceiling for a demo-scope deliverable, not a
 * business rule derived from any spec number (design.md left the concrete
 * value to implementation time). Applies identically to every storage
 * backend — the limit is about the deliverable itself, not the medium it
 * happens to be persisted to. */
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

export interface ValidatableFile {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Throws `DeliverableFileTypeNotAllowedError`/`DeliverableFileTooLargeError`
 * under the exact same rules for every storage backend. Every `saveFile`
 * implementation must call this before writing anything, so a rejected
 * file never reaches the underlying medium (local disk or an object
 * storage PUT) — matching `storage.local.ts`'s original ordering (AC-904).
 */
export function validateDeliverableFile(input: ValidatableFile): void {
  if (!ALLOWED_MIME_TYPES.includes(input.mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
    throw new DeliverableFileTypeNotAllowedError(input.mimeType);
  }
  if (input.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new DeliverableFileTooLargeError(input.buffer.byteLength, MAX_FILE_SIZE_BYTES);
  }
}
