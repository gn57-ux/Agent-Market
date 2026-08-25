import type { ErrorCode } from "@agent-market/domain";
import { apiFetch, ApiError } from "../../shared/api/client.js";

/**
 * Backend `tasks.status` values (0005_create_tasks.sql's `tasks_status_check`
 * constraint / `schema.ts`'s `listTasksQuerySchema`). Kept as a plain string
 * union here — distinct from `@agent-market/domain`'s `TaskStatus`
 * discriminated union, which carries extra per-status fields (`agent`,
 * `submittedAt`, `reviewDeadline`) that `GET /tasks`'s current response
 * shape (`toTaskDraftJson`, apps/api/src/modules/tasks/routes.ts) does not
 * yet serialize — those fields live in later Features' own tables. See
 * `toTaskStatus` in MyPublishedTasksPage.tsx for the (documented, narrow)
 * adapter between the two.
 */
export type TaskStatusValue =
  | "DRAFT"
  | "AWAITING_FUNDING"
  | "OPEN"
  | "ACCEPTED"
  | "SUBMITTED"
  | "DISPUTED"
  | "RELEASED"
  | "REFUNDED"
  | "CANCELLED";

/** Mirrors apps/api's `toTaskDraftJson` (routes.ts) — the one response shape
 * shared by POST drafts/PATCH draft/GET detail/GET list items. `budget` is a
 * minimal-unit unsigned integer string (F-609) — never `Number()`-coerced
 * here, matching `Agent.referencePrice`'s identical precision reasoning. */
export interface TaskRecord {
  taskId: string;
  requesterAddress: string;
  category: string;
  title: string;
  description: string;
  budget: string;
  token: string;
  deliveryDeadline: string;
  skillTags: string[];
  status: TaskStatusValue;
  fundingTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  /** T-805: mirrors apps/api's `toTaskDraftJson` extension — `null` until
   * the task is accepted (`tasks.accepted_agent_address`/`accepted_at`,
   * written atomically by T-801's OPEN→ACCEPTED transition). */
  acceptedAgentAddress: string | null;
  acceptedAt: string | null;
}

export interface CreateDraftInput {
  category: string;
  skillTags: string[];
  title: string;
  description: string;
  /** Minimal-unit unsigned integer string — the caller (TaskCreatePage) is
   * responsible for converting a user's decimal input via
   * `@agent-market/domain`'s `parseAmount()` before calling this function;
   * this module does not parse or compute amounts itself (F-609). */
  budget: string;
  /** ISO 8601 datetime string. */
  deliveryDeadline: string;
}

export type UpdateDraftInput = Partial<CreateDraftInput>;

export interface CreateDraftResult {
  taskId: string;
  status: TaskStatusValue;
}

/** Response shape for `POST /tasks/:taskId/funding-intent` (design.md's
 * interface contract) — everything `TaskCreatePage` needs to construct the
 * `approve` and `createTask` transactions without recomputing any of it
 * itself (e.g. the on-chain task ID derivation stays server-side). */
export interface FundingIntent {
  contractAddress: `0x${string}`;
  token: `0x${string}`;
  /** Minimal-unit unsigned integer string, same convention as
   * `TaskRecord.budget`. */
  budget: string;
  /** Unix seconds — the unit `TaskEscrow.createTask`'s `uint64
   * deliveryDeadline` parameter expects directly, no conversion needed. */
  deliveryDeadline: number;
  taskIdOnChain: `0x${string}`;
}

/**
 * `POST /tasks/:taskId/funding-verifications` can resolve to one of three
 * outcomes, all delivered as a 2xx HTTP response (routes.ts's
 * `fundingErrorStatus`: 200 for confirmed, 202 Accepted for "still
 * pending"/"RPC unavailable" — F-606 requires these NOT be treated as
 * failures) plus a genuine 4xx/409 for a definitive rejection (which
 * `apiFetch` turns into a thrown `ApiError` instead). Callers (TaskCreatePage's
 * `verify` callback) must check for the `error` field even on a resolved
 * promise — a 202 body is NOT the same shape as the 200 body.
 */
export type FundingVerificationResponse =
  { status: "OPEN"; confirmations: number } | { error: { code: ErrorCode; message: string } };

export interface ListTasksParams {
  requester?: string;
  /** T-805: "我的接单" list — filters `GET /tasks?acceptedBy=`, mirroring
   * `requester` exactly. */
  acceptedBy?: string;
  status?: TaskStatusValue;
  category?: string;
  skillTag?: string;
  page?: number;
  pageSize?: number;
}

export interface ListTasksResult {
  items: TaskRecord[];
  total: number;
  page: number;
  pageSize: number;
}

function toQueryString(params: ListTasksParams): string {
  const search = new URLSearchParams();
  if (params.requester) search.set("requester", params.requester);
  if (params.acceptedBy) search.set("acceptedBy", params.acceptedBy);
  if (params.status) search.set("status", params.status);
  if (params.category) search.set("category", params.category);
  if (params.skillTag) search.set("skillTag", params.skillTag);
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function listTasks(params: ListTasksParams = {}): Promise<ListTasksResult> {
  return apiFetch<ListTasksResult>(`/tasks${toQueryString(params)}`);
}

export function getTask(taskId: string): Promise<TaskRecord> {
  return apiFetch<TaskRecord>(`/tasks/${taskId}`);
}

/**
 * F-601: creates a `DRAFT` task. `idempotencyKey` should be a fresh
 * client-generated value per logical submission (e.g. `crypto.randomUUID()`
 * once per form session) so a retried request after a network blip re-hits
 * the same draft instead of creating a second one — the header is only sent
 * when a key is supplied, matching apps/api's `readIdempotencyKey`
 * treating an absent/blank header as "no idempotency requested."
 */
export function createDraft(
  input: CreateDraftInput,
  idempotencyKey?: string,
): Promise<CreateDraftResult> {
  return apiFetch<CreateDraftResult>("/tasks/drafts", {
    method: "POST",
    body: JSON.stringify(input),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

export function updateDraft(taskId: string, input: UpdateDraftInput): Promise<TaskRecord> {
  return apiFetch<TaskRecord>(`/tasks/${taskId}/draft`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createFundingIntent(taskId: string): Promise<FundingIntent> {
  return apiFetch<FundingIntent>(`/tasks/${taskId}/funding-intent`, { method: "POST" });
}

/**
 * Submits a broadcast `createTask` transaction hash for the backend's
 * independent RPC re-verification (F-604/F-605). Deliberately returns the
 * raw union `FundingVerificationResponse` instead of throwing for the
 * "still pending" outcome — only a genuine 4xx/409 rejection reaches the
 * caller as a thrown `ApiError` (see that type's doc comment); `TaskCreatePage`'s
 * `verify` callback is what interprets both shapes into a `VerifyOutcome`.
 */
export function submitFundingVerification(
  taskId: string,
  txHash: `0x${string}`,
): Promise<FundingVerificationResponse> {
  return apiFetch<FundingVerificationResponse>(`/tasks/${taskId}/funding-verifications`, {
    method: "POST",
    body: JSON.stringify({ txHash }),
  });
}

export { ApiError };
