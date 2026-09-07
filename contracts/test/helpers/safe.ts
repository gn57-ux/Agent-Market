import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ContractTransactionReceipt } from "ethers";
import type { Safe, SafeProxyFactory } from "../../typechain-types";

/**
 * Feature 21 (arbitration-committee) — the ONE place that knows how to
 * deploy a real, unmodified Gnosis Safe on this project's own real local
 * Hardhat network (CLAUDE.md 原则 6). Reused by T-2103 (deployment proof),
 * T-2104 (`ARBITRATOR_ROLE` rotation onto the deployed Safe's address),
 * and T-2105 (a real 2-of-3 multisig `resolveDispute` execution) — none
 * of those Tasks re-implement Safe deployment independently.
 *
 * `saltNonce` defaults to a fresh random value per call so repeated
 * deployments within the same test run (or across Tasks sharing one
 * Hardhat network instance) never collide on `SafeProxyFactory`'s
 * deterministic CREATE2 address derivation.
 */
export async function deployRealSafe(
  owners: string[],
  threshold: number,
  saltNonce: bigint = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
): Promise<Safe> {
  const SafeFactory = await ethers.getContractFactory("Safe");
  const safeSingleton = await SafeFactory.deploy();
  await safeSingleton.waitForDeployment();

  const ProxyFactoryFactory = await ethers.getContractFactory("SafeProxyFactory");
  const proxyFactory = (await ProxyFactoryFactory.deploy()) as unknown as SafeProxyFactory;
  await proxyFactory.waitForDeployment();

  // `setup`'s own real ABI (Safe.sol) — no delegatecall payload, no
  // fallback handler, no payment: the minimal real initialization this
  // Feature needs (F-2113's own scope: a plain N-of-M owner set, nothing
  // Safe's own optional module/payment features are needed for here).
  const setupData = safeSingleton.interface.encodeFunctionData("setup", [
    owners,
    threshold,
    ethers.ZeroAddress,
    "0x",
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);

  const singletonAddress = await safeSingleton.getAddress();
  const tx = await proxyFactory.createProxyWithNonce(singletonAddress, setupData, saltNonce);
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("deployRealSafe: createProxyWithNonce produced no receipt");
  }

  const proxyCreationLog = receipt.logs
    .map((log) => {
      try {
        return proxyFactory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "ProxyCreation");
  if (!proxyCreationLog) {
    throw new Error("deployRealSafe: no real ProxyCreation event found in the receipt");
  }
  const proxyAddress = proxyCreationLog.args[0] as string;

  return (await ethers.getContractAt("Safe", proxyAddress)) as unknown as Safe;
}

/**
 * T-2105 (F-2107): real Safe multisig transaction typed-data — the SAME
 * `SafeTx` struct `Safe.sol`'s own `encodeTransactionData`/`getTransaction
 * Hash` derive their hash from (Safe's own public EIP-712 spec; the
 * domain deliberately has no `name`/`version` fields — that mirrors
 * `Safe.sol`'s own `DOMAIN_SEPARATOR_TYPEHASH`, which only commits to
 * `chainId`/`verifyingContract`, unlike this project's OWN `TaskEscrow`
 * EIP-712 domain).
 */
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Collects REAL EIP-712 signatures from `threshold`-or-more real signers
 * (any two of a real Safe's real owners — F-2107's own 2-of-3 quorum) over
 * a real Safe transaction (here always a plain `CALL`, `operation = 0` —
 * this Feature never needs `DELEGATECALL`), then genuinely executes it via
 * the Safe's own real `execTransaction`. Returns the real transaction
 * receipt AND the real `safeTxHash` the signatures were collected over
 * (F-2114's own `arbitration_decisions.safe_tx_hash` column — a value the
 * real Safe contract itself computed and would recompute identically for
 * anyone re-deriving it from the same on-chain state).
 *
 * `Safe.checkNSignatures` requires signatures ordered by STRICTLY
 * ASCENDING recovered signer address (`Safe.sol`'s own `GS026` check) —
 * signers are sorted here by address before packing, not left to caller
 * ordering.
 */
export async function execRealSafeTransaction(
  safe: Safe,
  signers: HardhatEthersSigner[],
  to: string,
  data: string,
): Promise<{ receipt: ContractTransactionReceipt; safeTxHash: string }> {
  const safeAddress = await safe.getAddress();
  const network = await ethers.provider.getNetwork();
  const nonce = await safe.nonce();

  const safeTx = {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce,
  };

  const domain = { chainId: network.chainId, verifyingContract: safeAddress };
  const safeTxHash = await safe.getTransactionHash(
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    safeTx.nonce,
  );

  const signed = await Promise.all(
    signers.map(async (signer) => ({
      address: await signer.getAddress(),
      signature: await signer.signTypedData(domain, SAFE_TX_TYPES, safeTx),
    })),
  );
  // Real signature-ordering requirement (Safe.sol GS026) — never assume
  // callers already passed `signers` in address order.
  signed.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
  const packedSignatures = ("0x" + signed.map((s) => s.signature.slice(2)).join("")) as string;

  const tx = await safe.execTransaction(
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    packedSignatures,
  );
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("execRealSafeTransaction: execTransaction produced no receipt");
  }
  return { receipt, safeTxHash };
}
