import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteFile, readFile, resolveDeliverableStorage, saveFile } from "./storage.js";
import * as localStorage from "./storage.local.js";
import * as s3Storage from "./storage.s3.js";

/**
 * Composition-root unit coverage (T-2300) — proves AC-2301's actual claim
 * at the narrowest possible layer: flipping `DELIVERABLE_STORAGE_PROVIDER`
 * selects a different underlying implementation, with the SAME
 * `saveFile`/`readFile`/`deleteFile` call sites (this file never imports
 * `storage.local.js`/`storage.s3.js` directly to perform I/O — only to
 * assert which module `resolveDeliverableStorage()` picked). The actual
 * real-I/O round trips for each backend are covered separately:
 * `storage.local.test.ts` (local disk) and
 * `storage.s3.integration.test.ts` (real MinIO).
 */

let storageDir: string;
const previousEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  previousEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), "deliverables-storage-root-test-"));
  setEnv("DELIVERABLE_STORAGE_DIR", storageDir);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(storageDir, { recursive: true, force: true });
});

describe("resolveDeliverableStorage", () => {
  it("defaults to the local implementation when DELIVERABLE_STORAGE_PROVIDER is unset", () => {
    setEnv("DELIVERABLE_STORAGE_PROVIDER", undefined);
    expect(resolveDeliverableStorage()).toBe(localStorage);
  });

  it("selects the local implementation for DELIVERABLE_STORAGE_PROVIDER=local", () => {
    setEnv("DELIVERABLE_STORAGE_PROVIDER", "local");
    expect(resolveDeliverableStorage()).toBe(localStorage);
  });

  it("selects the s3 implementation for DELIVERABLE_STORAGE_PROVIDER=s3", () => {
    setEnv("DELIVERABLE_STORAGE_PROVIDER", "s3");
    expect(resolveDeliverableStorage()).toBe(s3Storage);
  });

  it("throws on an unrecognized provider value rather than silently falling back", () => {
    setEnv("DELIVERABLE_STORAGE_PROVIDER", "azure-blob");
    expect(() => resolveDeliverableStorage()).toThrow(/Unknown DELIVERABLE_STORAGE_PROVIDER/);
  });

  it("the top-level saveFile/readFile/deleteFile functions round-trip through the selected (local) provider unchanged", async () => {
    setEnv("DELIVERABLE_STORAGE_PROVIDER", "local");
    const buffer = Buffer.from("composition root round trip");
    const saved = await saveFile({ buffer, mimeType: "text/plain" });
    const readBack = await readFile(saved.filePath);
    expect(readBack.equals(buffer)).toBe(true);
    await deleteFile(saved.filePath);
    await expect(readFile(saved.filePath)).rejects.toThrow();
  });
});
