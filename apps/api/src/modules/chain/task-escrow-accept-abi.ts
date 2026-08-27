/**
 * Hand-written minimal ABI fragments for `TaskEscrow.acceptTask` and
 * `TaskEscrow.STAKE_RATE_BPS` — the backend-side counterpart of
 * `apps/web/src/features/tasks/abi.ts`'s `TASK_ESCROW_ACCEPT_TASK_ABI` /
 * `TASK_ESCROW_STAKE_RATE_BPS_ABI`. Deliberately NOT imported from
 * `contracts/artifacts/` (gitignored Hardhat build output) — same reasoning
 * as this module's sibling files (`task-accepted-event.ts`,
 * `task-funded-event.ts`): coupling either app to build output that only
 * exists after `pnpm --filter @agent-market/contracts compile` has run
 * would make running either app without ever having touched the Hardhat
 * project fail with a confusing missing-file error.
 *
 * These two constants are each app's OWN independently-maintained copy of
 * the same contract interface (frontend and backend each need it for their
 * own unrelated purpose — the frontend to ENCODE a call for the wallet to
 * sign and submit, the backend to DECODE calldata it independently reads
 * back and to READ a view function) — not a shared package extracted for
 * this. `apps/web`'s copy is this project's authoritative reference for
 * field order/types (T-803 capsule's precedent for `acceptTask`'s ABI);
 * this file must be kept in exact field-for-field agreement with it, and
 * ultimately both must agree with `contracts/src/TaskEscrow.sol`'s actual
 * `acceptTask`/`AcceptancePermit`/`STAKE_RATE_BPS` declarations, the source
 * of truth for all copies.
 */

/**
 * `TaskEscrow.acceptTask(AcceptancePermit calldata permit, bytes calldata
 * signature)` — used here only to DECODE a real on-chain transaction's
 * calldata (`decodeFunctionData`, acceptance-tx-verifier.ts), never to
 * build/send a call (this backend never submits transactions). Field order
 * (`taskId bytes32, agent address, nonce uint256, expiry uint256, chainId
 * uint256, verifyingContract address`) must match
 * `apps/web/src/features/tasks/abi.ts`'s `TASK_ESCROW_ACCEPT_TASK_ABI`
 * exactly, field for field.
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
] as const;

/**
 * `TaskEscrow.STAKE_RATE_BPS` (`uint256 public constant`, currently `600` —
 * 6%, contracts/src/TaskEscrow.sol) — read here via `publicClient.readContract`
 * for the backend's own independent stake verification (T-806, user's item
 * #6). `BPS_DENOMINATOR` next to it in the contract is `private` and not
 * readable on-chain; `acceptance-tx-verifier.ts` uses the literal `10_000n`
 * for that half of the computation, matching `apps/web`'s already-confirmed
 * identical reasoning (see that file's header comment) — it's a generic BPS
 * denominator, not a business rule this Feature owns.
 */
export const TASK_ESCROW_STAKE_RATE_BPS_ABI = [
  {
    type: "function",
    name: "STAKE_RATE_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
