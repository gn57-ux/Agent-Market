import { formatUnits, parseUnits } from "viem";

// bigint minimal-unit amount (e.g. wei-equivalent for YD Token). This module
// only parses and formats; it does not implement or test any business
// calculation (staking, fees, etc.) — those belong to TaskEscrow (Feature 2).
export type Amount = bigint;

export const DEFAULT_DECIMALS = 18;

/** Parses a human-entered decimal string into a minimal-unit bigint. */
export function parseAmount(value: string, decimals = DEFAULT_DECIMALS): Amount {
  return parseUnits(value, decimals);
}

/** Formats a minimal-unit bigint into a human-readable decimal string. */
export function formatAmount(value: Amount, decimals = DEFAULT_DECIMALS): string {
  return formatUnits(value, decimals);
}
