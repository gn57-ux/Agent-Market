import { z } from "zod";

export const riskHoldAgentParamsSchema = z.object({ agentId: z.string().uuid() });

/** `reason` is required — the user's own "保留审计记录" requirement means a
 * release with no stated reason would be an audit trail with a hole in
 * it. */
export const releaseRiskHoldSchema = z.object({
  reason: z.string().min(1).max(5_000),
});
