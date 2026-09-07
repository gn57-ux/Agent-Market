import * as localStorage from "./storage.local.js";
import * as s3Storage from "./storage.s3.js";
import type { SaveFileInput, SavedFile } from "./storage.local.js";

export type { SaveFileInput, SavedFile } from "./storage.local.js";
export {
  ALLOWED_MIME_TYPES,
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  MAX_FILE_SIZE_BYTES,
} from "./storage.validation.js";
/**
 * Local-only error class (path-escape defense-in-depth, see
 * `storage.local.ts`) — re-exported here too since call sites (`routes.ts`)
 * go through this composition root now instead of `storage.local.ts`
 * directly, and should not need to know which backend actually threw it.
 */
export { DeliverableStoragePathEscapeError } from "./storage.local.js";

export interface DeliverableStorage {
  saveFile(input: SaveFileInput): Promise<SavedFile>;
  readFile(filePath: string): Promise<Buffer>;
  deleteFile(filePath: string): Promise<void>;
}

/**
 * Composition root (T-2300, F-2301 / design.md "接口契约（草案）": "一个组合
 * 根函数...根据环境变量选择使用哪个") — the ONLY place that decides which
 * `saveFile`/`readFile`/`deleteFile` implementation actually runs.
 * `DELIVERABLE_STORAGE_PROVIDER` defaults to `local` so existing local dev
 * setups keep working unchanged (design.md non-functional requirement:
 * switching storage backend must be config-driven, no call-site changes).
 *
 * Resolved per call rather than cached at module load, same reasoning as
 * `storage.local.ts`'s `storageRoot()` and `storage.s3.ts`'s
 * `bucketName()`/`createClient()`: this module can be imported before env
 * vars are populated (e.g. a test setting `process.env` in `beforeEach`).
 */
export function resolveDeliverableStorage(): DeliverableStorage {
  const provider = process.env.DELIVERABLE_STORAGE_PROVIDER ?? "local";
  switch (provider) {
    case "local":
      return localStorage;
    case "s3":
      return s3Storage;
    default:
      throw new Error(
        `Unknown DELIVERABLE_STORAGE_PROVIDER: "${provider}" (expected "local" or "s3")`,
      );
  }
}

/**
 * Drop-in replacements for `storage.local.ts`'s top-level functions —
 * every existing call site (`routes.ts`) can import these three from this
 * module instead of importing a specific backend directly, and the
 * backend switch (AC-2301) requires zero changes to those call sites.
 */
export async function saveFile(input: SaveFileInput): Promise<SavedFile> {
  return resolveDeliverableStorage().saveFile(input);
}

export async function readFile(filePath: string): Promise<Buffer> {
  return resolveDeliverableStorage().readFile(filePath);
}

export async function deleteFile(filePath: string): Promise<void> {
  return resolveDeliverableStorage().deleteFile(filePath);
}
