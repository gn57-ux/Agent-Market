import { describe, expect, it } from "vitest";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSignInMessage } from "./signInMessage.js";

const account = privateKeyToAccount(generatePrivateKey());

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

describe("buildSignInMessage (frontend twin)", () => {
  it("matches apps/api's exact literal template — any drift here breaks every login", () => {
    // Hardcoded against apps/api/src/modules/auth/signInMessage.ts's own
    // format (see that file's signInMessage.test.ts for the backend-side
    // equivalent of this fixture). If either file's template changes
    // without the other, this literal-string assertion is what catches it
    // — a "contains all fields" check would miss a reordering or a changed
    // literal line.
    const message = buildSignInMessage(sampleFields());
    expect(message).toBe(
      [
        "localhost wants you to sign in with your Ethereum account:",
        account.address,
        "",
        "Nonce: test-nonce-value",
        "Issued At: 2026-01-01T00:00:00.000Z",
        "Expiration Time: 2026-01-01T00:10:00.000Z",
      ].join("\n"),
    );
  });

  it("a signature over this message recovers to the signing address (viem's recoverMessageAddress — the same recovery apps/api's verifySignInSignature performs)", async () => {
    const message = buildSignInMessage(sampleFields());
    const signature = await account.signMessage({ message });

    const recovered = await recoverMessageAddress({ message, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("a signature does not recover correctly over a message built from different fields (e.g. tampered nonce)", async () => {
    const originalMessage = buildSignInMessage(sampleFields());
    const signature = await account.signMessage({ message: originalMessage });
    const tamperedMessage = buildSignInMessage(sampleFields({ nonce: "attacker-nonce" }));

    const recovered = await recoverMessageAddress({ message: tamperedMessage, signature });
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });
});
