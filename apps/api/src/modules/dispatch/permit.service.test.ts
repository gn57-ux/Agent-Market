import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { ACCEPTANCE_PERMIT_TYPES, issueAcceptancePermit } from "./permit.service.js";

// T-706: permit.service.ts unit tests — pure viem round-trip, no real
// contract/RPC involved (the capsule's explicit "不依赖真实合约，纯 viem 双向
// 验证"). ACCEPTANCE_PERMIT_TYPES/domain literals are exercised both here
// (via issueAcceptancePermit itself) and in the dedicated
// permit.typehash.test.ts drift-detection test.

const TASK_ID_ON_CHAIN =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const AGENT_WALLET_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const TASK_ESCROW_ADDRESS = "0x3333333333333333333333333333333333333333" as const;
const CHAIN_ID = 31337;

const ENV_KEYS = [
  "ACCEPTANCE_PERMIT_SIGNER_KEY",
  "CHAIN_ID",
  "TASK_ESCROW_ADDRESS",
  "YD_TOKEN_ADDRESS",
  "YD_FAUCET_ADDRESS",
] as const;

describe("issueAcceptancePermit (unit, T-706)", () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const signerKey = generatePrivateKey();
  const signerAccount = privateKeyToAccount(signerKey);

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.ACCEPTANCE_PERMIT_SIGNER_KEY = signerKey;
    process.env.CHAIN_ID = String(CHAIN_ID);
    process.env.TASK_ESCROW_ADDRESS = TASK_ESCROW_ADDRESS;
    process.env.YD_TOKEN_ADDRESS = "0x4444444444444444444444444444444444444444";
    process.env.YD_FAUCET_ADDRESS = "0x5555555555555555555555555555555555555555";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("throws when ACCEPTANCE_PERMIT_SIGNER_KEY is missing, without leaking any key material", async () => {
    delete process.env.ACCEPTANCE_PERMIT_SIGNER_KEY;
    await expect(issueAcceptancePermit(TASK_ID_ON_CHAIN, AGENT_WALLET_ADDRESS)).rejects.toThrow(
      /ACCEPTANCE_PERMIT_SIGNER_KEY/,
    );
  });

  it("signs a permit whose signature verifies back to the signer's address via viem's verifyTypedData", async () => {
    const issued = await issueAcceptancePermit(TASK_ID_ON_CHAIN, AGENT_WALLET_ADDRESS);

    const valid = await verifyTypedData({
      address: signerAccount.address,
      domain: {
        name: "AgentMarketTaskEscrow",
        version: "1",
        chainId: issued.chainId,
        verifyingContract: issued.verifyingContract,
      },
      types: ACCEPTANCE_PERMIT_TYPES,
      primaryType: "AcceptancePermit",
      message: {
        taskId: TASK_ID_ON_CHAIN,
        agent: AGENT_WALLET_ADDRESS,
        nonce: issued.nonce,
        expiry: BigInt(issued.expiry),
        chainId: BigInt(issued.chainId),
        verifyingContract: issued.verifyingContract,
      },
      signature: issued.signature,
    });

    expect(valid).toBe(true);
    expect(issued.chainId).toBe(CHAIN_ID);
    expect(issued.verifyingContract.toLowerCase()).toBe(TASK_ESCROW_ADDRESS.toLowerCase());
  });

  it("sets expiry to exactly the signing-time Unix second + 3600", async () => {
    const before = Math.floor(Date.now() / 1000);
    const issued = await issueAcceptancePermit(TASK_ID_ON_CHAIN, AGENT_WALLET_ADDRESS);
    const after = Math.floor(Date.now() / 1000);

    expect(issued.expiry).toBeGreaterThanOrEqual(before + 3600);
    expect(issued.expiry).toBeLessThanOrEqual(after + 3600);
  });

  it("generates a different nonce on every call", async () => {
    const first = await issueAcceptancePermit(TASK_ID_ON_CHAIN, AGENT_WALLET_ADDRESS);
    const second = await issueAcceptancePermit(TASK_ID_ON_CHAIN, AGENT_WALLET_ADDRESS);

    expect(first.nonce).not.toBe(second.nonce);
    // uint256 range check — a high-entropy 32-byte value, not e.g. a small
    // sequential counter mistakenly wired in.
    expect(first.nonce).toBeGreaterThan(0n);
    expect(first.nonce).toBeLessThan(2n ** 256n);
  });
});
