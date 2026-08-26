import type { ErrorCode } from "@agent-market/domain";
import { apiFetch, ApiError } from "../../shared/api/client.js";

/** Mirrors `GET /tasks/:taskId/my-acceptance-permit`'s response shape
 * (apps/api/src/modules/dispatch/repository.ts's `UnconsumedPermitForWallet`,
 * T-803) — the caller's own unconsumed, unexpired `AcceptancePermit`.
 * `nonce` stays a decimal-string `uint256` (too large for a JS `number`,
 * same convention as `FundingIntent.budget`); `expiry`/`chainId` stay
 * `number` (Unix seconds / EVM chain id, both well under
 * `Number.MAX_SAFE_INTEGER`). */
export interface AcceptancePermitRecord {
  agentId: string;
  taskId: string;
  agentWalletAddress: `0x${string}`;
  nonce: string;
  expiry: number;
  chainId: number;
  verifyingContract: `0x${string}`;
  signature: `0x${string}`;
}

/**
 * `GET /tasks/:taskId/agents/:agentId/acceptance-permit` (T-806, replacing
 * T-803's `GET /tasks/:taskId/my-acceptance-permit`): session-authenticated,
 * any signed-in user may call it for an `agentId` they in fact own — not
 * requester-only. `AcceptanceSection` now resolves and remembers WHICH
 * recommended `agentId` matched the signed-in wallet (T-807), so this call
 * is indexed by that explicit `agentId` rather than an implicit "my"
 * permit. A 404 (no usable permit — expired, consumed, or never issued)
 * surfaces as a thrown `ApiError` via `apiFetch`, same as every other
 * non-2xx response; `AcceptConfirmContent` is what interprets that 404 into
 * AC-804's "已过期或不可用" state.
 */
export function getAcceptancePermitForAgent(
  taskId: string,
  agentId: string,
): Promise<AcceptancePermitRecord> {
  return apiFetch<AcceptancePermitRecord>(`/tasks/${taskId}/agents/${agentId}/acceptance-permit`);
}

/**
 * `POST /tasks/:taskId/acceptance-verifications` (T-801) — mirrors
 * `tasks/api.ts`'s `submitFundingVerification` exactly: a 2xx "still
 * pending" outcome (202, TRANSACTION_NOT_CONFIRMED /
 * RPC_TEMPORARILY_UNAVAILABLE) is returned as data, not thrown; only a
 * genuine 4xx/409 rejection becomes a thrown `ApiError`.
 */
export type AcceptanceVerificationResponse =
  { status: "ACCEPTED"; confirmations: number } | { error: { code: ErrorCode; message: string } };

export function submitAcceptanceVerification(
  taskId: string,
  txHash: `0x${string}`,
): Promise<AcceptanceVerificationResponse> {
  return apiFetch<AcceptanceVerificationResponse>(`/tasks/${taskId}/acceptance-verifications`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export { ApiError };
