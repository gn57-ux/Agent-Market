import { describe, expect, it } from "vitest";
import { createOfficeFundsReader } from "./funds-reader.js";

describe("createOfficeFundsReader", () => {
  it("fails closed when chain configuration is absent", async () => {
    const reader = createOfficeFundsReader({});
    await expect(
      reader.read("0x1234567890abcdef1234567890abcdef12345678", [], []),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "CHAIN_CONFIG_INVALID",
    });
  });
});
