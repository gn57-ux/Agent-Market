import { z } from "zod";

// Same lowercase-0x-hex40 shape every other module keeps its own copy of
// (see funds/schema.ts's own doc comment for why this isn't shared).
const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

const TITLE_SCHEMA = z.string().trim().min(1, "标题不能为空").max(200, "标题过长（最多 200 字）");
const CATEGORY_SCHEMA = z.string().trim().min(1, "分类不能为空").max(100, "分类过长");
const NODE_DESCRIPTION_SCHEMA = z
  .string()
  .trim()
  .min(1, "节点描述不能为空")
  .max(5000, "节点描述过长（最多 5000 字）");
const SKILL_TAG_SCHEMA = z.string().trim().min(1, "技能标签不能为空").max(50, "技能标签过长");

// Same minimal-unit-unsigned-integer-string convention as tasks/schema.ts's
// BUDGET_SCHEMA (each module keeps its own copy — established convention).
// A DAG node's sub_budget becomes a real `tasks.budget` value once T-1702
// activates it, so it must already satisfy every constraint that column
// will eventually enforce.
const MINIMAL_UNIT_INTEGER_PATTERN = /^\d+$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const BUDGET_SCHEMA = z
  .string()
  .trim()
  .max(80, "预算数值过长")
  .regex(
    MINIMAL_UNIT_INTEGER_PATTERN,
    "预算必须是最小单位的非负整数字符串（不支持小数、科学计数法或负数）",
  )
  .refine((value) => MINIMAL_UNIT_INTEGER_PATTERN.test(value) && BigInt(value) > 0n, {
    message: "预算必须大于 0",
  })
  .refine((value) => MINIMAL_UNIT_INTEGER_PATTERN.test(value) && BigInt(value) <= MAX_UINT256, {
    message: "预算超出链上可表示的最大值",
  });

const EXPERT_TYPE_SCHEMA = z.enum(
  ["DATA_ANALYSIS", "CONTENT_GENERATION", "SOFTWARE_DEVELOPMENT", "RESEARCH", "AUTOMATION"],
  { message: "专家类型必须是 5 个合法枚举值之一" },
);

const NODE_TITLE_SCHEMA = z
  .string()
  .trim()
  .min(1, "节点标题不能为空")
  .max(200, "节点标题过长（最多 200 字）");

// Same convention as tasks/schema.ts's own DELIVERY_DEADLINE_SCHEMA (each
// module keeps its own copy). T-1702 (0024_add_task_dag_node_title_and_
// deadline.sql's own header comment) copies this value verbatim into the
// real `tasks.delivery_deadline` a node's real task gets at activation
// time — an absolute point in time set once at DAG-creation, not
// re-derived relative to whenever activation happens to occur.
const NODE_DELIVERY_DEADLINE_SCHEMA = z
  .string()
  .datetime({ message: "截止时间必须是合法的 ISO 8601 时间字符串" })
  .refine((value) => new Date(value).getTime() > Date.now(), "截止时间必须晚于当前时间");

// `key` is a client-scoped identifier for THIS submission only — it never
// reaches the database. Real node identity is the UUID repository.ts
// assigns on insert; `dependsOn` references are resolved from `key` to
// that UUID inside the same transaction that creates the nodes.
const NODE_KEY_SCHEMA = z.string().trim().min(1, "节点 key 不能为空").max(64, "节点 key 过长");

const dagNodeInputSchema = z.object({
  key: NODE_KEY_SCHEMA,
  role: z.enum(["SERIAL", "PARALLEL", "AGGREGATE"], {
    message: "节点角色必须是三个合法枚举值之一",
  }),
  title: NODE_TITLE_SCHEMA,
  description: NODE_DESCRIPTION_SCHEMA,
  subBudget: BUDGET_SCHEMA,
  expertType: EXPERT_TYPE_SCHEMA,
  deliveryDeadline: NODE_DELIVERY_DEADLINE_SCHEMA,
  // N4 round-2 real finding (P2): a duplicate skill tag in the same array
  // passes every check here but then hits task_dag_node_skills' (node_id,
  // skill_tag) primary key on the second INSERT — a request this schema
  // accepted would 500 instead of getting a clean 400. Same reasoning for
  // dependsOn: a duplicate dependency key passes topology.ts's checks
  // (which only look at distinct keys) but then hits task_dag_edges'
  // (from_node_id, to_node_id) primary key on the second edge INSERT.
  skillTags: z
    .array(SKILL_TAG_SCHEMA)
    .max(20, "技能标签最多 20 个")
    .default([])
    .refine((tags) => new Set(tags).size === tags.length, "技能标签不能重复"),
  dependsOn: z
    .array(NODE_KEY_SCHEMA)
    .max(50, "单个节点的前置依赖最多 50 个")
    .default([])
    .refine((deps) => new Set(deps).size === deps.length, "前置依赖不能重复"),
});

/**
 * F-1701/design.md 接口契约: `POST /dags` — `requesterAddress` is NOT a
 * field here (comes from `app.requireSession`, matching tasks/schema.ts's
 * `createDraftSchema`). `totalBudget` is declared separately from the sum
 * of `nodes[].subBudget` so the request can assert its own intent (F-1701's
 * "子预算之和与声明总预算一致" check compares the two rather than deriving
 * one from the other) — a request that gets the arithmetic wrong is
 * rejected with a clear mismatch error instead of the server silently
 * "fixing" it by ignoring totalBudget.
 */
export const createDagSchema = z.object({
  title: TITLE_SCHEMA,
  category: CATEGORY_SCHEMA,
  totalBudget: BUDGET_SCHEMA,
  nodes: z.array(dagNodeInputSchema).min(1, "DAG 至少需要一个节点").max(50, "DAG 节点数最多 50 个"),
});

export type CreateDagInput = z.infer<typeof createDagSchema>;
export type DagNodeInput = z.infer<typeof dagNodeInputSchema>;

export const dagIdParamSchema = z.object({
  dagId: z.string().uuid("dagId 必须是合法的 UUID"),
});

// T-1705: shared param schema for the three node-control endpoints
// (retry/cancel/manual-takeover) — same dagId shape as `dagIdParamSchema`
// plus nodeId, kept as one schema (not two separately-parsed ones) so a
// single `safeParse` validates both path segments together.
export const dagNodeParamSchema = z.object({
  dagId: z.string().uuid("dagId 必须是合法的 UUID"),
  nodeId: z.string().uuid("nodeId 必须是合法的 UUID"),
});

// T-1706: `POST /dags/:dagId/nodes/:nodeId/select-result` body — one or
// more predecessor node ids the requester adopts as the AGGREGATE node's
// own basis. `.min(1)` (never an empty selection through this endpoint —
// "clear my selection" is not a requirement F-1706/AC-1704 describes) and
// `.refine()` uniqueness (same discipline as `dagNodeInputSchema`'s own
// skillTags/dependsOn checks) so a duplicate id can't reach the repository
// layer's array UPDATE.
export const selectDagNodeResultSchema = z.object({
  selectedNodeIds: z
    .array(z.string().uuid("selectedNodeIds 中每一项都必须是合法的 UUID"))
    .min(1, "至少选择一个前置节点的交付结果")
    .max(50, "选择的前置节点数最多 50 个")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "selectedNodeIds 不能包含重复的节点 id",
    }),
});

export { ETH_ADDRESS_SCHEMA };
