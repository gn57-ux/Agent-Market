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

function requireHexAddress(env: EnvSource, key: string): HexAddress {
  const value = env[key];
  if (!value || !HEX_ADDRESS_PATTERN.test(value)) {
    throw new Error(
      `chain-config: ${key} must be a 0x-prefixed 40-hex-char address, got: ${value}`,
    );
  }
  return value as HexAddress;
}

/**
 * Resolves the current environment's ChainConfig from an env source
 * (e.g. `process.env` on the backend, or `import.meta.env` on the frontend
 * — this module stays isomorphic by never reading either directly).
 */
export function resolveChainConfig(env: EnvSource): ChainConfig {
  const chainIdRaw = env.CHAIN_ID;
  if (!chainIdRaw) {
    throw new Error("chain-config: CHAIN_ID is required");
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`chain-config: CHAIN_ID must be a positive integer, got: ${chainIdRaw}`);
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
