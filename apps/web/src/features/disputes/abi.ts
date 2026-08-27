/**
 * Hand-written minimal ABI fragments for `TaskEscrow.openDispute`/
 * `resolveDispute` — deliberately NOT imported from `contracts/artifacts/`
 * (Hardhat's gitignored compiled output), matching `settlement/abi.ts`'s
 * identical reasoning. Copied from `contracts/src/TaskEscrow.sol`'s
 * signatures and only change if those Solidity signatures change.
 */
export const TASK_ESCROW_OPEN_DISPUTE_ABI = [
  {
    type: "function",
    name: "openDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "disputeEvidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export const TASK_ESCROW_RESOLVE_DISPUTE_ABI = [
  {
    type: "function",
    name: "resolveDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "supportAgent", type: "bool" },
    ],
    outputs: [],
  },
] as const;
