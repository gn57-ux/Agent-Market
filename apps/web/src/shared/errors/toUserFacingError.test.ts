import { describe, expect, it } from "vitest";
import { toUserFacingError } from "./toUserFacingError.js";

describe("toUserFacingError", () => {
  it("hides viem internals when the wallet signature is rejected", () => {
    expect(
      toUserFacingError(
        new Error("User rejected the request. Request Arguments: ... Version: viem@2.0.0"),
        "操作失败。",
      ),
    ).toBe("你已取消钱包操作，可以重新尝试。");
  });

  it("recognizes the provider rejection code without a message", () => {
    expect(toUserFacingError({ code: 4001 }, "操作失败。")).toBe(
      "你已取消钱包操作，可以重新尝试。",
    );
  });

  it("explains insufficient gas in local-test language", () => {
    expect(toUserFacingError(new Error("insufficient funds for gas"), "操作失败。")).toBe(
      "当前账户的测试 ETH 不足，无法支付网络费。",
    );
  });
});
