import { z } from "zod";

const taskStatusSchema = z.enum([
  "DRAFT",
  "AWAITING_FUNDING",
  "OPEN",
  "ACCEPTED",
  "SUBMITTED",
  "DISPUTED",
  "RELEASED",
  "REFUNDED",
  "CANCELLED",
]);

const taskSummarySchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  status: taskStatusSchema,
  budget: z.string().regex(/^\d+$/),
  deliveryDeadline: z.string().datetime(),
});

export const officeSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  viewer: z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/) }),
  agents: z.array(
    z.object({
      agentId: z.string().uuid(),
      name: z.string(),
      category: z.string(),
      skillTags: z.array(z.string()),
      status: z.enum(["ACTIVE", "INACTIVE"]),
      completionRate: z.number().min(0).max(1).nullable(),
      qualityScore: z.number().nullable(),
    }),
  ),
  taskBoard: z.object({
    published: z.array(taskSummarySchema),
    accepted: z.array(taskSummarySchema),
  }),
  funds: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("available"),
      tokenSymbol: z.literal("YD"),
      decimals: z.literal(18),
      walletBalance: z.string().regex(/^\d+$/),
      lockedBudget: z.string().regex(/^\d+$/),
      agentStake: z.string().regex(/^\d+$/),
      pendingSettlement: z.string().regex(/^\d+$/),
      observedBlockNumber: z.string().regex(/^\d+$/),
    }),
    z.object({
      kind: z.literal("unavailable"),
      reason: z.enum(["RPC_UNAVAILABLE", "CHAIN_CONFIG_INVALID"]),
    }),
  ]),
  deliveryDesk: z.array(
    taskSummarySchema.extend({
      submittedAt: z.string().datetime().nullable(),
      reviewDeadline: z.string().datetime().nullable(),
      disputeStatus: z.enum(["NONE", "OPEN", "RESOLVED"]),
    }),
  ),
  achievements: z.object({
    completedTaskCount: z.number().int().nonnegative(),
    averageRating: z.number().nullable(),
    qualityScore: z.number().nullable(),
    overdueCount: z.number().int().nonnegative(),
    recentCompletedTasks: z.array(taskSummarySchema),
  }),
});

export type OfficeSnapshot = z.infer<typeof officeSnapshotSchema>;
export type OfficeTaskSummary = z.infer<typeof taskSummarySchema>;
