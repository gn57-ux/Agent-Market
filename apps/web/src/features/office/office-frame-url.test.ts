import { describe, expect, it } from "vitest";
import { officeFrameUrl } from "./office-frame-url.js";

describe("officeFrameUrl", () => {
  it("uses the real API by default", () => {
    expect(officeFrameUrl("http://localhost:3001", null)).toBe(
      "/office-cocos/index.html?apiBaseUrl=http%3A%2F%2Flocalhost%3A3001",
    );
  });

  it.each(["1", "empty"])("forwards the allow-listed %s mock mode", (mockMode) => {
    expect(officeFrameUrl("/api", mockMode)).toBe(
      `/office-cocos/index.html?apiBaseUrl=%2Fapi&mock=${mockMode}`,
    );
  });

  it("does not forward an unknown mock mode", () => {
    expect(officeFrameUrl("/api", "broken")).toBe("/office-cocos/index.html?apiBaseUrl=%2Fapi");
  });
});
