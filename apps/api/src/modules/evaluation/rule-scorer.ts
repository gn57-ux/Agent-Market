/**
 * F-2003/design.md 决策 2 (T-2001): "结构化规则评分...每一分都能追溯到具体
 * 的检查项". `RULE_BASED` scoring's real, deterministic implementation for
 * this Task's scope.
 *
 * Design comparison (CLAUDE.md 原则 3 — this is a new interface a rubric's
 * `criteria` JSONB column must conform to):
 *
 * | 维度 | 方案 A（选用）：单一"关键要素出现"规则类型 | 方案 B：从一开始支持多种规则类型（关键词/数值范围/正则/代码测试通过率） |
 * |---|---|---|
 * | 与 design.md 原文匹配度 | 决策 2 举的具体例子就是"文本类评测检查关键要素是否出现"——直接实现这一种 | 决策 2 只举了例子，没有要求一次性支持全部规则形态 |
 * | 与 Q-2001 未决的匹配度 | Q-2001（评测任务题库来源）尚未决策，题目的真实形态未知，先做能验证的最小规则类型 | 在不知道真实题目形态前设计"代码测试通过率"等规则类型是无依据的猜测（CLAUDE.md 原则 1/2） |
 * | 可扩展性 | `criteria.type` 字段本身就是判别式，未来新增规则类型是新增一个 case 分支，不是破坏性 schema 变更 | 相同的可扩展性，但当下没有第二种规则的真实需求，属于过度设计（CLAUDE.md 原则 4） |
 *
 * 选择方案 A。`criteria.type` 判别联合使非法规则形态无法通过类型检查
 * （CLAUDE.md 原则 8）。
 */
export interface KeywordPresenceCriteria {
  type: "KEYWORD_PRESENCE";
  requiredKeywords: string[];
}

export type RuleBasedCriteria = KeywordPresenceCriteria;

export interface RuleScoreResult {
  score: number;
  rationale: string;
}

/**
 * Case-insensitive substring presence check per keyword — deterministic
 * and traceable: the rationale lists exactly which keywords were found and
 * missing, so a human reading `evaluation_results.rationale` never has to
 * trust an opaque number (F-2003's own "可解释性" requirement).
 */
export function scoreKeywordPresence(
  submittedContent: string,
  criteria: KeywordPresenceCriteria,
): RuleScoreResult {
  const normalizedContent = submittedContent.toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];

  for (const keyword of criteria.requiredKeywords) {
    if (normalizedContent.includes(keyword.toLowerCase())) {
      matched.push(keyword);
    } else {
      missing.push(keyword);
    }
  }

  const total = criteria.requiredKeywords.length;
  const score = total === 0 ? 0 : Math.round((matched.length / total) * 100 * 100) / 100;

  const rationale =
    total === 0
      ? "rubric 未定义任何关键要素，无法评分"
      : `命中 ${matched.length}/${total} 个关键要素：[${matched.join(", ")}]；` +
        `缺失：[${missing.join(", ")}]`;

  return { score, rationale };
}

/**
 * The one entry point `repository.ts` calls — dispatches on `criteria.type`
 * so adding a second rule type later is a new `case`, not a change to this
 * function's callers.
 */
export function scoreRuleBased(
  submittedContent: string,
  criteria: RuleBasedCriteria,
): RuleScoreResult {
  switch (criteria.type) {
    case "KEYWORD_PRESENCE":
      return scoreKeywordPresence(submittedContent, criteria);
  }
}
