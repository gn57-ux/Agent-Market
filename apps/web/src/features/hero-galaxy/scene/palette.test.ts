import { describe, expect, it } from "vitest";
import { HERO_GALAXY_PALETTE } from "./palette.js";

describe("HERO_GALAXY_PALETTE", () => {
  it("defines all six PRD §10.1 visual-semantic color entries", () => {
    expect(Object.keys(HERO_GALAXY_PALETTE).sort()).toEqual(
      [
        "amethystPurple",
        "cyberBlue",
        "disqualifiedGray",
        "explorationPurple",
        "settlementGreen",
        "stakingOrange",
      ].sort(),
    );
  });

  it("is a valid 24-bit hex color for every entry", () => {
    for (const [key, value] of Object.entries(HERO_GALAXY_PALETTE)) {
      expect(Number.isInteger(value), `${key} should be an integer hex value`).toBe(true);
      expect(value, `${key} should be within 0x000000..0xffffff`).toBeGreaterThanOrEqual(0);
      expect(value, `${key} should be within 0x000000..0xffffff`).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("assigns every semantic entry a distinct color", () => {
    const values = Object.values(HERO_GALAXY_PALETTE);
    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps the exploration purple distinguishable from the primary amethyst purple", () => {
    // The PRD calls for a "differentiated dashed or lower-contrast purple
    // variant" for the exploration slot — it must read as visually distinct
    // from the primary Amethyst Purple used for eligible/high-score Agents,
    // not merely a different variable holding the same color.
    expect(HERO_GALAXY_PALETTE.explorationPurple).not.toBe(HERO_GALAXY_PALETTE.amethystPurple);
  });
});
