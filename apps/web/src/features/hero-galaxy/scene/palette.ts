/**
 * PRD §10.1 visual-semantic color table — the single source of truth for
 * "Intent Routing Galaxy" hero animation colors.
 *
 * Every material built under `scene/nodes/*` (this task) and later tasks
 * (T-303's staking ring / settlement color change) must import these
 * constants rather than hardcoding hex values, so the color-to-meaning
 * mapping lives in exactly one place (project rule: 设计知识只能有一个归属).
 *
 * T-302 only visually consumes `cyberBlue`, `amethystPurple`,
 * `explorationPurple`, and `disqualifiedGray`. `stakingOrange` and
 * `settlementGreen` are defined now (full table, per PRD §10.1) but not yet
 * applied to any geometry — that is T-303's job (staking ring, settlement
 * state color change).
 */

/** Hex color values, keyed by their PRD §10.1 semantic meaning. */
export const HERO_GALAXY_PALETTE = {
  /** Cyber Blue — 任务意图、平台路由和链上验证 (task intent, platform routing, on-chain verification). */
  cyberBlue: 0x3ab4ff,
  /** Amethyst Purple — AI Agent、匹配计算和高分候选 (AI Agent, matching computation, high-score candidates). */
  amethystPurple: 0x9b6bff,
  /**
   * 差异化虚线或弱对比紫色 — 新人探索位 (a differentiated dashed line, or a
   * lower-contrast purple variant, for the newcomer/exploration slot). A
   * deliberately desaturated/darker purple than `amethystPurple` so the
   * exploration slot reads as "still purple/Agent-related" but visually
   * de-emphasized relative to the TOP_SCORE candidates.
   */
  explorationPurple: 0x6a4a99,
  /**
   * Orange — 接单质押、截止时间和待确认状态 (staking on acceptance,
   * deadlines, pending-confirmation states). Defined here for T-303 to
   * consume (staking ring visual); not applied by T-302.
   */
  stakingOrange: 0xff9a3c,
  /**
   * Emerald Green — 成果返回、验证成功和资金结算 (result return,
   * verification success, settlement). Defined here for T-303 to consume
   * (settlement state color change); not applied by T-302.
   */
  settlementGreen: 0x2ecc71,
  /** 低亮灰色 — 未通过资格过滤或本轮未入选的 Agent (disqualified / not-selected-this-round Agents). */
  disqualifiedGray: 0x4a4f57,
} as const satisfies Record<string, number>;

export type HeroGalaxyPaletteKey = keyof typeof HERO_GALAXY_PALETTE;
