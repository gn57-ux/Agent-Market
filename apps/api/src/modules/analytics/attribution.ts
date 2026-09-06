import type { Queryable } from "../../db/pool.js";

/**
 * F-1903/F-1904 (T-1902): the one place that answers "does this later event
 * attribute back to this exposure" — used by T-1904's dataset builder to
 * turn a sequence of raw `interaction_events` rows into labeled training
 * examples, without duplicating this judgment call in that script too
 * (CLAUDE.md 原则 6).
 *
 * Design decision (compare 2 approaches, CLAUDE.md 原则 3 — this is a core
 * cross-Task interface T-1904/T-1905 will build directly on):
 *
 * | 维度 | 方案 A（选用）：纯函数按需计算，不持久化 | 方案 B：新建 `event_attributions` 物化表，批量任务预计算 |
 * |---|---|---|
 * | 接口复杂度 | 一个纯函数 + 一个薄 DB 查询包装，输入输出明确，无需新 schema | 新表 + 填充任务 + 增量更新逻辑（一条新 ACCEPT 到达后必须回填它归因到的旧 EXPOSURE 行） |
 * | 真实消费者 | 目前唯一真实消费者是 T-1904 的周期性（每周一次）批量数据集构建脚本——按需计算一次完全够用 | 目前没有任何需要"随时查询任意一条归因结果"的实时消费者，物化表是无真实消费者驱动的预先优化 |
 * | 可测试性 | 纯函数用构造的时间戳/id 直接单测，DB 包装只需一个真实 Postgres 集成测试验证查询正确性 | 需要额外验证"填充任务是否遗漏增量更新" |
 * | 复杂度下沉位置 | 复杂度（时间窗/关联规则）集中在一个纯函数里，调用方零特殊逻辑 | 同样的规则逻辑，但多一层"何时触发重新计算"的调度复杂度，对当前唯一消费者是不必要的 |
 *
 * 选择方案 A——同项目已反复验证的"只为真实消费者建设"原则（DEFERRED-
 * ENGINEERING.md）：T-1904 是周期性批量脚本，不是需要低延迟随时查询的在线
 * 路径，按需计算一次的成本可忽略，物化表的增量维护复杂度目前没有任何真实
 * 收益。
 *
 * Window default: 7 天，取自本项目其它地方（测试夹具/seed 数据）已反复使用
 * 的标准任务生命周期长度（`delivery_deadline: now() + interval '7 days'`），
 * 不是任意数字——一个真实任务从曝光到真正被接单，跨越数天是正常情况（不同
 * 于 30 分钟量级的网页浏览会话），窗口过短会把大量真实的、只是较慢发生的
 * 接单/提交/验收误判为"未归因"。这是一个工程参数，不是 Q-1902 那类需要用户/
 * 算法负责人拍板的业务门槛数值——后续如需调整，直接改这一个常量，不影响本
 * 函数的判定逻辑本身。
 *
 * N4 real finding (round 1): the first version of this function tried to
 * use `interaction_events.session_id` as F-1904's correlation key directly
 * — but every real `EXPOSURE` row (T-1901) carries the SAME deterministic
 * placeholder (`server:<taskId>`, `outbox-event.ts`'s `serverSessionId`),
 * never a real browsing-session id. That made the "skip the session check
 * when either side is synthetic" branch fire for EVERY exposure-rooted
 * comparison, silently disabling F-1904 entirely for exactly the case it
 * exists to protect: it let ANY OTHER USER's VIEW/CLICK for the same public
 * task (task listings are public; a stranger who never saw this
 * recommendation could still browse the task page) attribute back to this
 * candidate's exposure, poisoning training labels. Compounding that, only
 * requiring `agentId` to match when BOTH sides had one let an agent-less
 * server event (e.g. a pre-acceptance cancellation's `REFUND`, which
 * genuinely has no `acceptedAgentId` yet) match EVERY candidate's exposure
 * for that task, not just one.
 *
 * Fixed by replacing "session id equality" with `runId` as the real
 * correlation anchor for exposure-rooted attribution: every real `EXPOSURE`
 * row also carries the `run_id` of the specific match batch that candidate
 * was shown in (T-1901). A frontend `VIEW`/`CLICK` can only carry that same
 * `run_id` if the reporting client actually received it in a real `/match`
 * response — a stranger who merely knows the public `taskId` has no way to
 * guess it (same "can't fabricate a real backend-issued identifier" property
 * `checkIdentifierAssociation`, T-1901's own P2 fix, already relies on for
 * the write side). A frontend event reported WITHOUT a `runId` is therefore
 * never attributable to a specific exposure — erring toward a false
 * negative (an under-counted, real VIEW) is the safe direction for training-
 * data integrity; erring toward a false positive (crediting a stranger's
 * unrelated browsing) is not. `agentId` is now required to match whenever
 * the candidate carries one, and an agent-less candidate is only accepted
 * when its own event type is `VIEW` (an ordinary task-detail page view,
 * the one case that genuinely has no candidate context) — every other
 * agent-less server event type is rejected rather than matched against
 * every candidate.
 */
export const DEFAULT_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The 9 real event types (T-1900's own closed `event_type` CHECK enum) —
 * re-declared here (not imported from schema.ts, which only lists the 2
 * client-reportable ones) because this file's own concern is "which types
 * are server- vs frontend-originated," a distinct question from "which
 * types can a client legally report."
 */
const SERVER_ORIGINATED_EVENT_TYPES = new Set([
  "EXPOSURE",
  "ACCEPT",
  "SUBMIT",
  "APPROVE",
  "RATE",
  "REFUND",
  "DISPUTE",
]);

export interface AttributionCandidate {
  eventType: string;
  taskId: string | null;
  agentId: string | null;
  runId: string | null;
  occurredAt: Date;
}

/**
 * True when `candidate` attributes back to `exposure`. See this file's own
 * header comment for the full rule set and the real finding that shaped it.
 */
export function isAttributedEvent(
  exposure: AttributionCandidate,
  candidate: AttributionCandidate,
  windowMs: number = DEFAULT_ATTRIBUTION_WINDOW_MS,
): boolean {
  if (candidate.occurredAt.getTime() <= exposure.occurredAt.getTime()) {
    return false;
  }
  if (candidate.occurredAt.getTime() - exposure.occurredAt.getTime() > windowMs) {
    return false;
  }
  if (!exposure.taskId || exposure.taskId !== candidate.taskId) {
    return false;
  }

  if (exposure.agentId) {
    if (candidate.agentId) {
      if (exposure.agentId !== candidate.agentId) {
        return false;
      }
    } else if (candidate.eventType !== "VIEW") {
      // An agent-less candidate is only a legitimate "task-detail page
      // view" — every other agent-less event type (e.g. a pre-acceptance
      // REFUND) has no genuine tie to THIS specific candidate's exposure.
      return false;
    }
  }

  if (exposure.runId && candidate.runId && exposure.runId !== candidate.runId) {
    return false;
  }
  if (
    !SERVER_ORIGINATED_EVENT_TYPES.has(candidate.eventType) &&
    exposure.runId &&
    !candidate.runId
  ) {
    // A frontend-originated candidate (VIEW/CLICK) with no runId cannot be
    // verified as having actually been shown this specific exposure — see
    // header comment. Server-originated candidates never carry a runId in
    // this codebase's own write side (T-1901), so their absence here is
    // routine, not suspicious.
    return false;
  }

  return true;
}

export interface InteractionEventRow {
  id: string;
  eventType: string;
  sessionId: string;
  taskId: string | null;
  agentId: string | null;
  runId: string | null;
  occurredAt: Date;
}

/**
 * DB-backed wrapper T-1904's dataset builder actually calls: given one real
 * EXPOSURE row's id, returns every other real `interaction_events` row
 * (excluding other EXPOSURE rows — a later re-exposure of the same
 * task/agent is not an "outcome") that `isAttributedEvent` accepts.
 */
export async function findAttributedOutcomes(
  pool: Queryable,
  exposureEventId: string,
  windowMs: number = DEFAULT_ATTRIBUTION_WINDOW_MS,
  options: { upperBound?: Date } = {},
): Promise<InteractionEventRow[]> {
  const { rows: exposureRows } = await pool.query<{
    task_id: string | null;
    agent_id: string | null;
    run_id: string | null;
    occurred_at: Date;
  }>(
    `SELECT task_id, agent_id, run_id, occurred_at FROM interaction_events WHERE id = $1 AND event_type = 'EXPOSURE'`,
    [exposureEventId],
  );
  const exposure = exposureRows[0];
  if (!exposure || !exposure.task_id) {
    return [];
  }

  // N4 real finding (P1, T-1904): a caller reconstructing a HISTORICAL
  // snapshot (a past `asOf`) must not let an outcome event that happened
  // AFTER that snapshot's own `asOf` leak in, even though it's still
  // genuinely inside the attribution window — `options.upperBound` (when
  // given) caps the candidate query at whichever is earlier: the window's
  // own end, or the caller's snapshot boundary. Omitted entirely for
  // every OTHER real caller of this function (T-1902's own routes/tests),
  // which have no "as of the past" concept and want the plain window.
  const { rows: candidateRows } = await pool.query<{
    id: string;
    event_type: string;
    session_id: string;
    task_id: string | null;
    agent_id: string | null;
    run_id: string | null;
    occurred_at: Date;
  }>(
    `SELECT id, event_type, session_id, task_id, agent_id, run_id, occurred_at FROM interaction_events
      WHERE task_id = $1 AND event_type <> 'EXPOSURE'
        AND occurred_at > $2 AND occurred_at <= $2 + ($3 || ' milliseconds')::interval
        AND ($4::timestamptz IS NULL OR occurred_at <= $4)
      ORDER BY occurred_at ASC`,
    [
      exposure.task_id,
      exposure.occurred_at.toISOString(),
      windowMs,
      options.upperBound?.toISOString() ?? null,
    ],
  );

  return candidateRows
    .filter((row) =>
      isAttributedEvent(
        {
          eventType: "EXPOSURE",
          taskId: exposure.task_id,
          agentId: exposure.agent_id,
          runId: exposure.run_id,
          occurredAt: exposure.occurred_at,
        },
        {
          eventType: row.event_type,
          taskId: row.task_id,
          agentId: row.agent_id,
          runId: row.run_id,
          occurredAt: row.occurred_at,
        },
        windowMs,
      ),
    )
    .map((row) => ({
      id: row.id,
      eventType: row.event_type,
      sessionId: row.session_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      runId: row.run_id,
      occurredAt: row.occurred_at,
    }));
}
