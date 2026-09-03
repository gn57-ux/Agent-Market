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

	// v0.2 signal codes (F-1306/F-1308/F-1309, Feature 13/T-1305). Distinct
	// from the v0.1 codes above even where the underlying concept sounds
	// similar (e.g. ReasonV2CompletionRate is a 90-day/50-task ON-TIME
	// ratio, not the same "successCount/completedTaskCount over all time"
	// v0.1's ReasonCompletionRateHistorical describes) — the two algorithm
	// versions never share a sub-score formula, so they must never share a
	// ReasonCode either. None of these five has a "neutral prior" sibling:
	// F-1309 forbids substituting any value for a missing v0.2 signal, so a
	// missing signal produces no Reason at all (ScoreV2 excludes it from
	// the Reasons slice entirely) rather than a NeutralPrior-shaped one.
	ReasonV2CompletionRate     ReasonCode = "V2_COMPLETION_RATE"
	ReasonV2QualityFeedback    ReasonCode = "V2_QUALITY_FEEDBACK"
	ReasonV2Communication      ReasonCode = "V2_COMMUNICATION"
	ReasonV2DisputeSignal      ReasonCode = "V2_DISPUTE_SIGNAL"
	ReasonV2HistoricalScale    ReasonCode = "V2_HISTORICAL_SCALE"
	ReasonV2NoHistoricalSample ReasonCode = "V2_NO_HISTORICAL_SAMPLE"
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
