import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  MAX_FILE_SIZE_BYTES,
  deleteFile,
  readFile,
  saveFile,
} from "./storage.s3.js";

/**
 * Real round-trip verification against a real MinIO container (T-2300) —
 * mirrors `storage.local.test.ts`'s scenarios one for one so both
 * implementations are held to the exact same contract (AC-2301: switching
 * `DELIVERABLE_STORAGE_PROVIDER` must not require touching any assertion
 * logic). No mock/stub S3 client is used anywhere in this file — every
 * `saveFile`/`readFile`/`deleteFile` call below performs a real HTTP call
 * against a real, unmodified, S3-API-compatible MinIO server.
 *
 * Skipped unless a human opts in with RUN_S3_INTEGRATION_TESTS=1 against a
 * running MinIO container, same "opt-in against a live dependency" pattern
 * as `repository.integration.test.ts`'s `RUN_DB_INTEGRATION_TESTS`. Start
 * MinIO with:
 *   docker run -d --name deliverable-storage-minio -p 9000:9000 -p 9001:9001 \
 *     -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
 *     minio/minio server /data --console-address ":9001"
 * and create the bucket named by DELIVERABLE_STORAGE_S3_BUCKET before running.
 */
const runIfOptedIn = process.env.RUN_S3_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const previousEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  previousEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  setEnv(
    "DELIVERABLE_STORAGE_S3_ENDPOINT",
    process.env.DELIVERABLE_STORAGE_S3_ENDPOINT ?? "http://localhost:9000",
  );
  setEnv(
    "DELIVERABLE_STORAGE_S3_BUCKET",
    process.env.DELIVERABLE_STORAGE_S3_BUCKET ?? "deliverables-test",
  );
  setEnv("DELIVERABLE_STORAGE_S3_REGION", process.env.DELIVERABLE_STORAGE_S3_REGION ?? "auto");
  setEnv(
    "DELIVERABLE_STORAGE_S3_ACCESS_KEY_ID",
    process.env.DELIVERABLE_STORAGE_S3_ACCESS_KEY_ID ?? "minioadmin",
  );
  setEnv(
    "DELIVERABLE_STORAGE_S3_SECRET_ACCESS_KEY",
    process.env.DELIVERABLE_STORAGE_S3_SECRET_ACCESS_KEY ?? "minioadmin",
  );
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

runIfOptedIn("storage.s3 (real MinIO integration)", () => {
  it("saves an object with an allowed mime type and reads back identical bytes (AC-901)", async () => {
    const buffer = Buffer.from("hello deliverable via s3");
    const saved = await saveFile({ buffer, mimeType: "application/pdf" });

    expect(saved.sizeBytes).toBe(buffer.byteLength);
    expect(saved.mimeType).toBe("application/pdf");

    const readBack = await readFile(saved.filePath);
    expect(readBack.equals(buffer)).toBe(true);

    await deleteFile(saved.filePath);
  });

  it("uses a random key, never the caller's original filename or any predictable value", async () => {
    const buffer = Buffer.from("same content twice");
    const first = await saveFile({ buffer, mimeType: "text/plain" });
    const second = await saveFile({ buffer, mimeType: "text/plain" });

    expect(first.filePath).not.toBe(second.filePath);
    expect(first.filePath.length).toBeGreaterThanOrEqual(36);

    await deleteFile(first.filePath);
    await deleteFile(second.filePath);
  });

  it("rejects a disallowed mime type before writing anything (AC-904)", async () => {
    await expect(
      saveFile({ buffer: Buffer.from("x"), mimeType: "application/x-msdownload" }),
    ).rejects.toBeInstanceOf(DeliverableFileTypeNotAllowedError);
  });

  it("rejects a file exceeding the maximum size (AC-904)", async () => {
    const oversized = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
    await expect(
      saveFile({ buffer: oversized, mimeType: "application/pdf" }),
    ).rejects.toBeInstanceOf(DeliverableFileTooLargeError);
  });

  it("accepts a file exactly at the maximum size (boundary)", async () => {
    const atLimit = Buffer.alloc(MAX_FILE_SIZE_BYTES);
    const saved = await saveFile({ buffer: atLimit, mimeType: "application/pdf" });
    expect(saved.sizeBytes).toBe(MAX_FILE_SIZE_BYTES);
    await deleteFile(saved.filePath);
  });

  // routes.ts's POST handler cleanup path relies on this exact behavior —
  // matches storage.local.test.ts's equivalent scenario.
  it("deleteFile removes an object previously written by saveFile, and a subsequent read fails", async () => {
    const saved = await saveFile({ buffer: Buffer.from("orphan"), mimeType: "text/plain" });
    await deleteFile(saved.filePath);
    await expect(readFile(saved.filePath)).rejects.toThrow();
  });

  it("deleteFile does not throw for an object that was never written (best-effort cleanup)", async () => {
    await expect(deleteFile("never-existed-key")).resolves.toBeUndefined();
  });
});
