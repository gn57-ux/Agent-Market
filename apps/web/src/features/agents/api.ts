import { apiFetch } from "../../shared/api/client.js";

export type AgentStatus = "ACTIVE" | "INACTIVE";

/** Mirrors apps/api's routes.ts `toAgentSummaryJson` — the one response
 * shape shared by POST/GET list/GET detail/PATCH/activate/deactivate. */
export interface Agent {
  agentId: string;
  ownerAddress: string;
  name: string;
  description: string;
  category: string;
  skillTags: string[];
  authorBio: string | null;
  invocationUrl: string | null;
  payoutAddress: string;
  pricingModel: string | null;
  /** NUMERIC column serialized as a string by `pg` — kept as a string
   * end-to-end rather than `Number()`-coerced, matching apps/api's own
   * precision-preserving choice (routes.ts's doc comment). */
  referencePrice: string | null;
  status: AgentStatus;
  completedTaskCount: number;
  successCount: number;
  overdueCount: number;
  /** `null` means "no real rating yet" (F-506) — never render this as 0 or
   * any other number; every consumer must handle the null branch itself
   * (see AgentMarketPage/AgentDetailPage's "暂无评分" rendering). */
  qualityScore: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  description: string;
  category: string;
  skillTags: string[];
  authorBio?: string;
  invocationUrl?: string;
  payoutAddress: string;
  pricingModel?: string;
  referencePrice?: number;
}

/**
 * `PATCH /agents/:agentId` body. Distinct from `Partial<CreateAgentInput>`
 * in one way, matching apps/api's `updateAgentSchema`: the optional fields
 * also accept an explicit `null` to mean "clear this field," distinct from
 * `undefined` ("don't change it"). AgentForm.ts's `agentFormValuesToInput`
 * is what actually decides which of the three (value / null / omitted) a
 * blank form field becomes.
 */
export interface UpdateAgentInput {
  name?: string;
  description?: string;
  category?: string;
  skillTags?: string[];
  authorBio?: string | null;
  invocationUrl?: string | null;
  payoutAddress?: string;
  pricingModel?: string | null;
  referencePrice?: number | null;
}

export interface ListAgentsParams {
  category?: string;
  skillTag?: string;
  status?: AgentStatus;
  page?: number;
  pageSize?: number;
}

export interface ListAgentsResult {
  items: Agent[];
  total: number;
  page: number;
  pageSize: number;
}

function toQueryString(params: ListAgentsParams): string {
  const search = new URLSearchParams();
  if (params.category) search.set("category", params.category);
  if (params.skillTag) search.set("skillTag", params.skillTag);
  if (params.status) search.set("status", params.status);
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function listAgents(params: ListAgentsParams = {}): Promise<ListAgentsResult> {
  return apiFetch<ListAgentsResult>(`/agents${toQueryString(params)}`);
}

export function getAgent(agentId: string): Promise<Agent> {
  return apiFetch<Agent>(`/agents/${agentId}`);
}

export function createAgent(
  input: CreateAgentInput,
): Promise<
  Pick<Agent, "agentId" | "status" | "createdAt" | "completedTaskCount" | "qualityScore">
> {
  return apiFetch("/agents", { method: "POST", body: JSON.stringify(input) });
}

export function updateAgent(agentId: string, input: UpdateAgentInput): Promise<Agent> {
  return apiFetch<Agent>(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function activateAgent(agentId: string): Promise<Agent> {
  return apiFetch<Agent>(`/agents/${agentId}/activate`, { method: "POST" });
}

export function deactivateAgent(agentId: string): Promise<Agent> {
  return apiFetch<Agent>(`/agents/${agentId}/deactivate`, { method: "POST" });
}
