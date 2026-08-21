import { describe, expect, it } from "vitest";
import { KNOWN_CHAINS, resolveChainConfig } from "../src/chain-config.js";

const LOCAL_ENV = {
  CHAIN_ID: "31337",
  TASK_ESCROW_ADDRESS: "0x111111111111111111111111111111111111111a",
  YD_TOKEN_ADDRESS: "0x222222222222222222222222222222222222222b",
  YD_FAUCET_ADDRESS: "0x333333333333333333333333333333333333333c",
};

const TESTNET_ENV = {
  CHAIN_ID: "11155111",
  TASK_ESCROW_ADDRESS: "0x444444444444444444444444444444444444444d",
  YD_TOKEN_ADDRESS: "0x555555555555555555555555555555555555555e",
  YD_FAUCET_ADDRESS: "0x666666666666666666666666666666666666666f",
};

describe("resolveChainConfig", () => {
  it("resolves a complete config with all three contract addresses for each configured chainId", () => {
    for (const env of [LOCAL_ENV, TESTNET_ENV]) {
      const config = resolveChainConfig(env);
      expect(config.chainId).toBe(Number(env.CHAIN_ID));
      expect(config.addresses.taskEscrow).toBe(env.TASK_ESCROW_ADDRESS);
      expect(config.addresses.ydToken).toBe(env.YD_TOKEN_ADDRESS);
      expect(config.addresses.ydFaucet).toBe(env.YD_FAUCET_ADDRESS);
      expect(config.name).toBeTruthy();
    }
  });

  it("attaches known metadata (name, explorer template) for recognized chainIds", () => {
    const local = resolveChainConfig(LOCAL_ENV);
    expect(local.name).toBe("Local Hardhat");
    expect(local.explorerUrlTemplate).toBeUndefined();

    const testnet = resolveChainConfig(TESTNET_ENV);
    expect(testnet.name).toBe("Sepolia");
    expect(testnet.explorerUrlTemplate).toContain("sepolia.etherscan.io");
  });

  it("falls back to a generic name for an unrecognized chainId", () => {
    const config = resolveChainConfig({ ...LOCAL_ENV, CHAIN_ID: "999999" });
    expect(config.name).toBe("Chain 999999");
  });

  it("rejects missing CHAIN_ID", () => {
    expect(() => resolveChainConfig({})).toThrow(/CHAIN_ID is required/);
  });

  it("rejects a malformed contract address", () => {
    expect(() =>
      resolveChainConfig({ ...LOCAL_ENV, TASK_ESCROW_ADDRESS: "not-an-address" }),
    ).toThrow(/TASK_ESCROW_ADDRESS/);
  });

  it("KNOWN_CHAINS lists at least Local Hardhat and Sepolia", () => {
    expect(KNOWN_CHAINS[31337]?.name).toBe("Local Hardhat");
    expect(KNOWN_CHAINS[11155111]?.name).toBe("Sepolia");
  });
});
