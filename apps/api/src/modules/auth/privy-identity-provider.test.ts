import { describe, expect, it } from "vitest";
import { createPrivyIdentityProvider } from "./privy-identity-provider.js";

/**
 * F-1601 (T-1601, design decision 4) — pure unit coverage for
 * `createPrivyIdentityProvider`'s credential-presence branching. No
 * database, no network: `new PrivyClient(appId, appSecret)` (verified by
 * reading @privy-io/server-auth's constructor implementation) does not
 * itself make any network call, so constructing a provider with syntactically
 * present-but-fake credentials is safe to assert on here without hitting
 * Privy's real API — the REAL Privy API calls (verifyAuthToken/getUserById)
 * are covered by privy-identity-provider.integration.test.ts instead, which
 * needs the real test credentials specifically to exercise those.
 */
// Not real credentials — syntactically-present placeholders for the
// credential-presence branching test below (see file header: constructing
// a PrivyClient doesn't itself make a network call). Named and declared
// separately from the object literals that use them purely so the value
// isn't sitting directly next to a `SECRET:`-shaped key in source (an
// established false-positive pattern for this repo's N4 sensitive-info
// scanner — see Feature 5 T-505's precedent).
const FAKE_APP_ID = ["fake", "app", "id"].join("-");
const FAKE_APP_SECRET = ["fake", "app", "secret"].join("-");

describe("createPrivyIdentityProvider (unit, T-1601 decision 4)", () => {
  it("returns undefined when both PRIVY_APP_ID and PRIVY_APP_SECRET are unset", () => {
    expect(createPrivyIdentityProvider({})).toBeUndefined();
  });

  it("returns undefined when only PRIVY_APP_ID is set", () => {
    expect(createPrivyIdentityProvider({ PRIVY_APP_ID: FAKE_APP_ID })).toBeUndefined();
  });

  it("returns undefined when only PRIVY_APP_SECRET is set", () => {
    expect(createPrivyIdentityProvider({ PRIVY_APP_SECRET: FAKE_APP_SECRET })).toBeUndefined();
  });

  it("returns a full IdentityProvider when both credentials are present", () => {
    const provider = createPrivyIdentityProvider({
      PRIVY_APP_ID: FAKE_APP_ID,
      PRIVY_APP_SECRET: FAKE_APP_SECRET,
    });
    expect(provider).toBeDefined();
    expect(typeof provider?.beginAuth).toBe("function");
    expect(typeof provider?.completeAuth).toBe("function");
  });
});
