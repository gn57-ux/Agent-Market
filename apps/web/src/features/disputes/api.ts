import type { ErrorCode } from "@agent-market/domain";
import { apiFetch, ApiError } from "../../shared/api/client.js";

/**
 * `POST /tasks/:taskId/disputes`'s response shape (design.md's interface
 * contract) — the backend computes `evidenceHash` from the submitted
 * `evidenceSummary` (F-1003), shown here verbatim before signing, never
 * recomputed client-side (same "backend computes, frontend signs the
 * returned value" discipline as `deliverables/api.ts`'s
 * `DeliverableSubmissionResult`).
 */
export interface DisputeSubmissionResult {
  disputeId: string;
  evidenceHash: `0x${string}`;
}

export interface SubmitDisputeInput {
  reason: string;
  evidenceSummary: string;
}

export function submitDispute(
  taskId: string,
  input: SubmitDisputeInput,
): Promise<DisputeSubmissionResult> {
  return apiFetch<DisputeSubmissionResult>(`/tasks/${taskId}/disputes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * `GET /tasks/:taskId/disputes`'s response shape — `evidenceSummary`/
 * `evidenceHash` are present ONLY when the backend's `access-guard.ts`
 * (T-1002) grants this session "full" access (the task's requester, its
 * accepted Agent, or a wallet the backend independently verified holds
 * `TaskEscrow.ARBITRATOR_ROLE` on-chain) — absent for every other viewer,
 * never `null`/empty-string. This module never re-derives or second-
 * guesses that decision; it only reads whichever shape the backend
 * actually returned.
 */
export interface DisputeRecord {
  disputeId: string;
  status: "OPEN" | "RESOLVED";
  reason: string;
  resolution: "SUPPORT_AGENT" | "SUPPORT_REQUESTER" | null;
  resolvedAt: string | null;
  evidenceSummary?: string;
  evidenceHash?: `0x${string}`;
}

/** Public read — a 404 ("该任务尚无争议记录") is the routine "no dispute
 * yet" case, surfaced as a thrown `ApiError`, same as
 * `deliverables/api.ts`'s `getLatestDeliverable`; `DisputeSection` is what
 * interprets that specifically rather than treating it as a load failure. */
export function getDispute(taskId: string): Promise<DisputeRecord> {
  return apiFetch<DisputeRecord>(`/tasks/${taskId}/disputes`);
}

/**
 * `POST /tasks/:taskId/dispute-open-verifications` /
 * `POST /tasks/:taskId/dispute-resolve-verifications` (T-1002) — same
 * "2xx still-pending outcome returned as data, only 4xx/409 thrown" shape
 * as `tasks/api.ts`'s `SettlementVerificationResponse`.
 */
export type DisputeOpenVerificationResponse =
  { status: "DISPUTED"; confirmations: number } | { error: { code: ErrorCode; message: string } };

export function submitDisputeOpenVerification(
  taskId: string,
  txHash: `0x${string}`,
): Promise<DisputeOpenVerificationResponse> {
  return apiFetch<DisputeOpenVerificationResponse>(`/tasks/${taskId}/dispute-open-verifications`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export type DisputeResolveVerificationResponse =
  | { status: "RELEASED" | "REFUNDED"; confirmations: number }
  | { error: { code: ErrorCode; message: string } };

export function submitDisputeResolveVerification(
  taskId: string,
  txHash: `0x${string}`,
): Promise<DisputeResolveVerificationResponse> {
  return apiFetch<DisputeResolveVerificationResponse>(
    `/tasks/${taskId}/dispute-resolve-verifications`,
    {
      method: "POST",
      body: JSON.stringify({ txHash }),
    },
  );
}

export { ApiError };
