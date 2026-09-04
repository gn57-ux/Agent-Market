import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Pool } from "pg";
import { advanceDag, type AdvanceDagResult } from "./service.js";
import type { DagExecutor } from "./executor.js";

/**
 * T-1709/Q-1701 (v1.1, 用户定稿): "确认接入 LangGraph，但严格限定在'DAG 编排
 * 边界'内". The graph below has exactly ONE node, and that node's entire
 * body is a direct, unmodified call to `advanceDag` (T-1703's own real
 * state-transition function) — LangGraph here decides nothing about which
 * task to fund, which node is ready, or what a terminal task status means;
 * ALL of that logic still lives exactly where it always has
 * (`dag/repository.ts`'s `advanceDagNodes`). LangGraph's only real job in
 * this adapter is "run this one step, then stop" — the narrowest possible
 * non-trivial use of the library, matching design.md 决策 2's explicit
 * warning against letting "LangGraph 的 graph 定义本身变成隐藏的第二套业务
 * 规则来源".
 *
 * State shape is deliberately minimal — `pool`/`dagId` in, `result` out —
 * not a general "DAG execution state" the graph owns; the graph's node
 * doesn't even read or write `task_dag_nodes`/`tasks` directly, it only
 * calls the function that does.
 */
const AdvanceState = Annotation.Root({
  pool: Annotation<Pool>(),
  dagId: Annotation<string>(),
  result: Annotation<AdvanceDagResult | undefined>(),
});

/**
 * N4 real finding (round 1, P1): the original version compiled this graph
 * with `checkpointer: new MemorySaver()`, and `LangGraphDagExecutor` below
 * is held as a long-lived singleton (`server.ts` constructs ONE instance
 * for the process's entire lifetime when `DAG_EXECUTOR=langgraph`). Every
 * `dag-poller.ts` tick (every 10s, forever, for every active DAG) invoked
 * the SAME graph, on the SAME `thread_id`, appending another checkpoint to
 * that thread's history each time — an unbounded, permanent in-memory leak
 * for any long-running DAG (and for every completed DAG's thread, which is
 * never pruned either) over the process's real uptime. Fixed by compiling
 * with NO checkpointer at all: this graph has exactly one node, no
 * conditional edges, no interrupt/resume points, and — critically — its
 * node never reads anything back from a prior checkpoint; `advanceDag`
 * re-derives 100% of the DAG's real state from Postgres on every call, the
 * same as it does for `SimpleDagExecutor`. A checkpointer that nothing
 * ever reads from is pure memory cost with zero behavioral benefit, so the
 * correct fix removes it rather than bounding/pruning it.
 */
function buildAdvanceGraph() {
  return new StateGraph(AdvanceState)
    .addNode("advance", async (state) => {
      const result = await advanceDag(state.pool, state.dagId);
      return { result };
    })
    .addEdge(START, "advance")
    .addEdge("advance", END)
    .compile();
}

/**
 * `DagExecutor` (executor.ts) implemented via LangGraph — the "生产实现"
 * requirements.md v1.1 requires. Deliberately keeps NO checkpointer (see
 * `buildAdvanceGraph`'s own doc comment, N4 round-1 finding) — this
 * implementation is only correct because it needs no persisted graph state
 * at all: the user's own definitive requirement ("运行状态必须持久化") is
 * satisfied by the REAL state living in Postgres/chain (exactly as it
 * already does for `SimpleDagExecutor`), not by anything LangGraph itself
 * remembers between calls. `langgraph-executor.integration.test.ts` proves
 * this directly: two entirely separate `LangGraphDagExecutor` instances
 * (no shared graph, no shared memory of any kind) correctly cooperate to
 * finish advancing the same real DAG.
 */
export class LangGraphDagExecutor implements DagExecutor {
  private readonly graph = buildAdvanceGraph();

  async advance(pool: Pool, dagId: string): Promise<AdvanceDagResult> {
    const output = await this.graph.invoke({ pool, dagId });
    if (!output.result) {
      throw new Error(`LangGraphDagExecutor: graph produced no result for dag ${dagId}`);
    }
    return output.result;
  }
}
