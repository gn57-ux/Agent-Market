import type { Queryable } from "../../db/pool.js";

/**
 * F-1911 (T-1908): "少数 Agent 占据绝大部分曝光" 头部垄断信号——一个只读
 * 监控函数，不做任何自动干预（design.md 决策 6 的探索机制本身仍然是
 * F-1916 的灰度流量比例，这里只负责"发现问题"，不负责"自动纠正"，避免
 * 用一套隐式的、未经批准的再平衡逻辑悄悄改变真实排序行为）。
 *
 * 只统计真实 `EXPOSURE` 事件（每次撮合对每个候选都会记录一条，T-1900），
 * 不是"被接受"或"完成"计数——曝光集中度回答的是"排序层面是否已经把绝大
 * 多数展示机会给了极少数 Agent"，这正是新人探索位设计要防止的现象，与
 * 接受率/完成率是两个不同的问题。
 */
export interface ExposureConcentrationResult {
  windowExposureCount: number;
  distinctAgentCount: number;
  topAgentShares: Array<{ agentId: string; exposureCount: number; share: number }>;
  /** True when the top `topAgentCount` agents together account for more
   * than `shareThreshold` of all real exposures in the window. */
  flagged: boolean;
}

export async function detectExposureConcentration(
  client: Queryable,
  options: { since: Date; topAgentCount?: number; shareThreshold?: number } = {
    since: new Date(0),
  },
): Promise<ExposureConcentrationResult> {
  const topAgentCount = options.topAgentCount ?? 3;
  const shareThreshold = options.shareThreshold ?? 0.5;

  const { rows } = await client.query<{ agent_id: string; exposure_count: string }>(
    `SELECT agent_id, COUNT(*) AS exposure_count
       FROM interaction_events
      WHERE event_type = 'EXPOSURE'
        AND agent_id IS NOT NULL
        AND occurred_at >= $1
      GROUP BY agent_id
      ORDER BY exposure_count DESC`,
    [options.since.toISOString()],
  );

  const counts = rows.map((row) => Number(row.exposure_count));
  const windowExposureCount = counts.reduce((sum, count) => sum + count, 0);

  if (windowExposureCount === 0) {
    return { windowExposureCount: 0, distinctAgentCount: 0, topAgentShares: [], flagged: false };
  }

  const topAgentShares = rows.slice(0, topAgentCount).map((row) => ({
    agentId: row.agent_id,
    exposureCount: Number(row.exposure_count),
    share: Number(row.exposure_count) / windowExposureCount,
  }));
  const topShareSum = topAgentShares.reduce((sum, entry) => sum + entry.share, 0);

  return {
    windowExposureCount,
    distinctAgentCount: rows.length,
    topAgentShares,
    flagged: topShareSum > shareThreshold,
  };
}

/**
 * F-1912 (T-1908): "识别并排除明显的刷曝光/刷点击行为对训练数据和灰度
 * 评估的污染"——本函数负责"识别"（`flaggedSessionIds`），真正的"排除"发生
 * 在唯一的真实消费者 `dataset-builder.ts`（`buildTrainingDataset` 的
 * `excludedSessionIds` 选项，由 `build-ctr-training-dataset.ts` 在构建
 * 数据集前调用本函数并把结果传入）——F-1912 的字面要求是"识别并排除"两个
 * 动作合起来才算完成，只识别不接入训练数据构建，异常流量依旧会照常污染
 * 训练数据（N4 real finding, P1, round 1）。
 *
 * 判定规则：同一个 `session_id` 在窗口内产生的 VIEW/CLICK 事件数超过阈值
 * ——一个真实用户在正常浏览节奏下不会在短窗口内对同一批任务/候选产生数十
 * 次点击，这是一个工程兜底启发式（不是训练好的异常检测模型），如实标注
 * 这一点，不假装是严谨的统计方法。
 */
export interface AnomalousSessionsResult {
  flaggedSessionIds: string[];
  /** N4 real finding (P2): a plain object keyed by a session id an
   * adversary fully controls (client-supplied, T-1901's own collection
   * endpoint) can be poisoned by a key like `__proto__`, silently
   * corrupting or losing that session's own count instead of recording it.
   * A `Map` has no such prototype-chain surface regardless of the key's
   * value. */
  eventCountBySessionId: Map<string, number>;
}

export async function detectAnomalousSessions(
  client: Queryable,
  options: { since: Date; until?: Date; maxEventsPerSession?: number } = { since: new Date(0) },
): Promise<AnomalousSessionsResult> {
  const maxEventsPerSession = options.maxEventsPerSession ?? 50;

  const { rows } = await client.query<{ session_id: string; event_count: string }>(
    `SELECT session_id, COUNT(*) AS event_count
       FROM interaction_events
      WHERE event_type IN ('VIEW', 'CLICK')
        AND occurred_at >= $1
        AND ($2::timestamptz IS NULL OR occurred_at <= $2)
      GROUP BY session_id`,
    [options.since.toISOString(), options.until?.toISOString() ?? null],
  );

  const eventCountBySessionId = new Map<string, number>();
  const flaggedSessionIds: string[] = [];
  for (const row of rows) {
    const count = Number(row.event_count);
    eventCountBySessionId.set(row.session_id, count);
    if (count > maxEventsPerSession) flaggedSessionIds.push(row.session_id);
  }

  return { flaggedSessionIds, eventCountBySessionId };
}

/**
 * N4 real finding (P1, round 2): a real `EXPOSURE` row's `session_id` is
 * always the server-synthesized `server:<taskId>` (T-1901's own
 * convention), never the client-supplied session id `detectAnomalousSessions`
 * flags from `VIEW`/`CLICK` events — the two are structurally disjoint
 * strings, so a flagged session id can NEVER match an `EXPOSURE` row's own
 * `session_id`. The real, existing correlation between a client's
 * `VIEW`/`CLICK` and the `EXPOSURE` it reacted to is `run_id` (T-1902's own
 * attribution anchor — a stranger cannot forge another run's id). This
 * resolves a set of flagged session ids to the real `run_id`s their own
 * events reference, which `dataset-builder.ts`'s `excludedRunIds` option
 * can actually filter `EXPOSURE` rows by.
 */
export async function resolveAffectedRunIds(
  client: Queryable,
  sessionIds: string[],
): Promise<string[]> {
  if (sessionIds.length === 0) return [];

  const { rows } = await client.query<{ run_id: string }>(
    `SELECT DISTINCT run_id
       FROM interaction_events
      WHERE session_id = ANY($1::text[])
        AND run_id IS NOT NULL`,
    [sessionIds],
  );
  return rows.map((row) => row.run_id);
}
