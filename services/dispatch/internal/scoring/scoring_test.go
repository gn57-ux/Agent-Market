package scoring

import (
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
