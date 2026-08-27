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

// ScoreResult is one candidate's scoring outcome.
type ScoreResult struct {
	AgentID string
	Score   float64
	Reasons []Reason
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
