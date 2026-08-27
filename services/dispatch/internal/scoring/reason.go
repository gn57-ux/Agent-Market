package scoring

// ReasonCode identifies which scoring factor a Reason describes and, for the
// completionRate/qualityScore factors, whether the value came from real
// history or a neutral prior. T-703's explain package is the only place
// allowed to turn a ReasonCode into user-facing (localized) text — this
// package never generates human-readable strings.
type ReasonCode string

const (
	ReasonCategoryExactMatch         ReasonCode = "CATEGORY_EXACT_MATCH"
	ReasonSkillTagOverlap            ReasonCode = "SKILL_TAG_OVERLAP"
	ReasonSkillTagNoRequirement      ReasonCode = "SKILL_TAG_NO_REQUIREMENT"
	ReasonCompletionRateHistorical   ReasonCode = "COMPLETION_RATE_HISTORICAL"
	ReasonCompletionRateNeutralPrior ReasonCode = "COMPLETION_RATE_NEUTRAL_PRIOR"
	ReasonQualityScoreHistorical     ReasonCode = "QUALITY_SCORE_HISTORICAL"
	ReasonQualityScoreNeutralPrior   ReasonCode = "QUALITY_SCORE_NEUTRAL_PRIOR"
)

// Reason carries one scoring factor's structured result — T-703's explain
// package is the only place that turns this into user-facing text (never
// generate Chinese/localized strings in this package).
type Reason struct {
	Code               ReasonCode
	NormalizedValue    float64 // this factor's own [0,1] contribution before weighting
	SkillTagsMatched   int     // populated only for ReasonSkillTagOverlap
	SkillTagsRequired  int     // populated only for ReasonSkillTagOverlap
	CompletedTaskCount int     // populated only for the two CompletionRate codes
	SuccessCount       int     // populated only for ReasonCompletionRateHistorical
}
