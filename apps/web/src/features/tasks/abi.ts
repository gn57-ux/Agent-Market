/**
 * Hand-written minimal ABI fragments for the two contract calls
 * `TaskCreatePage` builds — deliberately NOT imported from
 * `contracts/artifacts/` (Hardhat's gitignored compiled output), matching
 * `apps/api/src/modules/chain/task-funded-event.ts`'s identical reasoning:
 * coupling `apps/web` to build output that only exists after
 * `pnpm --filter @agent-market/contracts compile` has run would make
 * running the frontend without ever having touched the Hardhat project fail
 * with a confusing missing-file error instead of just working.
 */

/** Standard ERC-20 `approve(spender, amount) returns (bool)` — the YD Token
 * deployed at `chainConfig.addresses.ydToken` implements this via
 * OpenZeppelin's ERC20, unchanged from the interface standard. */
export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * `TaskEscrow.createTask(bytes32 taskId, address token, uint256 budget,
 * uint64 deliveryDeadline)` — copied from `contracts/src/TaskEscrow.sol`'s
 * signature (see that file's `createTask` function) and only changes if
 * that Solidity signature changes.
 */
export const TASK_ESCROW_CREATE_TASK_ABI = [
  {
    type: "function",
    name: "createTask",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "budget", type: "uint256" },
      { name: "deliveryDeadline", type: "uint64" },
    ],
    outputs: [],
  },
] as const;
