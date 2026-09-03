// Package explain converts scoring.Reason's structured output into
// user-facing Chinese text, per F-705 ("解释必须来自实际参与计算的特征，不得
// 由大模型编造"). Every number in the generated text is read directly from
// the Reason value passed in — this package does no scoring computation of
// its own, no database/HTTP calls, and no hardcoded example numbers.
package explain

import (
	"fmt"

	"github.com/agent-market/dispatch/internal/scoring"
)

// Explain converts one Reason into its PRD §9.5 Chinese text. This is an
// exhaustive switch over scoring.ReasonCode: every code scoring.go defines
// today has exactly one case here. Go's string-based enums have no
// compiler-enforced exhaustiveness check, so an unrecognized code (a new
// ReasonCode added to scoring without a matching case added here, or any
// other invalid value) panics with a clear message rather than silently
// returning an empty string — a missing mapping must be loud, per the
// capsule's explicit requirement.
func Explain(reason scoring.Reason) string {
	switch reason.Code {
	case scoring.ReasonCategoryExactMatch:
		return "任务分类完全匹配"
	case scoring.ReasonSkillTagOverlap:
		return fmt.Sprintf("命中 %d/%d 个技能标签", reason.SkillTagsMatched, reason.SkillTagsRequired)
	case scoring.ReasonSkillTagNoRequirement:
		return "任务未要求特定技能标签"
	case scoring.ReasonCompletionRateHistorical:
		return fmt.Sprintf("历史完成率 %.0f%%", reason.NormalizedValue*100)
	case scoring.ReasonCompletionRateNeutralPrior:
		return "暂无历史结算记录，使用平台中性基准"
	case scoring.ReasonQualityScoreHistorical:
		return fmt.Sprintf("归一化质量分 %.2f", reason.NormalizedValue)
	case scoring.ReasonQualityScoreNeutralPrior:
		return "暂无历史评分，使用平台中性基准"
	case scoring.ReasonV2CompletionRate:
		return fmt.Sprintf("完成强度 %.0f%%", reason.NormalizedValue*100)
	case scoring.ReasonV2QualityFeedback:
		return fmt.Sprintf("质量反馈 %.2f", reason.NormalizedValue)
	case scoring.ReasonV2Communication:
		return fmt.Sprintf("沟通体验 %.2f", reason.NormalizedValue)
	case scoring.ReasonV2DisputeSignal:
		return fmt.Sprintf("争议信号 %.2f", reason.NormalizedValue)
	case scoring.ReasonV2HistoricalScale:
		return fmt.Sprintf("历史完成规模 %.2f", reason.NormalizedValue)
	case scoring.ReasonV2NoHistoricalSample:
		return "暂无历史结算样本，归类为新人探索位"
	default:
		panic(fmt.Sprintf("explain: unknown scoring.ReasonCode %q — a template mapping is missing for this code", reason.Code))
	}
}

// ExplainAll applies Explain to every Reason in order, for one Slot's full
// Reasons[] output.
func ExplainAll(reasons []scoring.Reason) []string {
	texts := make([]string, len(reasons))
	for i, r := range reasons {
		texts[i] = Explain(r)
	}
	return texts
}
