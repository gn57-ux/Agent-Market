package explain

import (
	"strings"
	"testing"

	"github.com/agent-market/dispatch/internal/scoring"
)

func TestExplain_CategoryExactMatch(t *testing.T) {
	got := Explain(scoring.Reason{Code: scoring.ReasonCategoryExactMatch, NormalizedValue: 1.0})
	if got != "任务分类完全匹配" {
		t.Fatalf("unexpected text: %q", got)
	}
}

func TestExplain_SkillTagOverlap_NumbersReflectReasonFields(t *testing.T) {
	got := Explain(scoring.Reason{
		Code:              scoring.ReasonSkillTagOverlap,
		SkillTagsMatched:  3,
		SkillTagsRequired: 4,
	})
	if got != "命中 3/4 个技能标签" {
		t.Fatalf("unexpected text: %q", got)
	}

	// A different set of numbers must produce a different string, proving
	// the template reads the Reason fields rather than being hardcoded.
	got2 := Explain(scoring.Reason{
		Code:              scoring.ReasonSkillTagOverlap,
		SkillTagsMatched:  1,
		SkillTagsRequired: 5,
	})
	if got2 != "命中 1/5 个技能标签" {
		t.Fatalf("unexpected text: %q", got2)
	}
}

func TestExplain_SkillTagNoRequirement(t *testing.T) {
	got := Explain(scoring.Reason{Code: scoring.ReasonSkillTagNoRequirement})
	if got != "任务未要求特定技能标签" {
		t.Fatalf("unexpected text: %q", got)
	}
}

func TestExplain_CompletionRateHistorical_NumberReflectsNormalizedValue(t *testing.T) {
	got := Explain(scoring.Reason{Code: scoring.ReasonCompletionRateHistorical, NormalizedValue: 0.92})
	if got != "历史完成率 92%" {
		t.Fatalf("unexpected text: %q", got)
	}

	got2 := Explain(scoring.Reason{Code: scoring.ReasonCompletionRateHistorical, NormalizedValue: 0.5})
	if got2 != "历史完成率 50%" {
		t.Fatalf("unexpected text: %q", got2)
	}
}

func TestExplain_CompletionRateNeutralPrior(t *testing.T) {
	got := Explain(scoring.Reason{Code: scoring.ReasonCompletionRateNeutralPrior})
	if got != "暂无历史结算记录，使用平台中性基准" {
		t.Fatalf("unexpected text: %q", got)
	}
}

func TestExplain_QualityScoreHistorical_NumberReflectsNormalizedValue(t *testing.T) {
	got := Explain(scoring.Reason{Code: scoring.ReasonQualityScoreHistorical, NormalizedValue: 0.88})
	if got != "归一化质量分 0.88" {
		t.Fatalf("unexpected text: %q", got)
	}

	got2 := Explain(scoring.Reason{Code: scoring.ReasonQualityScoreHistorical, NormalizedValue: 0.5})
	if got2 != "归一化质量分 0.50" {
		t.Fatalf("unexpected text: %q", got2)
	}
}

func TestExplain_QualityScoreNeutralPrior(t *testing.T) {
	got := Explain(scoring.Reason{Code: scoring.ReasonQualityScoreNeutralPrior})
	if got != "暂无历史评分，使用平台中性基准" {
		t.Fatalf("unexpected text: %q", got)
	}
}

func TestExplain_UnknownReasonCodePanics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected Explain to panic on an unknown ReasonCode, but it returned normally")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "unknown") {
			t.Fatalf("expected panic message to explain the unknown code, got: %v", r)
		}
	}()
	Explain(scoring.Reason{Code: scoring.ReasonCode("NOT_A_REAL_REASON_CODE")})
}

func TestExplainAll_AppliesExplainInOrder(t *testing.T) {
	reasons := []scoring.Reason{
		{Code: scoring.ReasonCategoryExactMatch, NormalizedValue: 1.0},
		{Code: scoring.ReasonSkillTagOverlap, SkillTagsMatched: 2, SkillTagsRequired: 2},
		{Code: scoring.ReasonCompletionRateNeutralPrior},
		{Code: scoring.ReasonQualityScoreNeutralPrior},
	}
	got := ExplainAll(reasons)
	want := []string{
		"任务分类完全匹配",
		"命中 2/2 个技能标签",
		"暂无历史结算记录，使用平台中性基准",
		"暂无历史评分，使用平台中性基准",
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d texts, got %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("index %d: expected %q, got %q", i, want[i], got[i])
		}
	}
}
