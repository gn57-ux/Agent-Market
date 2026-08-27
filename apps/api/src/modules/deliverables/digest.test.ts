import { describe, expect, it } from "vitest";
import { computeFileDigest, computeUrlDigest } from "./digest.js";

describe("computeFileDigest", () => {
  it("returns a well-formed 0x-prefixed 32-byte hex string", () => {
    const digest = computeFileDigest(Buffer.from("hello"));
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for identical bytes", () => {
    const a = computeFileDigest(Buffer.from("same content"));
    const b = computeFileDigest(Buffer.from("same content"));
    expect(a).toBe(b);
  });

  it("differs for different bytes, even a single-byte change", () => {
    const a = computeFileDigest(Buffer.from("content A"));
    const b = computeFileDigest(Buffer.from("content B"));
    expect(a).not.toBe(b);
  });
});

describe("computeUrlDigest", () => {
  it("returns a well-formed 0x-prefixed 32-byte hex string", () => {
    const digest = computeUrlDigest("https://example.com/result.pdf");
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for the same URL", () => {
    const a = computeUrlDigest("https://example.com/result.pdf");
    const b = computeUrlDigest("https://example.com/result.pdf");
    expect(a).toBe(b);
  });

  it("normalizes surrounding whitespace to the same digest", () => {
    const a = computeUrlDigest("https://example.com/result.pdf");
    const b = computeUrlDigest("  https://example.com/result.pdf  ");
    expect(a).toBe(b);
  });

  it("differs for different URLs", () => {
    const a = computeUrlDigest("https://example.com/a.pdf");
    const b = computeUrlDigest("https://example.com/b.pdf");
    expect(a).not.toBe(b);
  });
});
