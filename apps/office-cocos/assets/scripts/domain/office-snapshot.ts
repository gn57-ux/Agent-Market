export type OfficeTaskStatus =
  | "DRAFT"
  | "AWAITING_FUNDING"
  | "OPEN"
  | "ACCEPTED"
  | "SUBMITTED"
  | "DISPUTED"
  | "RELEASED"
  | "REFUNDED"
  | "CANCELLED";

export interface OfficeAgent {
  readonly agentId: string;
  readonly name: string;
  readonly category: string;
  readonly skillTags: readonly string[];
  readonly status: "ACTIVE" | "INACTIVE";
  readonly completionRate: number | null;
  readonly qualityScore: number | null;
}

export interface OfficeTaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: OfficeTaskStatus;
  readonly budget: string;
  readonly deliveryDeadline: string;
}

export interface OfficeDelivery extends OfficeTaskSummary {
  readonly submittedAt: string | null;
  readonly reviewDeadline: string | null;
  readonly disputeStatus: "NONE" | "OPEN" | "RESOLVED";
}

export type FundsSnapshot =
  | {
      readonly kind: "available";
      readonly tokenSymbol: "YD";
      readonly decimals: 18;
      readonly walletBalance: string;
      readonly lockedBudget: string;
      readonly agentStake: string;
      readonly pendingSettlement: string;
      readonly observedBlockNumber: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "RPC_UNAVAILABLE" | "CHAIN_CONFIG_INVALID";
    };

export interface OfficeSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly viewer: { readonly address: string };
  readonly agents: readonly OfficeAgent[];
  readonly taskBoard: {
    readonly published: readonly OfficeTaskSummary[];
    readonly accepted: readonly OfficeTaskSummary[];
  };
  readonly funds: FundsSnapshot;
  readonly deliveryDesk: readonly OfficeDelivery[];
  readonly achievements: {
    readonly completedTaskCount: number;
    readonly averageRating: number | null;
    readonly qualityScore: number | null;
    readonly overdueCount: number;
    readonly recentCompletedTasks: readonly OfficeTaskSummary[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOfficeTaskStatus(value: unknown): value is OfficeTaskStatus {
  switch (value) {
    case "DRAFT":
    case "AWAITING_FUNDING":
    case "OPEN":
    case "ACCEPTED":
    case "SUBMITTED":
    case "DISPUTED":
    case "RELEASED":
    case "REFUNDED":
    case "CANCELLED":
      return true;
    default:
      return false;
  }
}

function isOfficeTaskSummary(value: unknown): value is OfficeTaskSummary {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    isOfficeTaskStatus(value.status) &&
    typeof value.budget === "string" &&
    typeof value.deliveryDeadline === "string"
  );
}

function isOfficeAgent(value: unknown): value is OfficeAgent {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.name === "string" &&
    typeof value.category === "string" &&
    isStringArray(value.skillTags) &&
    (value.status === "ACTIVE" || value.status === "INACTIVE") &&
    isNullableNumber(value.completionRate) &&
    isNullableNumber(value.qualityScore)
  );
}

function isOfficeDelivery(value: unknown): value is OfficeDelivery {
  return (
    isOfficeTaskSummary(value) &&
    (value.submittedAt === null || typeof value.submittedAt === "string") &&
    (value.reviewDeadline === null || typeof value.reviewDeadline === "string") &&
    (value.disputeStatus === "NONE" ||
      value.disputeStatus === "OPEN" ||
      value.disputeStatus === "RESOLVED")
  );
}

function isFundsSnapshot(value: unknown): value is FundsSnapshot {
  if (!isRecord(value)) return false;
  if (value.kind === "unavailable") {
    return value.reason === "RPC_UNAVAILABLE" || value.reason === "CHAIN_CONFIG_INVALID";
  }
  return (
    value.kind === "available" &&
    value.tokenSymbol === "YD" &&
    value.decimals === 18 &&
    typeof value.walletBalance === "string" &&
    typeof value.lockedBudget === "string" &&
    typeof value.agentStake === "string" &&
    typeof value.pendingSettlement === "string" &&
    typeof value.observedBlockNumber === "string"
  );
}

export function isOfficeSnapshot(value: unknown): value is OfficeSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.generatedAt !== "string") return false;
  if (!isRecord(value.viewer) || typeof value.viewer.address !== "string") return false;
  if (!Array.isArray(value.agents) || !value.agents.every(isOfficeAgent)) return false;
  if (!isRecord(value.taskBoard)) return false;
  if (
    !Array.isArray(value.taskBoard.published) ||
    !value.taskBoard.published.every(isOfficeTaskSummary) ||
    !Array.isArray(value.taskBoard.accepted) ||
    !value.taskBoard.accepted.every(isOfficeTaskSummary)
  ) {
    return false;
  }
  if (!isFundsSnapshot(value.funds)) return false;
  if (!Array.isArray(value.deliveryDesk) || !value.deliveryDesk.every(isOfficeDelivery)) {
    return false;
  }
  if (!isRecord(value.achievements)) return false;
  return (
    typeof value.achievements.completedTaskCount === "number" &&
    isNullableNumber(value.achievements.averageRating) &&
    isNullableNumber(value.achievements.qualityScore) &&
    typeof value.achievements.overdueCount === "number" &&
    Array.isArray(value.achievements.recentCompletedTasks) &&
    value.achievements.recentCompletedTasks.every(isOfficeTaskSummary)
  );
}
