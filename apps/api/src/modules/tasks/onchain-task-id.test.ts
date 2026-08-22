import { describe, expect, it } from "vitest";
import { deriveOnChainTaskId } from "./onchain-task-id.js";

describe("deriveOnChainTaskId", () => {
  it("computes the same bytes32 every time for the same UUID", () => {
    const uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(deriveOnChainTaskId(uuid)).toBe(deriveOnChainTaskId(uuid));
  });

  it("computes different bytes32 values for different UUIDs", () => {
    const a = deriveOnChainTaskId("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    const b = deriveOnChainTaskId("11111111-1111-4111-8111-111111111111");
    expect(a).not.toBe(b);
  });

  it("returns a well-formed 0x-prefixed 32-byte hex string", () => {
    const hash = deriveOnChainTaskId("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
