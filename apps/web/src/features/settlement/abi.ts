/**
 * Hand-written minimal ABI fragments for `TaskEscrow`'s three settlement
 * entry points — deliberately NOT imported from `contracts/artifacts/`
 * (Hardhat's gitignored compiled output), matching `deliverables/abi.ts`'s
 * identical reasoning. Copied from `contracts/src/TaskEscrow.sol`'s
 * signatures and only changes if those Solidity signatures change. All
 * three take only `taskId` — no other arguments, no signature/permit
 * needed (unlike `acceptTask`) — so one combined ABI array covers every
 * settlement transaction `SettlementSection.tsx` builds.
 */
export const TASK_ESCROW_SETTLEMENT_ABI = [
  {
    type: "function",
    name: "approveResult",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimDeliveryTimeout",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeReviewTimeout",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [],
  },
] as const;
