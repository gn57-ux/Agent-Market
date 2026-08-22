import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSignInMessage, verifySignInSignature } from "./signInMessage.js";

const account = privateKeyToAccount(generatePrivateKey());
const otherAccount = privateKeyToAccount(generatePrivateKey());

function sampleFields(overrides: Partial<Parameters<typeof buildSignInMessage>[0]> = {}) {
  return {
    domain: "localhost",
    address: account.address,
    nonce: "test-nonce-value",
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-01-01T00:10:00.000Z"),
    ...overrides,
  };
}

describe("buildSignInMessage", () => {
  it("is deterministic for the same fields", () => {
    const fields = sampleFields();
    expect(buildSignInMessage(fields)).toBe(buildSignInMessage(fields));
  });

  it("changes when any field changes", () => {
    const base = buildSignInMessage(sampleFields());
    expect(buildSignInMessage(sampleFields({ nonce: "different-nonce" }))).not.toBe(base);
    expect(buildSignInMessage(sampleFields({ domain: "example.com" }))).not.toBe(base);
    expect(
      buildSignInMessage(sampleFields({ issuedAt: new Date("2026-01-01T00:01:00.000Z") })),
    ).not.toBe(base);
  });

  it("includes all required fields (domain, address, nonce, issuedAt, expiresAt)", () => {
    const fields = sampleFields();
    const message = buildSignInMessage(fields);
    expect(message).toContain(fields.domain);
    expect(message).toContain(fields.address);
    expect(message).toContain(fields.nonce);
    expect(message).toContain(fields.issuedAt.toISOString());
    expect(message).toContain(fields.expiresAt.toISOString());
  });
});

describe("verifySignInSignature", () => {
  it("accepts a real signature from the address it claims to be from", async () => {
    const message = buildSignInMessage(sampleFields());
    const signature = await account.signMessage({ message });

    const valid = await verifySignInSignature({ address: account.address, message, signature });
    expect(valid).toBe(true);
  });

  it("rejects a signature from a different account", async () => {
    const message = buildSignInMessage(sampleFields());
    const signature = await otherAccount.signMessage({ message });

    const valid = await verifySignInSignature({ address: account.address, message, signature });
    expect(valid).toBe(false);
  });

  it("rejects a valid signature over a different message (e.g. a tampered nonce)", async () => {
    const originalMessage = buildSignInMessage(sampleFields());
    const signature = await account.signMessage({ message: originalMessage });
    const tamperedMessage = buildSignInMessage(
      sampleFields({ nonce: "attacker-substituted-nonce" }),
    );

    const valid = await verifySignInSignature({
      address: account.address,
      message: tamperedMessage,
      signature,
    });
    expect(valid).toBe(false);
  });

  it("returns false (not throw) for a malformed signature", async () => {
    const message = buildSignInMessage(sampleFields());
    const valid = await verifySignInSignature({
      address: account.address,
      message,
      signature: "0xnotarealsignature",
    });
    expect(valid).toBe(false);
  });

  it("address comparison is case-insensitive", async () => {
    const message = buildSignInMessage(sampleFields());
    const signature = await account.signMessage({ message });

    const valid = await verifySignInSignature({
      address: account.address.toUpperCase(),
      message,
      signature,
    });
    expect(valid).toBe(true);
  });
});
