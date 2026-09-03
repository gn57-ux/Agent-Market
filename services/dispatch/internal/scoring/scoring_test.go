package scoring

import (
	"math"
	"testing"
	"time"

	"github.com/agent-market/dispatch/internal/domain"
)

// baseTask and baseCandidate are the "neutral, all-history-present" fixtures
// every single-factor test starts from and then deviates from in exactly
// one field, matching internal/eligibility's baseTask()/baseCandidate()
// convention (T-701) so a failing test unambiguously points at the one
// factor it changed.
func baseTask() domain.TaskFeatures {
	return domain.TaskFeatures{
		TaskID:           "task-1",
		Category:         "data-labeling",
		SkillTags:        []string{"python", "nlp"},
		DeliveryDeadline: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		RequiredLevel:    domain.LevelIntermediate,
		RequesterAddress: "0x1111111111111111111111111111111111111111"[:42],
		AlgorithmVersion: "v0.1",
	}
}

func baseCandidate() domain.CandidateSnapshot {
	q := 0.8
	return domain.CandidateSnapshot{
		AgentID:            "agent-1",
		WalletAddress:      "0x2222222222222222222222222222222222222222"[:42],
		Status:             "ACTIVE",
		Category:           "data-labeling",
		SkillTags:          []string{"python", "nlp"},
		Level:              domain.LevelExpert,
		MaxConcurrentTasks: 3,
		ActiveTaskCount:    1,
		CompletedTaskCount: 10,
		SuccessCount:       8,
		OverdueCount:       1,
		QualityScore:       &q,
		CreatedAt:          time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		IsNewcomer:         false,
		IsBanned:           false,
	}
}

const scoreEpsilon = 1e-9

func approxEqual(a, b float64) bool {
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff < scoreEpsilon
}

// mustScore calls Score and fails the test immediately on an unexpected
// error, so every other test in this file can call it exactly like the
// pre-error-handling Score(...).Score one-liner without repeating error
// checks at each call site. algorithmVersion comes exclusively from
// task.AlgorithmVersion (Codex review, T-702 round 1, P2 — Score/ScoreAll
// no longer take a separate version parameter).
func mustScore(t *testing.T, task domain.TaskFeatures, candidate domain.CandidateSnapshot) ScoreResult {
	t.Helper()
	result, err := Score(task, candidate)
	if err != nil {
		t.Fatalf("unexpected error from Score: %v", err)
	}
	return result
}

// mustScoreAll is ScoreAll's equivalent of mustScore.
func mustScoreAll(t *testing.T, task domain.TaskFeatures, candidates []domain.CandidateSnapshot) []ScoreResult {
	t.Helper()
	results, err := ScoreAll(task, candidates)
	if err != nil {
		t.Fatalf("unexpected error from ScoreAll: %v", err)
	}
	return results
}

// --- 1. Four sub-scores each independently move the total score by weight ---

func TestScore_CategoryCompatibilityAlwaysContributesFullWeight(t *testing.T) {
	// categoryCompatibility is always 1.0 (candidates reaching this package
	// already passed eligibility's exact category match), so its
	// contribution is always exactly the 0.30 weight regardless of any
	// other field. Verified indirectly: with tag/completion/quality all at
	// their maximum (1.0), the total must be exactly 1.0 (0.30+0.30+0.20+0.20).
	task := baseTask()
	task.SkillTags = []string{"python"}
	c := baseCandidate()
	c.SkillTags = []string{"python"} // Jaccard = 1.0
	c.CompletedTaskCount = 10
	c.SuccessCount = 10 // completionRate = 1.0
	q := 1.0
	c.QualityScore = &q // qualityScore = 1.0

	result, err := Score(task, c)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !approxEqual(result.Score, 1.0) {
		t.Fatalf("expected total score 1.0 with all sub-scores maxed, got %v", result.Score)
	}
}

func TestScore_TagSimilarityChangesScoreByItsWeight(t *testing.T) {
	task := baseTask()
	task.SkillTags = []string{"python", "nlp"}

	full := baseCandidate()
	full.SkillTags = []string{"python", "nlp"} // Jaccard = 1.0

	none := baseCandidate()
	none.SkillTags = []string{"design", "illustration"} // Jaccard = 0.0

	fullScore := mustScore(t, task, full).Score
	noneScore := mustScore(t, task, none).Score

	wantDelta := 0.30 // tagSimilarity weight, the only field that changed
	gotDelta := fullScore - noneScore
	if !approxEqual(gotDelta, wantDelta) {
		t.Fatalf("expected score delta %v from tagSimilarity 1.0->0.0, got %v (full=%v none=%v)", wantDelta, gotDelta, fullScore, noneScore)
	}
}

func TestScore_CompletionRateChangesScoreByItsWeight(t *testing.T) {
	task := baseTask()

	high := baseCandidate()
	high.CompletedTaskCount = 10
	high.SuccessCount = 10 // completionRate = 1.0

	low := baseCandidate()
	low.CompletedTaskCount = 10
	low.SuccessCount = 0 // completionRate = 0.0

	highScore := mustScore(t, task, high).Score
	lowScore := mustScore(t, task, low).Score

	wantDelta := 0.20 // completionRate weight
	gotDelta := highScore - lowScore
	if !approxEqual(gotDelta, wantDelta) {
		t.Fatalf("expected score delta %v from completionRate 1.0->0.0, got %v (high=%v low=%v)", wantDelta, gotDelta, highScore, lowScore)
	}
}

func TestScore_QualityScoreChangesScoreByItsWeight(t *testing.T) {
	task := baseTask()

	qHigh := 1.0
	high := baseCandidate()
	high.QualityScore = &qHigh

	qLow := 0.0
	low := baseCandidate()
	low.QualityScore = &qLow

	highScore := mustScore(t, task, high).Score
	lowScore := mustScore(t, task, low).Score

	wantDelta := 0.20 // qualityScore weight
	gotDelta := highScore - lowScore
	if !approxEqual(gotDelta, wantDelta) {
		t.Fatalf("expected score delta %v from qualityScore 1.0->0.0, got %v (high=%v low=%v)", wantDelta, gotDelta, highScore, lowScore)
	}
}

// --- 2. Boundary values ---

func TestScoreTagSimilarity_FullIntersection(t *testing.T) {
	got, reason := scoreTagSimilarity([]string{"python", "nlp"}, []string{"python", "nlp"})
	if !approxEqual(got, 1.0) {
		t.Fatalf("expected 1.0, got %v", got)
	}
	if reason.Code != ReasonSkillTagOverlap {
		t.Fatalf("expected ReasonSkillTagOverlap, got %v", reason.Code)
	}
	if reason.SkillTagsMatched != 2 || reason.SkillTagsRequired != 2 {
		t.Fatalf("expected matched=2 required=2, got matched=%d required=%d", reason.SkillTagsMatched, reason.SkillTagsRequired)
	}
}

func TestScoreTagSimilarity_ZeroIntersection(t *testing.T) {
	got, reason := scoreTagSimilarity([]string{"python", "nlp"}, []string{"design", "illustration"})
	if !approxEqual(got, 0.0) {
		t.Fatalf("expected 0.0, got %v", got)
	}
	if reason.Code != ReasonSkillTagOverlap {
		t.Fatalf("expected ReasonSkillTagOverlap, got %v", reason.Code)
	}
	if reason.SkillTagsMatched != 0 {
		t.Fatalf("expected matched=0, got %d", reason.SkillTagsMatched)
	}
}

// Regression for Codex round 1 P2: Jaccard must dedupe both sides before
// counting — a repeated candidate tag must not inflate the intersection
// count past the (deduplicated) union size.
func TestScoreTagSimilarity_DuplicateTagsDoNotInflateSimilarityPastOne(t *testing.T) {
	got, reason := scoreTagSimilarity([]string{"python"}, []string{"python", "python"})
	if !approxEqual(got, 1.0) {
		t.Fatalf("expected 1.0 (deduplicated match, not 2.0), got %v", got)
	}
	if got > 1.0 {
		t.Fatalf("similarity must never exceed 1.0, got %v", got)
	}
	if reason.SkillTagsMatched != 1 {
		t.Fatalf("expected deduplicated matched=1, got %d", reason.SkillTagsMatched)
	}
}

func TestScoreTagSimilarity_DuplicateTaskTagsDoNotChangeRequiredCount(t *testing.T) {
	got, reason := scoreTagSimilarity([]string{"python", "python", "nlp"}, []string{"python"})
	if reason.SkillTagsRequired != 2 {
		t.Fatalf("expected deduplicated SkillTagsRequired=2, got %d", reason.SkillTagsRequired)
	}
	// intersection {python} = 1, union {python, nlp} = 2
	if !approxEqual(got, 0.5) {
		t.Fatalf("expected 0.5, got %v", got)
	}
}

func TestScoreTagSimilarity_TaskHasNoTags(t *testing.T) {
	got, reason := scoreTagSimilarity([]string{}, []string{"anything"})
	if !approxEqual(got, 1.0) {
		t.Fatalf("expected 1.0 (vacuously satisfied), got %v", got)
	}
	if reason.Code != ReasonSkillTagNoRequirement {
		t.Fatalf("expected ReasonSkillTagNoRequirement, got %v", reason.Code)
	}
}

func TestResolveCompletionRate_NeutralPriorWhenNoSettledTasks(t *testing.T) {
	got := resolveCompletionRate(0, 0, 0.5)
	if !approxEqual(got, 0.5) {
		t.Fatalf("expected v0.1 neutral prior 0.5, got %v", got)
	}
}

func TestResolveCompletionRate_HistoricalWhenSettledTasksExist(t *testing.T) {
	got := resolveCompletionRate(10, 7, 0.5)
	if !approxEqual(got, 0.7) {
		t.Fatalf("expected 0.7, got %v", got)
	}
}

func TestResolveQualityScore_NeutralPriorWhenNil(t *testing.T) {
	got := resolveQualityScore(nil, 0.5)
	if !approxEqual(got, 0.5) {
		t.Fatalf("expected v0.1 neutral prior 0.5, got %v", got)
	}
}

func TestResolveQualityScore_HistoricalWhenPresent(t *testing.T) {
	q := 0.93
	got := resolveQualityScore(&q, 0.5)
	if !approxEqual(got, 0.93) {
		t.Fatalf("expected 0.93, got %v", got)
	}
}

// --- 3. Equal sub-score combinations produce bit-for-bit equal totals ---

func TestScore_EqualCombinationsProduceEqualScores(t *testing.T) {
	task := baseTask()
	task.SkillTags = []string{"python", "nlp"}

	// Candidate A: full tag overlap, no history (neutral priors for both).
	a := baseCandidate()
	a.AgentID = "candidate-a"
	a.SkillTags = []string{"python", "nlp"} // tagSimilarity = 1.0
	a.CompletedTaskCount = 0
	a.SuccessCount = 0   // completionRate -> prior 0.5
	a.QualityScore = nil // qualityScore -> prior 0.5

	// Candidate B: same tag overlap, but real history landing on exactly
	// the same 0.5/0.5 values as A's priors.
	b := baseCandidate()
	b.AgentID = "candidate-b"
	b.SkillTags = []string{"python", "nlp"} // tagSimilarity = 1.0
	b.CompletedTaskCount = 4
	b.SuccessCount = 2 // completionRate = 0.5
	qb := 0.5
	b.QualityScore = &qb // qualityScore = 0.5

	scoreA := mustScore(t, task, a).Score
	scoreB := mustScore(t, task, b).Score

	if scoreA != scoreB {
		t.Fatalf("expected bit-for-bit equal scores, got a=%v b=%v", scoreA, scoreB)
	}
}

// --- 4. ScoreAll is independent of input candidate order ---

func TestScoreAll_ResultIndependentOfInputOrder(t *testing.T) {
	task := baseTask()

	c1 := baseCandidate()
	c1.AgentID = "agent-1"
	c1.SkillTags = []string{"python"}

	c2 := baseCandidate()
	c2.AgentID = "agent-2"
	c2.CompletedTaskCount = 20
	c2.SuccessCount = 15

	c3 := baseCandidate()
	c3.AgentID = "agent-3"
	q := 0.42
	c3.QualityScore = &q

	orderOne := mustScoreAll(t, task, []domain.CandidateSnapshot{c1, c2, c3})
	orderTwo := mustScoreAll(t, task, []domain.CandidateSnapshot{c3, c1, c2})

	byIDOne := make(map[string]float64, len(orderOne))
	for _, r := range orderOne {
		byIDOne[r.AgentID] = r.Score
	}
	byIDTwo := make(map[string]float64, len(orderTwo))
	for _, r := range orderTwo {
		byIDTwo[r.AgentID] = r.Score
	}

	if len(byIDOne) != len(byIDTwo) {
		t.Fatalf("expected same candidate count, got %d vs %d", len(byIDOne), len(byIDTwo))
	}
	for id, score := range byIDOne {
		other, ok := byIDTwo[id]
		if !ok {
			t.Fatalf("agent %q missing from second-order result", id)
		}
		if score != other {
			t.Fatalf("agent %q score differs by input order: %v vs %v", id, score, other)
		}
	}
}

// --- 5. Empty candidates ---

func TestScoreAll_NilCandidatesReturnsEmptySlice(t *testing.T) {
	got := mustScoreAll(t, baseTask(), nil)
	if len(got) != 0 {
		t.Fatalf("expected empty slice, got %d results", len(got))
	}
}

func TestScoreAll_EmptyCandidatesReturnsEmptySlice(t *testing.T) {
	got := mustScoreAll(t, baseTask(), []domain.CandidateSnapshot{})
	if len(got) != 0 {
		t.Fatalf("expected empty slice, got %d results", len(got))
	}
}

// --- 6. This package does not re-check eligibility ---
//
// Whether a candidate is eligible at all (enabled status, category match,
// capacity, ban list, etc.) is exclusively the caller's responsibility —
// T-701's eligibility.Filter must run before any candidate reaches this
// package, and T-704's future orchestration code is the one required to
// call it. scoring itself performs no such check, so this test does NOT
// assert that scoring "rejects" an ineligible candidate (it never will —
// that would be testing behavior this package intentionally does not have).
// Instead it positively demonstrates the boundary: an obviously-ineligible
// candidate (Status == "INACTIVE") still gets a normal, non-error Score.
func TestScore_DoesNotRecheckEligibility(t *testing.T) {
	task := baseTask()
	c := baseCandidate()
	c.Status = "INACTIVE" // would be eliminated by eligibility.Filter condition 1

	result := mustScore(t, task, c)

	if len(result.Reasons) != 4 {
		t.Fatalf("expected 4 reasons even for an ineligible-looking candidate, got %d", len(result.Reasons))
	}
	// Same computation as an otherwise-identical ACTIVE candidate — Status
	// plays no role in the formula, proving scoring never inspects it.
	active := baseCandidate()
	active.Status = "ACTIVE"
	wantScore := mustScore(t, task, active).Score
	if result.Score != wantScore {
		t.Fatalf("expected Status to have no effect on Score, got %v want %v", result.Score, wantScore)
	}
}

// --- 7. Repeated calls are deterministic ---

func TestScore_RepeatedCallsAreIdentical(t *testing.T) {
	task := baseTask()
	c := baseCandidate()

	first := mustScore(t, task, c)
	second := mustScore(t, task, c)

	if first.Score != second.Score {
		t.Fatalf("expected identical scores across repeated calls, got %v vs %v", first.Score, second.Score)
	}
	if len(first.Reasons) != len(second.Reasons) {
		t.Fatalf("expected same reason count, got %d vs %d", len(first.Reasons), len(second.Reasons))
	}
	for i := range first.Reasons {
		if first.Reasons[i] != second.Reasons[i] {
			t.Fatalf("reason %d differs between calls: %+v vs %+v", i, first.Reasons[i], second.Reasons[i])
		}
	}
}

// --- 8. Immutability (AC-709) ---

func TestResolveQualityScore_DoesNotMutatePointerTarget(t *testing.T) {
	original := 0.77
	q := original

	_ = resolveQualityScore(&q, 0.5)

	if q != original {
		t.Fatalf("expected pointed-to value to remain %v, got %v", original, q)
	}
}

func TestScore_DoesNotMutateCandidateSnapshot(t *testing.T) {
	task := baseTask()
	q := 0.6
	c := baseCandidate()
	c.QualityScore = &q

	before := c // struct copy for comparison (Go value semantics)

	_ = mustScore(t, task, c)

	if c.AgentID != before.AgentID ||
		c.Status != before.Status ||
		c.CompletedTaskCount != before.CompletedTaskCount ||
		c.SuccessCount != before.SuccessCount ||
		c.QualityScore != before.QualityScore { // same pointer identity preserved
		t.Fatalf("expected CandidateSnapshot fields unchanged after Score, got %+v want %+v", c, before)
	}
	if *c.QualityScore != 0.6 {
		t.Fatalf("expected QualityScore pointed-to value to remain 0.6, got %v", *c.QualityScore)
	}
}

func TestScore_DoesNotMutateCandidateSnapshotWithNilQualityScore(t *testing.T) {
	task := baseTask()
	c := baseCandidate()
	c.QualityScore = nil

	_ = mustScore(t, task, c)

	if c.QualityScore != nil {
		t.Fatalf("expected QualityScore to remain nil, got %v", c.QualityScore)
	}
}

// --- 9. Unrecognized algorithmVersion fails loudly (Queen review during
// N4 prep: an earlier version of this package silently fell back to v0.1's
// weights for any unrecognized version string, which would have produced a
// plausible-looking but wrong score with no signal anything was off — the
// same "closed set, reject anything else" convention domain.ParseLevel
// already establishes) ---

func TestScore_ErrorsOnUnrecognizedAlgorithmVersion(t *testing.T) {
	task := baseTask()
	task.AlgorithmVersion = "v99.9"
	_, err := Score(task, baseCandidate())
	if err == nil {
		t.Fatal("expected an error for an unrecognized algorithmVersion, got nil")
	}
}

func TestScoreAll_ErrorsOnUnrecognizedAlgorithmVersion(t *testing.T) {
	task := baseTask()
	task.AlgorithmVersion = "v99.9"
	_, err := ScoreAll(task, []domain.CandidateSnapshot{baseCandidate()})
	if err == nil {
		t.Fatal("expected an error for an unrecognized algorithmVersion, got nil")
	}
}

// This is exactly the case Codex flagged in round 1 (P2): an empty
// candidate slice must not let a bad algorithmVersion slip through
// unnoticed just because the per-candidate loop body never runs.
func TestScoreAll_ErrorsOnUnrecognizedAlgorithmVersionEvenWithNoCandidates(t *testing.T) {
	task := baseTask()
	task.AlgorithmVersion = "v99.9"
	results, err := ScoreAll(task, nil)
	if err == nil {
		t.Fatal("expected an error for an unrecognized algorithmVersion even with zero candidates, got nil")
	}
	if results != nil {
		t.Fatalf("expected nil results alongside the error, got %v", results)
	}
}

func TestScoreAll_ReturnsNilResultsOnError(t *testing.T) {
	task := baseTask()
	task.AlgorithmVersion = "not-a-version"
	results, err := ScoreAll(task, []domain.CandidateSnapshot{baseCandidate()})
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if results != nil {
		t.Fatalf("expected nil results alongside the error, got %v", results)
	}
}

// --- ScoreV2 / ScoreAllV2 (Feature 13, T-1305) ---

func f(v float64) *float64 { return &v }

// allSignalsPresent is F-1308's five real signal values, all present — the
// baseline every single-signal test below starts from and deviates from in
// exactly one field, matching this file's existing baseCandidate()
// convention.
func allSignalsPresent() domain.ReputationSignals {
	return domain.ReputationSignals{
		CompletionRate:  f(0.9),
		QualityFeedback: f(0.8),
		Communication:   f(0.7),
		DisputeSignal:   f(1.0),
		HistoricalScale: f(0.5),
	}
}

// TestScoreV2_AllSignalsPresent_MatchesHandCalculatedWeightedAverage is
// AC-1304's "缺失值重新归一化的真实计算验证" positive counterpart: every
// signal present, so no renormalization applies — this is a plain F-1311
// weighted sum, checked against a value computed by hand from the exact
// same weights (0.30/0.30/0.15/0.20/0.05) and inputs above.
func TestScoreV2_AllSignalsPresent_MatchesHandCalculatedWeightedAverage(t *testing.T) {
	want := 0.9*0.30 + 0.8*0.30 + 0.7*0.15 + 1.0*0.20 + 0.5*0.05 // = 0.84
	got := ScoreV2("agent-1", allSignalsPresent())
	if math.Abs(got.Score-want) > 1e-6 {
		t.Fatalf("Score = %v, want %v", got.Score, want)
	}
	if len(got.Reasons) != 5 {
		t.Fatalf("expected 5 Reasons (one per present signal), got %d: %+v", len(got.Reasons), got.Reasons)
	}
}

// TestScoreV2_MissingCommunication_RenormalizesRemainingWeights is
// requirements.md F-1309's own worked example, reproduced exactly: with
// communication missing, the remaining four weights (0.30/0.30/0.20/0.05)
// sum to 0.85, and each is divided by 0.85 for the actual weighted average
// — this test computes that expected value independently (not by calling
// any of this package's own code a second time) and compares.
func TestScoreV2_MissingCommunication_RenormalizesRemainingWeights(t *testing.T) {
	signals := allSignalsPresent()
	signals.Communication = nil

	remainingWeightSum := 0.30 + 0.30 + 0.20 + 0.05 // 0.85, matches F-1309's own worked example
	want := (0.9*0.30 + 0.8*0.30 + 1.0*0.20 + 0.5*0.05) / remainingWeightSum

	got := ScoreV2("agent-1", signals)
	if math.Abs(got.Score-want) > 1e-6 {
		t.Fatalf("Score = %v, want %v", got.Score, want)
	}
	if len(got.Reasons) != 4 {
		t.Fatalf("expected 4 Reasons (communication excluded, not a neutral-prior placeholder), got %d: %+v", len(got.Reasons), got.Reasons)
	}
	for _, r := range got.Reasons {
		if r.Code == ReasonV2Communication {
			t.Fatalf("missing communication must not produce a Reason at all (F-1309 forbids substituting any value for it), got one: %+v", r)
		}
	}
}

// TestScoreV2_OnlyOneSignalPresent_EqualsThatSignalsRawValue: with every
// other signal missing, renormalization reduces to weight/weight = 1, so
// the final score must exactly equal the one present signal's own value —
// a sharper edge case than "one signal missing" (above).
func TestScoreV2_OnlyOneSignalPresent_EqualsThatSignalsRawValue(t *testing.T) {
	got := ScoreV2("agent-1", domain.ReputationSignals{HistoricalScale: f(0.42)})
	if math.Abs(got.Score-0.42) > 1e-6 {
		t.Fatalf("Score = %v, want 0.42 (the sole present signal's own value)", got.Score)
	}
	if len(got.Reasons) != 1 || got.Reasons[0].Code != ReasonV2HistoricalScale {
		t.Fatalf("expected exactly one ReasonV2HistoricalScale, got %+v", got.Reasons)
	}
}

// TestScoreV2_AllSignalsMissing_ScoresZeroWithNoHistoricalSampleReason is
// F-1309/F-1312's "无历史样本" case: never an error, Score is exactly 0 (so
// this candidate can never outrank one with real history in a TOP_SCORE
// slot — see ScoreV2's doc comment), and Reasons contains exactly the one
// dedicated code, not an empty slice and not any of the five per-signal
// codes.
func TestScoreV2_AllSignalsMissing_ScoresZeroWithNoHistoricalSampleReason(t *testing.T) {
	got := ScoreV2("agent-newcomer", domain.ReputationSignals{})
	if got.Score != 0 {
		t.Fatalf("Score = %v, want exactly 0", got.Score)
	}
	if len(got.Reasons) != 1 || got.Reasons[0].Code != ReasonV2NoHistoricalSample {
		t.Fatalf("expected exactly one ReasonV2NoHistoricalSample, got %+v", got.Reasons)
	}
	if got.AgentID != "agent-newcomer" {
		t.Fatalf("AgentID = %q, want %q", got.AgentID, "agent-newcomer")
	}
	if !got.NoHistoricalSample {
		t.Fatal("expected NoHistoricalSample to be true — slotting.Select relies on this to keep this candidate out of TOP_SCORE (F-1309/F-1312)")
	}
}

// TestScoreV2_NoHistoricalSampleFalseWhenAnySignalPresent: the
// NoHistoricalSample flag slotting.Select depends on must be false
// whenever ScoreV2 actually computed a real weighted average — even with
// only one signal present.
func TestScoreV2_NoHistoricalSampleFalseWhenAnySignalPresent(t *testing.T) {
	got := ScoreV2("agent-1", domain.ReputationSignals{HistoricalScale: f(0.5)})
	if got.NoHistoricalSample {
		t.Fatal("expected NoHistoricalSample to be false when at least one signal is present")
	}
}

// TestScore_NoHistoricalSampleAlwaysFalse: v0.1's Score never sets this
// field — it's a v0.2-only concept — so it must stay Go's zero value
// (false) for every v0.1 result, regardless of input.
func TestScore_NoHistoricalSampleAlwaysFalse(t *testing.T) {
	result := mustScore(t, baseTask(), baseCandidate())
	if result.NoHistoricalSample {
		t.Fatal("expected v0.1's Score to never set NoHistoricalSample")
	}
}

// TestScoreV2_ReasonsFollowFixedFieldOrder pins AC-1306's reproducibility
// down to the Reasons slice's own order, independent of which signals
// happen to be present: completionRate, qualityFeedback, communication,
// disputeSignal, historicalScale — never any other order.
func TestScoreV2_ReasonsFollowFixedFieldOrder(t *testing.T) {
	got := ScoreV2("agent-1", allSignalsPresent())
	wantOrder := []ReasonCode{
		ReasonV2CompletionRate,
		ReasonV2QualityFeedback,
		ReasonV2Communication,
		ReasonV2DisputeSignal,
		ReasonV2HistoricalScale,
	}
	if len(got.Reasons) != len(wantOrder) {
		t.Fatalf("expected %d Reasons, got %d: %+v", len(wantOrder), len(got.Reasons), got.Reasons)
	}
	for i, code := range wantOrder {
		if got.Reasons[i].Code != code {
			t.Fatalf("Reasons[%d].Code = %q, want %q", i, got.Reasons[i].Code, code)
		}
	}
}

// TestScoreV2_RepeatedCallsAreIdentical mirrors TestScore_RepeatedCallsAreIdentical
// (AC-1306): the same input must produce byte-identical output every time.
func TestScoreV2_RepeatedCallsAreIdentical(t *testing.T) {
	signals := allSignalsPresent()
	first := ScoreV2("agent-1", signals)
	second := ScoreV2("agent-1", signals)
	if first.Score != second.Score {
		t.Fatalf("Score differs across identical calls: %v vs %v", first.Score, second.Score)
	}
	if len(first.Reasons) != len(second.Reasons) {
		t.Fatalf("Reasons length differs across identical calls: %d vs %d", len(first.Reasons), len(second.Reasons))
	}
}

// TestScoreV2_DoesNotMutateInputPointers mirrors
// TestResolveQualityScore_DoesNotMutatePointerTarget — ScoreV2 only
// dereferences signals' pointers to read them, never writes through any of
// them.
func TestScoreV2_DoesNotMutateInputPointers(t *testing.T) {
	completion := 0.6
	signals := domain.ReputationSignals{CompletionRate: &completion}
	_ = ScoreV2("agent-1", signals)
	if completion != 0.6 {
		t.Fatalf("ScoreV2 mutated the caller's CompletionRate pointer target: got %v, want 0.6", completion)
	}
}

// TestScoreAllV2_OrderMatchesInput mirrors TestScoreAll_ResultIndependentOfInputOrder's
// core guarantee for the v0.2 path: scored[i] is always candidates[i]'s
// result, read from that same candidate's own ReputationSignals field —
// not looked up via any second, separately-ordered structure.
func TestScoreAllV2_OrderMatchesInput(t *testing.T) {
	candidates := []domain.CandidateSnapshot{
		{AgentID: "agent-a", ReputationSignals: domain.ReputationSignals{HistoricalScale: f(0.1)}},
		{AgentID: "agent-b", ReputationSignals: domain.ReputationSignals{HistoricalScale: f(0.9)}},
		{AgentID: "agent-c", ReputationSignals: domain.ReputationSignals{HistoricalScale: f(0.5)}},
	}
	results := ScoreAllV2(candidates)
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}
	wantAgentIDs := []string{"agent-a", "agent-b", "agent-c"}
	wantScores := []float64{0.1, 0.9, 0.5}
	for i := range results {
		if results[i].AgentID != wantAgentIDs[i] {
			t.Fatalf("results[%d].AgentID = %q, want %q", i, results[i].AgentID, wantAgentIDs[i])
		}
		if math.Abs(results[i].Score-wantScores[i]) > 1e-6 {
			t.Fatalf("results[%d].Score = %v, want %v", i, results[i].Score, wantScores[i])
		}
	}
}

// TestScoreAllV2_DuplicateAgentIDsScoreIndependently is the direct
// regression for the Codex round 1 P2 finding: an earlier version of this
// function took a second, AgentID-keyed map parameter, which silently
// merged/overwrote two candidate snapshots sharing one AgentID (a shape
// this project explicitly allows — see CandidateSnapshot.ReputationSignals'
// own doc comment). Reading ReputationSignals directly off each
// CandidateSnapshot makes that impossible: two entries with the same
// AgentID but different signals must each score using their OWN data.
func TestScoreAllV2_DuplicateAgentIDsScoreIndependently(t *testing.T) {
	candidates := []domain.CandidateSnapshot{
		{AgentID: "agent-dup", ReputationSignals: domain.ReputationSignals{HistoricalScale: f(0.2)}},
		{AgentID: "agent-dup", ReputationSignals: domain.ReputationSignals{HistoricalScale: f(0.8)}},
	}
	results := ScoreAllV2(candidates)
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if math.Abs(results[0].Score-0.2) > 1e-6 {
		t.Fatalf("results[0].Score = %v, want 0.2 (this candidate's own signal, not the other duplicate's)", results[0].Score)
	}
	if math.Abs(results[1].Score-0.8) > 1e-6 {
		t.Fatalf("results[1].Score = %v, want 0.8 (this candidate's own signal, not the other duplicate's)", results[1].Score)
	}
}

// TestScoreAllV2_ZeroValueReputationSignalsIsNoHistoricalSample: a
// candidate whose ReputationSignals was never set (Go's natural zero
// value — every field nil) must score identically to ScoreV2's own
// documented "no historical sample" case, not error or panic.
func TestScoreAllV2_ZeroValueReputationSignalsIsNoHistoricalSample(t *testing.T) {
	candidates := []domain.CandidateSnapshot{{AgentID: "agent-unlisted"}}
	results := ScoreAllV2(candidates)
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Score != 0 || len(results[0].Reasons) != 1 || results[0].Reasons[0].Code != ReasonV2NoHistoricalSample {
		t.Fatalf("expected the 'no historical sample' outcome, got %+v", results[0])
	}
}
