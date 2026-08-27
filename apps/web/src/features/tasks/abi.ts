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

/**
 * `TaskEscrow.STAKE_RATE_BPS` (`uint256 public constant`, currently `600` —
 * 6%) — copied from `contracts/src/TaskEscrow.sol`. `BPS_DENOMINATOR` next to
 * it in the contract is `private`, so it is not readable on-chain; Feature 8
 * (`AcceptanceSection.tsx`) uses the literal `10_000n` for that half of the
 * computation, since it's a generic BPS denominator, not a business rule
 * this Feature owns.
 */
/**
 * `TaskEscrow.acceptTask(AcceptancePermit calldata permit, bytes calldata
 * signature)` — copied from `contracts/src/TaskEscrow.sol`'s `acceptTask`
 * function and its `AcceptancePermit` struct. Field order/types
 * (`taskId bytes32, agent address, nonce uint256, expiry uint256,
 * chainId uint256, verifyingContract address`) must match the struct
 * exactly — `apps/api`'s `permit.service.ts`/`permit.typehash.test.ts` is
 * this project's authoritative reference for that order (T-803 capsule),
 * not a value independently re-derived here.
 */
export const TASK_ESCROW_ACCEPT_TASK_ABI = [
  {
    type: "function",
    name: "acceptTask",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "taskId", type: "bytes32" },
          { name: "agent", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  // T-804: `acceptTask` reverts with this custom error (contracts/src/TaskEscrow.sol,
  // `if (task.status != TaskStatus.OPEN) revert TaskNotOpen(...)`) when a different
  // candidate accepted the task first — the one revert reason this Feature needs viem
  // to be able to decode. `status` is the contract's `TaskStatus` enum, encoded as
  // `uint8`; its concrete value isn't consumed here, only the error's name is.
  {
    type: "error",
    name: "TaskNotOpen",
    inputs: [
      { name: "taskId", type: "bytes32" },
      { name: "status", type: "uint8" },
    ],
  },
] as const;

/** Standard ERC-20 `balanceOf(account) returns (uint256)` — deliberately a
 * separate, exported fragment from `WalletProvider.tsx`'s own private
 * `YD_TOKEN_ABI` (which also declares `balanceOf`, for its unrelated wallet
 * balance display): that ABI is internal to `WalletProvider` and not meant
 * to be imported by feature code, so Feature 8's own real-balance check
 * (T-807) gets its own fragment here instead, matching `ERC20_APPROVE_ABI`'s
 * existing convention of one fragment per call site's needs. */
export const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Standard ERC-20 `allowance(owner, spender) returns (uint256)` — T-807's
 * real on-chain allowance check (`YDToken.allowance(候选钱包, TaskEscrow 地址)`),
 * same convention as `ERC20_APPROVE_ABI`/`ERC20_BALANCE_OF_ABI` above. */
export const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const TASK_ESCROW_STAKE_RATE_BPS_ABI = [
  {
    type: "function",
    name: "STAKE_RATE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
