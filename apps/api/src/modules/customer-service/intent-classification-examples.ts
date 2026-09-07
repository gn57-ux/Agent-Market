import type { IntentCategory } from "./intent-classifier.js";

/**
 * F-2201/T-2201: a small, real, hand-written evaluation set spanning all
 * four closed intent categories — the first real data `F-2209`'s eventual
 * evaluation-set Task will grow. Exported (not inlined into one test file)
 * so T-2207 can import and extend this same set rather than re-authoring
 * examples from scratch. Every question here is a real, plausible thing an
 * Agent Market user would actually ask (or a genuinely off-topic question),
 * not a synthetic placeholder string.
 */
export interface IntentClassificationExample {
  question: string;
  expectedIntent: IntentCategory;
}

export const INTENT_CLASSIFICATION_EXAMPLES: readonly IntentClassificationExample[] = [
  { question: "怎么发布一个任务？", expectedIntent: "PLATFORM_USAGE" },
  { question: "我作为 Agent 怎么接单？需要先质押吗？", expectedIntent: "PLATFORM_USAGE" },
  { question: "钱包怎么绑定到平台账号？", expectedIntent: "PLATFORM_USAGE" },
  // N4 real finding (round 2, T-2202, P1): this exact question reliably
  // classified UNHANDLED before the prompt's PLATFORM_USAGE definition
  // was broadened to cover rule/FAQ-shaped questions, not just
  // action-shaped ones — kept here as a permanent regression example.
  { question: "验收窗口一般是多久？", expectedIntent: "PLATFORM_USAGE" },
  { question: "Agent接单的质押比例是多少？", expectedIntent: "PLATFORM_USAGE" },
  { question: "我的任务为什么还没匹配到 Agent？", expectedIntent: "TASK_STATUS" },
  { question: "我发布的任务现在是什么状态，接单了吗？", expectedIntent: "TASK_STATUS" },
  { question: "对方交付的东西不合格，我该怎么办？", expectedIntent: "DISPUTE_PROCESS" },
  { question: "任务完成了但对方一直不验收，可以申请仲裁吗？", expectedIntent: "DISPUTE_PROCESS" },
  { question: "争议流程大概要多久才能有结果？", expectedIntent: "DISPUTE_PROCESS" },
  { question: "我要买比特币，有什么推荐的交易所吗？", expectedIntent: "UNHANDLED" },
  { question: "今天天气怎么样，适合出门吗？", expectedIntent: "UNHANDLED" },
];
