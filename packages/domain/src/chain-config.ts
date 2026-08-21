// Centralized chain configuration. Contract addresses only exist once a
// network has a real deployment, so they are resolved from environment
// variables here (the one place that knows the variable names) rather than
// hardcoded — but network *identity* (name, explorer URL template) for
// networks this project targets is static and safe to list directly.

export type HexAddress = `0x${string}`;

export interface ChainAddresses {
  taskEscrow: HexAddress;
  ydToken: HexAddress;
  ydFaucet: HexAddress;
}

export interface ChainMetadata {
  name: string;
  explorerUrlTemplate?: string; // e.g. "https://sepolia.etherscan.io/tx/{txHash}"
}

export interface ChainConfig extends ChainMetadata {
  chainId: number;
  addresses: ChainAddresses;
}

/** Known networks this project targets. Addresses are NOT part of this
 * table — they vary per deployment and are resolved separately. */
export const KNOWN_CHAINS: Record<number, ChainMetadata> = {
  31337: { name: "Local Hardhat" },
  11155111: {
    name: "Sepolia",
    explorerUrlTemplate: "https://sepolia.etherscan.io/tx/{txHash}",
  },
};

export interface EnvSource {
  [key: string]: string | undefined;
}

const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function requireHexAddress(env: EnvSource, key: string): HexAddress {
  const value = env[key];
  if (!value || !HEX_ADDRESS_PATTERN.test(value)) {
    throw new Error(
      `chain-config: ${key} must be a 0x-prefixed 40-hex-char address, got: ${value}`,
    );
  }
  if (value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      `chain-config: ${key} is the zero address (undeployed placeholder from .env.example) — set a real deployed address`,
    );
  }
  return value as HexAddress;
}

/**
 * Resolves a ChainConfig from a normalized env record. This module reads
 * exactly the keys `CHAIN_ID`, `TASK_ESCROW_ADDRESS`, `YD_TOKEN_ADDRESS`,
 * `YD_FAUCET_ADDRESS` — it does NOT know about runtime-specific prefixes
 * (e.g. Vite's `VITE_*`). Callers on the frontend must map their own env
 * source (`import.meta.env.VITE_CHAIN_ID`, etc.) into this shape before
 * calling; passing `import.meta.env` directly will not work as-is.
 */
export function resolveChainConfig(env: EnvSource): ChainConfig {
  const chainIdRaw = env.CHAIN_ID;
  if (!chainIdRaw) {
    throw new Error("chain-config: CHAIN_ID is required");
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`chain-config: CHAIN_ID must be a positive safe integer, got: ${chainIdRaw}`);
  }

  const metadata: ChainMetadata = KNOWN_CHAINS[chainId] ?? { name: `Chain ${chainId}` };

  return {
    chainId,
    ...metadata,
    addresses: {
      taskEscrow: requireHexAddress(env, "TASK_ESCROW_ADDRESS"),
      ydToken: requireHexAddress(env, "YD_TOKEN_ADDRESS"),
      ydFaucet: requireHexAddress(env, "YD_FAUCET_ADDRESS"),
    },
  };
}
