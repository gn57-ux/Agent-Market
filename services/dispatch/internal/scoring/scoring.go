// Package scoring implements F-703's candidate scoring formula (PRD §9.3).
// It is a pure function package: no database queries, no HTTP calls, no
// global state. It has exactly one dependency, internal/domain, and
// consumes CandidateSnapshot/TaskFeatures values that arrive already
// resolved.
//
// Scope boundary (input precondition): this package only scores candidates
// that have already passed eligibility.Filter (T-701). It does not call
// eligibility.Filter and does not re-check any eligibility condition itself
// — it trusts that the caller (future T-704 orchestration code) has already
// done that filtering. Passing an ineligible-looking candidate (e.g.
// Status == "INACTIVE") still produces a normal Score; see
// TestScore_DoesNotRecheckEligibility for the test that pins this down.
//
// This package also does not implement slot selection (T-703 slotting) or
// human-readable explanation text generation (T-703 explain) — it only
// produces the structured ScoreResult/Reason values those stages consume.
package scoring

import (
	"fmt"
	"math"

	"github.com/agent-market/dispatch/internal/domain"
)

// weights holds the four sub-score weights for one algorithmVersion. Per
// F-703/design.md, weights are compile-time constants versioned by
// algorithmVersion — never a caller-supplied/overridable parameter — and a
// new version must not change an existing version's behavior (the same
// precedent T-701's domain.Level ordinal contract follows).
type weights struct {
	category       float64
	tagSimilarity  float64
	completionRate float64
	qualityScore   float64
}

// v01Weights is the v0.1 weight set from PRD §9.3:
// score = categoryCompatibility×0.30 + tagSimilarity×0.30
//   - completionRate×0.20 + qualityScore×0.20
var v01Weights = weights{
	category:       0.30,
	tagSimilarity:  0.30,
	completionRate: 0.20,
	qualityScore:   0.20,
}

// v01NeutralPrior is v0.1's neutral prior constant, used identically for
// both completionRate (no settled history yet) and qualityScore (no
// qualityScore recorded yet). PRD §9.3 confirms both priors are 0.5 and
// version-scoped together.
const v01NeutralPrior = 0.5

// weightsFor resolves the weight set for algorithmVersion. Only "v0.1" is
// defined by this task. An unrecognized version is a caller error and must
// fail loudly (an error, never a silent fallback to v0.1's weights) — same
// "reject what isn't the closed set of recognized literals" convention
// domain.ParseLevel already establishes (T-701). Silently scoring under the
// wrong version's weights would produce a plausible-looking but wrong
// number with no signal anything was off, which is worse than a build-time
// or request-time failure a caller can actually see and fix.
func weightsFor(algorithmVersion string) (weights, error) {
	switch algorithmVersion {
	case "v0.1":
		return v01Weights, nil
	default:
		return weights{}, fmt.Errorf("scoring: unsupported algorithmVersion %q", algorithmVersion)
	}
}

// neutralPriorFor resolves the neutral prior constant for algorithmVersion.
// Same fail-loudly rationale as weightsFor.
func neutralPriorFor(algorithmVersion string) (float64, error) {
	switch algorithmVersion {
	case "v0.1":
		return v01NeutralPrior, nil
	default:
		return 0, fmt.Errorf("scoring: unsupported algorithmVersion %q", algorithmVersion)
	}
}

// v02weights holds F-1311's five user-confirmed weights for "v0.2"
// (completion 0.30 / quality 0.30 / communication 0.15 / dispute 0.20 /
// scale 0.05, summing to 1.0). A separate type from weights (v0.1's four
// sub-scores) — F-1306/design.md are explicit that v0.1 and v0.2 are two
// independent, complete calculations sharing no sub-score logic, only this
// package's "versioned constant" convention.
type v02weights struct {
	completionRate  float64
	qualityFeedback float64
	communication   float64
	disputeSignal   float64
	historicalScale float64
}

var v02Weights = v02weights{
	completionRate:  0.30,
	qualityFeedback: 0.30,
	communication:   0.15,
	disputeSignal:   0.20,
	historicalScale: 0.05,
}

// ScoreV2 computes one candidate's "v0.2" score from its already-assembled
// ReputationSignals — a wholly separate calculation from v0.1's Score
// (CandidateSnapshot-based), matching design.md's "两条独立的、各自完整的
// 计算路径" decision. Unlike Score, this never returns an error: every
// ReputationSignals value, including the all-nil case, is a valid input
// this function has a defined answer for (a brand-new Agent producing an
// all-nil value is an expected, common shape, not a caller mistake).
//
// F-1309's missing-value handling: a nil field is excluded from both the
// weighted sum and the renormalization denominator — never replaced by any
// value (0, a prior, or otherwise) — so the final score is the weighted
// average of only the PRESENT signals, reweighted so their weights sum to
// 1. Reasons contains one entry per present signal, in the fixed
// completionRate/qualityFeedback/communication/disputeSignal/
// historicalScale order (never the input's field order, since there is
// only one input value — this IS the canonical order), which is what makes
// two calls with the same ReputationSignals value produce byte-identical
// output (AC-1306).
//
// F-1309/F-1312's "全部五项均缺失" case: returns Score 0 with a single
// ReasonV2NoHistoricalSample Reason and no other Reasons. This candidate is
// never meant to WIN a slot on that Score's merit — F-1312 routes it
// through slotting's existing, unchanged domain.IsNewcomer-based
// exploration pool instead (a brand-new Agent has CompletedTaskCount == 0,
// which IsNewcomer already treats as a newcomer) — Score 0 simply keeps
// this candidate from ever outranking a candidate with real history in the
// TOP_SCORE slots, without slotting.go needing to know anything about "no
// sample" as a distinct concept.
func ScoreV2(agentID string, signals domain.ReputationSignals) ScoreResult {
	type presentSignal struct {
		value  float64
		weight float64
		reason Reason
	}
	present := make([]presentSignal, 0, 5)
	if signals.CompletionRate != nil {
		present = append(present, presentSignal{
			value:  *signals.CompletionRate,
			weight: v02Weights.completionRate,
			reason: Reason{Code: ReasonV2CompletionRate, NormalizedValue: *signals.CompletionRate},
		})
	}
	if signals.QualityFeedback != nil {
		present = append(present, presentSignal{
			value:  *signals.QualityFeedback,
			weight: v02Weights.qualityFeedback,
			reason: Reason{Code: ReasonV2QualityFeedback, NormalizedValue: *signals.QualityFeedback},
		})
	}
	if signals.Communication != nil {
		present = append(present, presentSignal{
			value:  *signals.Communication,
			weight: v02Weights.communication,
			reason: Reason{Code: ReasonV2Communication, NormalizedValue: *signals.Communication},
		})
	}
	if signals.DisputeSignal != nil {
		present = append(present, presentSignal{
			value:  *signals.DisputeSignal,
			weight: v02Weights.disputeSignal,
			reason: Reason{Code: ReasonV2DisputeSignal, NormalizedValue: *signals.DisputeSignal},
		})
	}
	if signals.HistoricalScale != nil {
		present = append(present, presentSignal{
			value:  *signals.HistoricalScale,
			weight: v02Weights.historicalScale,
			reason: Reason{Code: ReasonV2HistoricalScale, NormalizedValue: *signals.HistoricalScale},
		})
	}

	if len(present) == 0 {
		return ScoreResult{
			AgentID:            agentID,
			Score:              0,
			Reasons:            []Reason{{Code: ReasonV2NoHistoricalSample}},
			NoHistoricalSample: true,
		}
	}

	var weightedSum, weightSum float64
	reasons := make([]Reason, 0, len(present))
	for _, p := range present {
		weightedSum += p.value * p.weight
		weightSum += p.weight
		reasons = append(reasons, p.reason)
	}

	return ScoreResult{
		AgentID: agentID,
		// Same "round once, at the end" discipline as Score (F-703/design.md).
		Score:   math.Round((weightedSum/weightSum)*1e6) / 1e6,
		Reasons: reasons,
	}
}

// ScoreAllV2 scores every "v0.2" candidate independently — same order-
// preservation contract as ScoreAll (the returned slice's order matches
// candidates'). Reads each candidate's ReputationSignals directly off the
// CandidateSnapshot itself (T-1306's apps/api-side job fills it in before
// this pipeline runs) — deliberately NOT a separate AgentID-keyed map
// parameter: this project explicitly allows two candidate snapshots to
// share one AgentID with different data (see CandidateSnapshot.
// ReputationSignals' own doc comment for the Codex-caught bug an
// AgentID-keyed map reintroduced here in an earlier version of this Task).
// Reading straight off the already-filtered, index-preserved candidates
// slice makes that class of mis-binding structurally impossible: there is
// no second structure for this function's caller to keep in sync.
func ScoreAllV2(candidates []domain.CandidateSnapshot) []ScoreResult {
	results := make([]ScoreResult, 0, len(candidates))
	for _, candidate := range candidates {
		results = append(results, ScoreV2(candidate.AgentID, candidate.ReputationSignals))
	}
	return results
}

// ScoreResult is one candidate's scoring outcome.
type ScoreResult struct {
	AgentID string
	Score   float64
	Reasons []Reason

	// NoHistoricalSample is true only for a ScoreV2 result produced by the
	// all-signals-missing case (F-1309/F-1312) — always false for every
	// v0.1 Score/ScoreAll result. slotting.Select uses this (via
	// ScoredCandidate.ExcludeFromTopScore, httpapi's own binding) to keep
	// a "no real history at all" candidate from ever winning a TOP_SCORE
	// slot on its Score value alone: Score 0 is usually low enough to sort
	// last, but with fewer than 3 total candidates (or several genuine
	// ties at 0) it could still land in the top two purely by construction
	// — F-1309/F-1312 require this candidate to compete ONLY through the
	// exploration-pool mechanism, never through ranked competition.
	NoHistoricalSample bool
}

// Score computes one candidate's score against task. candidate must already
// have passed eligibility.Filter — this function does not re-check
// eligibility. The algorithm version comes exclusively from
// task.AlgorithmVersion — matching design.md's canonical two-argument
// Score(task, candidate) interface — there is no second, independently
// suppliable version parameter that could disagree with it (Codex review,
// T-702 round 1, P2: an earlier version of this function took a separate
// algorithmVersion parameter, which let a caller pass task.AlgorithmVersion
// and the parameter out of sync with no error). Returns an error (never a
// silently-substituted result) when task.AlgorithmVersion is not a
// recognized version.
func Score(task domain.TaskFeatures, candidate domain.CandidateSnapshot) (ScoreResult, error) {
	w, err := weightsFor(task.AlgorithmVersion)
	if err != nil {
		return ScoreResult{}, err
	}
	prior, err := neutralPriorFor(task.AlgorithmVersion)
	if err != nil {
		return ScoreResult{}, err
	}

	categoryScore, categoryReason := scoreCategory()
	tagScore, tagReason := scoreTagSimilarity(task.SkillTags, candidate.SkillTags)
	completionScore, completionReason := scoreCompletionRate(candidate.CompletedTaskCount, candidate.SuccessCount, prior)
	qualityScore, qualityReason := scoreQuality(candidate.QualityScore, prior)

	raw := categoryScore*w.category +
		tagScore*w.tagSimilarity +
		completionScore*w.completionRate +
		qualityScore*w.qualityScore

	return ScoreResult{
		AgentID: candidate.AgentID,
		// Round once, at the very end, on the fully-summed raw score — the
		// four sub-scores above are never individually rounded, so no
		// intermediate rounding error can accumulate (F-703/design.md).
		Score:   math.Round(raw*1e6) / 1e6,
		Reasons: []Reason{categoryReason, tagReason, completionReason, qualityReason},
	}, nil
}

// ScoreAll scores every candidate independently (order of the returned
// slice matches the order of candidates — no sorting/reordering here).
// task.AlgorithmVersion is validated up front, before iterating — not only
// inside the per-candidate Score call — so an unrecognized version is
// still reported as an error even when candidates is empty (Codex review,
// T-702 round 1, P2: the previous version only validated inside the loop
// body, so an empty candidate slice paired with a bad version silently
// "succeeded" with zero results instead of surfacing the bad version).
func ScoreAll(task domain.TaskFeatures, candidates []domain.CandidateSnapshot) ([]ScoreResult, error) {
	if _, err := weightsFor(task.AlgorithmVersion); err != nil {
		return nil, err
	}

	results := make([]ScoreResult, 0, len(candidates))
	for _, candidate := range candidates {
		result, err := Score(task, candidate)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

// scoreCategory returns categoryCompatibility, which is always 1.0.
//
// Why 1.0 is not a magic number: by the time a candidate reaches this
// package, it has already passed eligibility.Filter's condition 2 (exact
// category match, see internal/eligibility). This project has never defined
// a partial/fuzzy category-compatibility mapping — categories only ever
// match exactly or are eliminated before scoring. So every candidate this
// function ever sees necessarily has candidate.Category == task.Category,
// making the "compatibility" sub-score a constant 1.0 rather than a
// computed comparison; there is no [0,1) value this factor could take.
func scoreCategory() (float64, Reason) {
	return 1.0, Reason{
		Code:            ReasonCategoryExactMatch,
		NormalizedValue: 1.0,
	}
}

// scoreTagSimilarity computes the Jaccard similarity
// |candidate ∩ task| / |candidate ∪ task| between candidateTags and
// taskTags.
//
// Boundary case: an empty taskTags means the task declared no required
// skills at all. Following the same "empty requirement = vacuously
// satisfied for everyone" convention T-701's eligibility.skillTagsOverlap
// already established (not a second, invented empty-value semantics), this
// returns 1.0 rather than computing 0/0.
//
// An empty candidateTags against a non-empty taskTags produces an empty
// intersection and a real 0.0 — this candidate would already have been
// eliminated by eligibility's condition 3, but this function still must
// return a deterministic, non-NaN, non-panicking value for that input since
// it does not re-check eligibility (see package doc).
func scoreTagSimilarity(taskTags, candidateTags []string) (float64, Reason) {
	if len(taskTags) == 0 {
		return 1.0, Reason{
			Code:            ReasonSkillTagNoRequirement,
			NormalizedValue: 1.0,
		}
	}

	// Jaccard is a SET similarity — both taskTags and candidateTags must be
	// deduplicated before counting, or a repeated tag inflates the
	// intersection count past the (deduplicated) union size and produces a
	// similarity above 1.0, breaking the [0,1] normalization the whole
	// formula depends on (Codex review, T-702 round 1, P2: e.g. task tags
	// ["python"] against candidate tags ["python","python"] previously
	// scored a 2/2=1.0-breaking "matched=2" against a union of size 1).
	taskSet := make(map[string]struct{}, len(taskTags))
	for _, tag := range taskTags {
		taskSet[tag] = struct{}{}
	}
	candidateSet := make(map[string]struct{}, len(candidateTags))
	for _, tag := range candidateTags {
		candidateSet[tag] = struct{}{}
	}

	union := make(map[string]struct{}, len(taskSet)+len(candidateSet))
	for tag := range taskSet {
		union[tag] = struct{}{}
	}
	for tag := range candidateSet {
		union[tag] = struct{}{}
	}

	matched := 0
	for tag := range candidateSet {
		if _, ok := taskSet[tag]; ok {
			matched++
		}
	}

	similarity := float64(matched) / float64(len(union))

	return similarity, Reason{
		Code:              ReasonSkillTagOverlap,
		NormalizedValue:   similarity,
		SkillTagsMatched:  matched,
		SkillTagsRequired: len(taskSet),
	}
}

// scoreCompletionRate resolves completionRate per resolveCompletionRate and
// builds the matching Reason. prior is the already-resolved neutral prior
// for the caller's algorithmVersion (resolved once in Score, not re-derived
// per sub-score).
func scoreCompletionRate(completedTaskCount, successCount int, prior float64) (float64, Reason) {
	rate := resolveCompletionRate(completedTaskCount, successCount, prior)

	if completedTaskCount == 0 {
		return rate, Reason{
			Code:               ReasonCompletionRateNeutralPrior,
			NormalizedValue:    rate,
			CompletedTaskCount: completedTaskCount,
		}
	}
	return rate, Reason{
		Code:               ReasonCompletionRateHistorical,
		NormalizedValue:    rate,
		CompletedTaskCount: completedTaskCount,
		SuccessCount:       successCount,
	}
}

// resolveCompletionRate computes successCount/completedTaskCount (PRD §6.5:
// "only settled tasks affect the completion rate"). When
// completedTaskCount == 0 (a newcomer with no settled history), it returns
// prior instead of dividing by zero — prior is the caller's
// already-resolved, version-specific neutral prior (v0.1: 0.5), the same
// value resolveQualityScore falls back to.
//
// Immutability: this function only reads its int arguments (passed by
// value) and returns a new float64 — there is nothing here that could
// mutate a caller's CandidateSnapshot.
func resolveCompletionRate(completedTaskCount, successCount int, prior float64) float64 {
	if completedTaskCount == 0 {
		return prior
	}
	return float64(successCount) / float64(completedTaskCount)
}

// scoreQuality resolves qualityScore per resolveQualityScore and builds the
// matching Reason. prior is the already-resolved neutral prior for the
// caller's algorithmVersion.
func scoreQuality(score *float64, prior float64) (float64, Reason) {
	resolved := resolveQualityScore(score, prior)

	if score == nil {
		return resolved, Reason{
			Code:            ReasonQualityScoreNeutralPrior,
			NormalizedValue: resolved,
		}
	}
	return resolved, Reason{
		Code:            ReasonQualityScoreHistorical,
		NormalizedValue: resolved,
	}
}

// resolveQualityScore returns *score when score is non-nil (it is already a
// normalized [0,1] value straight from agents.quality_score — apps/api
// passes it through without transformation), or prior (the caller's
// already-resolved, version-specific neutral prior, v0.1: 0.5) when score
// is nil.
//
// Immutability (AC-709): this function never writes through score — it only
// dereferences it to read the value. The replacement from nil to the prior
// happens purely in this function's return value for this one calculation;
// it is never written back into the caller's CandidateSnapshot or any
// persisted store.
func resolveQualityScore(score *float64, prior float64) float64 {
	if score == nil {
		return prior
	}
	return *score
}
