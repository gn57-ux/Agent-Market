import type { ErrorCode } from "@agent-market/domain";
import { apiFetch, ApiError } from "../../shared/api/client.js";

/** `POST /tasks/:taskId/deliverables`'s response shape (design.md's
 * interface contract) — the ONE place `resultHash` is computed (F-901),
 * shown to the Agent as "即将上链的哈希" before they ever sign anything
 * (F-903: displayed verbatim from this response, never recomputed in the
 * frontend). */
export interface DeliverableSubmissionResult {
  deliverableId: string;
  resultHash: `0x${string}`;
  storedAt: string;
}

/**
 * `GET /tasks/:taskId/deliverables/latest`'s response shape — a
 * discriminated `fileMeta | resultUrl` pair mirroring the backend's own
 * `storageType` CHECK constraint (deliverables/routes.ts, T-904):
 * `fileMeta` present only for a `LOCAL_FILE` submission, `resultUrl` only
 * for a `URL` one, never both. `submittedAt`/`reviewDeadline` stay `null`
 * until T-905's event-sync handler writes them — this is a pure
 * passthrough of whatever `tasks.submitted_at`/`review_deadline` currently
 * hold, this module does not compute or wait for either (F-905/AC-908).
 */
export type DeliverableLatest = {
  deliverableId: string;
  resultHash: `0x${string}`;
  submittedAt: string | null;
  reviewDeadline: string | null;
} & (
  | { fileMeta: { mimeType: string | null; sizeBytes: number | null }; resultUrl?: undefined }
  | { resultUrl: string; fileMeta?: undefined }
);

/**
 * `GET /tasks/:taskId/deliverables/latest` — public (T-904's own doc
 * comment: metadata, not file content, carries the F-908 access
 * restriction). A 404 ("该任务尚无成果提交记录") surfaces as a thrown
 * `ApiError`, same as every other non-2xx response — `SubmissionSection`
 * is what interprets that specifically as "尚无提交" rather than a load
 * failure.
 */
export function getLatestDeliverable(taskId: string): Promise<DeliverableLatest> {
  return apiFetch<DeliverableLatest>(`/tasks/${taskId}/deliverables/latest`);
}

/**
 * `POST /tasks/:taskId/deliverables` (multipart branch) — design.md's
 * "方案 B：文件上传到后端后由后端计算哈希" (F-901): the file is uploaded here
 * FIRST, the backend computes and returns `resultHash`, and only THAT
 * value is ever passed to `submitResult` on-chain — this module never
 * computes a digest itself. Uses a raw `FormData` body (not JSON) —
 * `apiFetch`'s Content-Type default specifically skips `FormData` bodies
 * so the browser can set its own multipart boundary (client.ts, T-908).
 */
export function uploadDeliverableFile(
  taskId: string,
  file: File,
): Promise<DeliverableSubmissionResult> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<DeliverableSubmissionResult>(`/tasks/${taskId}/deliverables`, {
    method: "POST",
    body: formData,
  });
}

/** `POST /tasks/:taskId/deliverables` (URL branch, F-907's https-only
 * restriction enforced backend-side — this module does not duplicate that
 * check, matching `digest.ts`'s "唯一实现来源" principle for the hash
 * itself). */
export function submitDeliverableUrl(
  taskId: string,
  resultUrl: string,
): Promise<DeliverableSubmissionResult> {
  return apiFetch<DeliverableSubmissionResult>(`/tasks/${taskId}/deliverables`, {
    method: "POST",
    body: JSON.stringify({ resultUrl }),
  });
}

/**
 * `POST /tasks/:taskId/result-verifications` (T-905) — mirrors
 * `tasks/api.ts`'s `submitFundingVerification` / `acceptance/api.ts`'s
 * `submitAcceptanceVerification` exactly: a 2xx "still pending" outcome is
 * returned as data, not thrown; only a genuine 4xx/409 rejection becomes a
 * thrown `ApiError`. This is the manual/client-triggered fallback path —
 * T-905's background poller (apps/api) independently syncs the same event
 * even if this call is never made, but calling it lets the UI reflect
 * `SUBMITTED` immediately instead of waiting for the next poll tick.
 */
export type ResultVerificationResponse =
  { status: "SUBMITTED"; confirmations: number } | { error: { code: ErrorCode; message: string } };

export function submitResultVerification(
  taskId: string,
  txHash: `0x${string}`,
): Promise<ResultVerificationResponse> {
  return apiFetch<ResultVerificationResponse>(`/tasks/${taskId}/result-verifications`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export { ApiError };
