import type { Pool } from "pg";
import { advanceDag, type AdvanceDagResult } from "./service.js";

/**
 * T-1709/Q-1701's own required abstraction (requirements.md v1.1: "内部
 * 执行器接口是必须的抽象层，LangGraph 是这个接口的生产实现，不是可选项").
 * ONE method, matching `advanceDag`'s own signature exactly — this
 * interface does not invent any new capability beyond what T-1703's
 * `advanceDag` already does; it exists purely so a caller (`dag-poller.ts`)
 * can be handed either `SimpleDagExecutor` (below) or
 * `LangGraphDagExecutor` (langgraph-executor.ts) without caring which.
 *
 * Deliberately narrow: an executor's job ends at "decide which real
 * Agent Market state-transition function to call, and call it" — it never
 * receives or returns anything about funds, permissions, or final
 * business state beyond what `AdvanceDagResult` already exposes (design.md
 * 决策 2's boundary: "只负责节点推进/重试/失败重匹配的执行意图...不得让 LangGraph
 * 的 graph 定义本身变成隐藏的第二套业务规则来源").
 */
export interface DagExecutor {
  advance(pool: Pool, dagId: string): Promise<AdvanceDagResult>;
}

/**
 * design.md 决策 2's 方案 A ("内部简单执行器") as a `DagExecutor` — a plain,
 * zero-dependency pass-through to `advanceDag` (T-1703). This is the
 * DEFAULT executor `dag-poller.ts` uses; `LangGraphDagExecutor` is a
 * pluggable alternative implementation of the exact same interface, not a
 * replacement for this one (决策 2's own conclusion: build 方案 A first,
 * make 方案 B an executor implementation ON TOP of the same interface,
 * never a second state-machine).
 */
export class SimpleDagExecutor implements DagExecutor {
  async advance(pool: Pool, dagId: string): Promise<AdvanceDagResult> {
    return advanceDag(pool, dagId);
  }
}
