import { keccak256, toBytes } from "viem";

/**
 * Derives the on-chain `bytes32 taskId` that `TaskEscrow.createTask`
 * (contracts/src/TaskEscrow.sol) expects, from this backend's own
 * `tasks.id` UUID.
 *
 * `createTask`'s `taskId` parameter is caller-supplied, not
 * contract-generated (T-604 capsule's explicit note) — the contract has no
 * opinion on where it comes from, it only requires the same value to be
 * emitted back in `TaskFunded` so this backend can match the event to the
 * draft it verifies against. This module is where that mapping is decided,
 * once, so `funding-intent` (which hands the value to the frontend to
 * build the `createTask` call) and `funding-verifications` (which compares
 * it against the decoded event) always compute the identical bytes32 from
 * the identical UUID without either one needing to persist it.
 *
 * A deterministic pure function of `tasks.id` — not a new stored column —
 * is deliberate: `bytes32 = keccak256(utf8(uuid))` needs no schema change,
 * cannot drift from `tasks.id` (there is nothing to drift; it is
 * recomputed from the same source string every time), and needs no
 * migration/backfill story. The trade-off is that this function must never
 * change its output for a given input once any task has been funded on
 * chain — that's why it's isolated in its own file with its own unit
 * tests, rather than inlined at each call site.
 */
export function deriveOnChainTaskId(taskId: string): `0x${string}` {
  return keccak256(toBytes(taskId));
}
