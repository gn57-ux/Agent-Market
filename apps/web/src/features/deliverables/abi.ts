/**
 * Hand-written minimal ABI fragment for `submitResult` — deliberately NOT
 * imported from `contracts/artifacts/` (Hardhat's gitignored compiled
 * output), matching `tasks/abi.ts`'s identical reasoning.
 *
 * `TaskEscrow.submitResult(bytes32 taskId, bytes32 resultHash)` — copied
 * from `contracts/src/TaskEscrow.sol`'s signature and only changes if
 * that Solidity signature changes.
 */
export const TASK_ESCROW_SUBMIT_RESULT_ABI = [
  {
    type: "function",
    name: "submitResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "resultHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;
