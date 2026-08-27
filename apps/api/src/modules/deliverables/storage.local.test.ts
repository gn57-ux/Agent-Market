import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  DeliverableStoragePathEscapeError,
  MAX_FILE_SIZE_BYTES,
  deleteFile,
  readFile,
  saveFile,
} from "./storage.local.js";

let storageDir: string;
let previousEnv: string | undefined;

beforeEach(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), "deliverables-test-"));
  previousEnv = process.env.DELIVERABLE_STORAGE_DIR;
  process.env.DELIVERABLE_STORAGE_DIR = storageDir;
});

afterEach(async () => {
  if (previousEnv === undefined) {
    delete process.env.DELIVERABLE_STORAGE_DIR;
  } else {
    process.env.DELIVERABLE_STORAGE_DIR = previousEnv;
  }
  await rm(storageDir, { recursive: true, force: true });
});

describe("storage.local", () => {
  it("saves a file with an allowed mime type and reads back identical bytes (AC-901)", async () => {
    const buffer = Buffer.from("hello deliverable");
    const saved = await saveFile({ buffer, mimeType: "application/pdf" });

    expect(saved.sizeBytes).toBe(buffer.byteLength);
    expect(saved.mimeType).toBe("application/pdf");

    const readBack = await readFile(saved.filePath);
    expect(readBack.equals(buffer)).toBe(true);
  });

  it("uses a random filename, never the caller's original filename or any predictable value", async () => {
    const buffer = Buffer.from("same content twice");
    const first = await saveFile({ buffer, mimeType: "text/plain" });
    const second = await saveFile({ buffer, mimeType: "text/plain" });

    expect(first.filePath).not.toBe(second.filePath);
    // Neither stored path should be a short/sequential/guessable value —
    // random UUIDs are 36 characters.
    expect(first.filePath.length).toBeGreaterThanOrEqual(36);
  });

  it("rejects a disallowed mime type before writing anything to disk (AC-904)", async () => {
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
  });

  it("rejects reading a path that attempts to escape the storage root", async () => {
    await expect(readFile("../../etc/passwd")).rejects.toBeInstanceOf(
      DeliverableStoragePathEscapeError,
    );
  });

  it("creates the storage root directory on first write when it does not yet exist", async () => {
    const nestedDir = path.join(storageDir, "does-not-exist-yet");
    process.env.DELIVERABLE_STORAGE_DIR = nestedDir;

    const saved = await saveFile({ buffer: Buffer.from("x"), mimeType: "text/plain" });
    const readBack = await readFile(saved.filePath);
    expect(readBack.toString()).toBe("x");
  });

  // routes.ts's POST handler cleanup path (N4 round 1 P2, Codex): a
  // deliverable saved to disk but never successfully persisted to the
  // database must not remain an orphaned file forever.
  it("deleteFile removes a file previously written by saveFile", async () => {
    const saved = await saveFile({ buffer: Buffer.from("orphan"), mimeType: "text/plain" });
    await deleteFile(saved.filePath);
    await expect(readFile(saved.filePath)).rejects.toThrow();
  });

  it("deleteFile does not throw for a file that was never written (best-effort cleanup)", async () => {
    await expect(deleteFile("never-existed")).resolves.toBeUndefined();
  });
});
