import { INTENT_CLASSIFICATION_EXAMPLES } from "./intent-classification-examples.js";
import type { IntentCategory } from "./intent-classifier.js";

/**
 * F-2209/T-2207 (AC-2201): the real evaluation set used to MEASURE (not
 * assume) two real metrics — intent classification accuracy and "知识库引用
 * 支撑" (citation-support) rate — by actually running `classifyIntent`/
 * `generateAnswer` against every item here (see
 * `../../scripts/run-customer-service-evaluation.ts`).
 *
 * Extends (does not duplicate) T-2201's own
 * `INTENT_CLASSIFICATION_EXAMPLES` — those 12 real hand-written examples are
 * reused verbatim below via `deriveExpectedGrounded`, plus new items added
 * specifically so EVERY one of T-2200's 11 real seeded `kb_articles` rows
 * (`../../scripts/seed-kb-articles.ts`'s `KB_ARTICLE_SEEDS`) has at least
 * one real question a real user would plausibly ask that should be
 * answerable/citable from that specific article — the point being to prove
 * each article is actually reachable via real retrieval, not just a few of
 * them.
 *
 * N6 review disclosure (honesty note, not a defect fix — AC-2201's own
 * "不是构造的理想化数据" requirement makes this worth stating explicitly):
 * 2 of these 23 items — "验收窗口一般是多久？" and "Agent接单的质押比例是多少？"
 * — were the CONCRETE failing examples that drove intent-classifier.ts's own
 * prompt rewrite during T-2202's N4 round-2 fix (the PLATFORM_USAGE/
 * DISPUTE_PROCESS boundary was broadened specifically because these two
 * questions were misclassifying). Their inclusion here is legitimate
 * regression coverage (the prompt fix must keep working), but their
 * classification-accuracy contribution is NOT a held-out measurement the
 * way the other 21 items are — the prompt was iterated directly against
 * them. Every metric this evaluation set produces is still a REAL,
 * freshly-executed measurement of current behavior (never cached/
 * precomputed), and 21/23 items were never used to tune anything; this
 * note exists so a reader doesn't mistake the aggregate accuracy number for
 * a fully held-out evaluation.
 */
export interface EvaluationItem {
  /** A real, natural-sounding question a real Agent Market user would ask —
   * never synthetic placeholder text. */
  question: string;
  expectedIntent: IntentCategory;
  /**
   * Whether `generateAnswer(pool, question, null)` is expected to come back
   * REAL-KB-GROUNDED — `escalate === false` AND `citedKbArticleIds.length >
   * 0` — rather than escalate. `false` covers two genuinely different real
   * cases, both of which are legitimate "should NOT get a grounded answer"
   * outcomes for AC-2201/AC-2202's purposes:
   *   (a) genuinely off-topic/UNHANDLED questions (nothing in the KB could
   *       ever answer them), and
   *   (b) real, on-topic questions the KB genuinely does not have a
   *       concrete answer for (a real KB gap) — e.g. `answer-generator.
   *       integration.test.ts`'s own T-2202 finding that "验收窗口一般是多久"
   *       classifies PLATFORM_USAGE correctly but the seeded KB article only
   *       ever states the FORMULA (reviewDeadline = 提交时间 + reviewWindow),
   *       never a concrete day count, so the real model correctly and
   *       deterministically answers `answerable: false` — F-2207 working AS
   *       INTENDED, not a defect. The parallel case exists for arbitration
   *       duration below.
   * Evaluated only via `generateAnswer` using an ANONYMOUS caller
   * (`actorAddress: null`) — this evaluation set measures the general
   * KB-grounded-QA path, not T-2203's personalized `TASK_STATUS` branch
   * (which never touches the KB at all and has its own dedicated real
   * integration coverage in `../../scripts/answer-generator.integration.
   * test.ts`).
   */
  expectedGrounded: boolean;
}

/**
 * The 12 reused classification examples don't carry an `expectedGrounded`
 * label of their own (T-2201 only needed classification, not citation
 * measurement) — this Task adds that label per item, based on whether the
 * KB genuinely has a concrete, citable answer to each question (verified by
 * reading `seed-kb-articles.ts`'s real `KB_ARTICLE_SEEDS` content, and — for
 * the two ambiguous "多久" duration questions — by the real finding already
 * documented in `../../scripts/answer-generator.integration.test.ts`).
 */
const REUSED_CLASSIFICATION_ITEMS: EvaluationItem[] = INTENT_CLASSIFICATION_EXAMPLES.map(
  (example) => {
    const expectedGrounded = ((): boolean => {
      switch (example.question) {
        case "怎么发布一个任务？":
          // KB: "任务创建与预算锁定流程".
          return true;
        case "我作为 Agent 怎么接单？需要先质押吗？":
        case "Agent接单的质押比例是多少？":
          // KB: "Agent 接单与质押规则" — the 600bps/6% figure is concrete.
          // `Agent接单的质押比例是多少？` is manually verified 3/3 real runs
          // (see answer-generator.integration.test.ts).
          return true;
        case "验收窗口一般是多久？":
        case "争议流程大概要多久才能有结果？":
          // Real KB gap: both seeded articles ("验收窗口与正常验收流程",
          // "争议与仲裁流程") state the MECHANISM but never a concrete
          // duration number — the real model correctly refuses to invent
          // one (see this file's doc comment above).
          return false;
        case "钱包怎么绑定到平台账号？":
          // No seeded KB article actually describes a "wallet binding"
          // step (the platform's real auth model is SIWE-style
          // sign-in, not a separate binding flow the PRD excerpts this
          // KB was built from describe) — a genuine KB gap, expected to
          // escalate honestly rather than have the model guess.
          return false;
        case "我的任务为什么还没匹配到 Agent？":
        case "我发布的任务现在是什么状态，接单了吗？":
          // Personal/individual task-state questions — with the
          // anonymous (`actorAddress: null`) caller this evaluation set
          // uses, there is no personal task row to answer from, and the
          // general "Agent 推荐与撮合流程" KB article describes the
          // MECHANISM, not any specific task's real state, so a faithful
          // model should not claim to answer "my task" from it.
          return false;
        case "对方交付的东西不合格，我该怎么办？":
        case "任务完成了但对方一直不验收，可以申请仲裁吗？":
          // KB: "争议与仲裁流程" describes exactly this action (submit a
          // dispute with reason + evidence summary during the review
          // window).
          return true;
        case "我要买比特币，有什么推荐的交易所吗？":
        case "今天天气怎么样，适合出门吗？":
          // Genuinely off-topic (UNHANDLED).
          return false;
        default:
          throw new Error(
            `evaluation-set.ts: unrecognized reused classification example "${example.question}" — add an explicit expectedGrounded case above rather than silently guessing.`,
          );
      }
    })();
    return { question: example.question, expectedIntent: example.expectedIntent, expectedGrounded };
  },
);

/**
 * New items added by this Task, targeting citation-support measurement:
 * one real, natural question per remaining KB article (the "任务创建" and
 * "Agent 接单与质押" articles are already covered above by reused items),
 * plus a couple more genuinely out-of-scope negative cases and one more
 * real KB-gap case (arbitration duration — parallel to the review-window
 * gap above).
 */
const NEW_CITATION_TARGETED_ITEMS: EvaluationItem[] = [
  {
    // KB: "交易复核规则".
    question: "后端为什么要对链上交易做复核，都检查什么？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "Agent 推荐与撮合流程" — the general mechanism, not any specific
    // task's state (contrast with the personal, expectedGrounded:false
    // "我的任务为什么还没匹配到 Agent？" above).
    question: "任务发布后，系统是怎么把它推荐给合适的 Agent 的？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "成果提交流程".
    question: "Agent 提交任务成果的具体流程是什么？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "验收窗口与正常验收流程" — the MECHANISM (what happens when the
    // requester approves), not the duration number (that's the real KB
    // gap covered above).
    question: "什么是验收窗口？需求方验收通过后，合约会怎么处理预算和质押？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "验收逾期与交付逾期的结算规则" — a real, non-dispute settlement
    // rule (交付逾期退款), distinct from the DISPUTE_PROCESS-classified
    // "交付不合格" quality dispute above.
    question: "如果 Agent 逾期没有交付任务，需求方的预算会不会自动退回来？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "争议与仲裁流程".
    question: "发起争议需要提供什么证据？仲裁结果一般有哪几种可能？",
    expectedIntent: "DISPUTE_PROCESS",
    expectedGrounded: true,
  },
  {
    // KB: "任务取消规则".
    question: "任务发布后如果一直没人接单，我可以把它取消掉吗？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "评分与完成率规则".
    question: "任务结算之后我可以给 Agent 打分吗？评分范围是多少？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // KB: "调用凭据与隐私保护规则".
    question: "平台的公开接口或日志会不会把我的 API Key 明文展示出来？",
    expectedIntent: "PLATFORM_USAGE",
    expectedGrounded: true,
  },
  {
    // Real KB gap, parallel to the review-window duration gap above:
    // "争议与仲裁流程" states WHO decides (arbitrator, RELEASED/REFUNDED)
    // but never a concrete decision-time duration.
    question: "仲裁员一般会在几天内做出裁决？",
    expectedIntent: "DISPUTE_PROCESS",
    expectedGrounded: false,
  },
  {
    // Genuinely off-topic (UNHANDLED).
    question: "帮我看看今天的股市行情怎么样，有什么值得买的股票吗？",
    expectedIntent: "UNHANDLED",
    expectedGrounded: false,
  },
];

/** The full, real evaluation set — 12 reused + 11 new = 23 items, spanning
 * all 4 intent categories and all 11 real seeded KB articles. */
export const CUSTOMER_SERVICE_EVALUATION_SET: readonly EvaluationItem[] = [
  ...REUSED_CLASSIFICATION_ITEMS,
  ...NEW_CITATION_TARGETED_ITEMS,
];
