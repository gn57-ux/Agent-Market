package slotting

import (
	"strconv"
	"testing"

	"github.com/agent-market/dispatch/internal/scoring"
)

// candidate builds a minimal ScoredCandidate fixture: agentID identifies the
// candidate, score is its scoring.ScoreResult.Score, completedTaskCount
// drives the newcomer judgment. Reasons are left empty since slotting never
// inspects them (it only passes them through). ExcludeFromTopScore is
// always false — see excludedCandidate for the v0.2 "no historical sample"
// fixture.
func candidate(agentID string, score float64, completedTaskCount int) ScoredCandidate {
	return ScoredCandidate{
		Result: scoring.ScoreResult{
			AgentID: agentID,
			Score:   score,
			Reasons: []scoring.Reason{{Code: scoring.ReasonCategoryExactMatch, NormalizedValue: 1.0}},
		},
		CompletedTaskCount: completedTaskCount,
	}
}

// excludedCandidate builds a ScoredCandidate with ExcludeFromTopScore set —
// F-1309/F-1312's "no historical sample" v0.2 shape (Score 0,
// NoHistoricalSample true, CompletedTaskCount 0, which also makes it a
// domain.IsNewcomer newcomer-pool member).
func excludedCandidate(agentID string) ScoredCandidate {
	return ScoredCandidate{
		Result: scoring.ScoreResult{
			AgentID:            agentID,
			Score:              0,
			Reasons:            []scoring.Reason{{Code: scoring.ReasonV2NoHistoricalSample}},
			NoHistoricalSample: true,
		},
		CompletedTaskCount:  0,
		ExcludeFromTopScore: true,
	}
}

func agentIDs(slots []Slot) []string {
	ids := make([]string, len(slots))
	for i, s := range slots {
		ids[i] = s.AgentID
	}
	return ids
}

func TestSelect_ZeroCandidates(t *testing.T) {
	slots := Select("task-1", "v0.1", nil)
	if len(slots) != 0 {
		t.Fatalf("expected no slots for zero candidates, got %d", len(slots))
	}
}

func TestSelect_OneCandidate(t *testing.T) {
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.9, 10),
	})
	if len(slots) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots))
	}
	if slots[0].SlotType != SlotTypeTopScore || slots[0].Rank != 1 || slots[0].AgentID != "agent-a" {
		t.Fatalf("unexpected slot: %+v", slots[0])
	}
}

func TestSelect_TwoCandidates(t *testing.T) {
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.9, 10),
		candidate("agent-b", 0.8, 10),
	})
	if len(slots) != 2 {
		t.Fatalf("expected 2 slots, got %d", len(slots))
	}
	for i, s := range slots {
		if s.SlotType != SlotTypeTopScore {
			t.Errorf("slot %d: expected TOP_SCORE, got %s", i, s.SlotType)
		}
		if s.Rank != i+1 {
			t.Errorf("slot %d: expected rank %d, got %d", i, i+1, s.Rank)
		}
	}
	if slots[0].AgentID != "agent-a" || slots[1].AgentID != "agent-b" {
		t.Fatalf("unexpected order: %v", agentIDs(slots))
	}
}

func TestSelect_ThreeCandidates_NewcomerPoolNonEmpty(t *testing.T) {
	// agent-c is the only candidate outside the top two, and it's a
	// newcomer (CompletedTaskCount < 5), so it must be the exploration pick.
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.9, 10),
		candidate("agent-b", 0.8, 10),
		candidate("agent-c", 0.7, 2),
	})
	if len(slots) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(slots))
	}
	if slots[2].SlotType != SlotTypeExploration || slots[2].Rank != 3 {
		t.Fatalf("unexpected exploration slot: %+v", slots[2])
	}
	if slots[2].AgentID != "agent-c" {
		t.Fatalf("expected exploration pick from newcomer pool (agent-c), got %s", slots[2].AgentID)
	}
}

func TestSelect_FourPlusCandidates_ExplorationChosenFromNewcomerPoolOnly(t *testing.T) {
	// agent-c and agent-e (outside top two) are newcomers; agent-d is not.
	// The exploration pick must come from {agent-c, agent-e}, never agent-d.
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.9, 10), // top score
		candidate("agent-b", 0.8, 10), // top score
		candidate("agent-c", 0.7, 1),  // newcomer, in pool
		candidate("agent-d", 0.6, 20), // not a newcomer, excluded from pool
		candidate("agent-e", 0.5, 3),  // newcomer, in pool
	})
	if len(slots) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(slots))
	}
	pick := slots[2].AgentID
	if pick != "agent-c" && pick != "agent-e" {
		t.Fatalf("exploration pick %q must come from the newcomer pool {agent-c, agent-e}", pick)
	}
	if slots[2].SlotType != SlotTypeExploration {
		t.Fatalf("expected EXPLORATION slot type, got %s", slots[2].SlotType)
	}
}

func TestSelect_NewcomerPoolEmpty_FallsBackToNextHighestScore(t *testing.T) {
	// No candidate outside the top two is a newcomer: the exploration slot
	// must fall back to the overall third-highest score (agent-c), and
	// still be typed EXPLORATION, not a second TOP_SCORE.
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.9, 10),
		candidate("agent-b", 0.8, 10),
		candidate("agent-c", 0.7, 20),
		candidate("agent-d", 0.6, 30),
	})
	if len(slots) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(slots))
	}
	if slots[2].AgentID != "agent-c" {
		t.Fatalf("expected fallback pick to be the next-highest score (agent-c), got %s", slots[2].AgentID)
	}
	if slots[2].SlotType != SlotTypeExploration {
		t.Fatalf("fallback pick must still be typed EXPLORATION, got %s", slots[2].SlotType)
	}
}

func TestSelect_TieBreakByAgentIDAscending(t *testing.T) {
	// All three candidates tie on score; sort must break ties by AgentID
	// ascending, independent of input order.
	tests := [][]ScoredCandidate{
		{candidate("agent-z", 0.5, 10), candidate("agent-a", 0.5, 10), candidate("agent-m", 0.5, 10)},
		{candidate("agent-a", 0.5, 10), candidate("agent-m", 0.5, 10), candidate("agent-z", 0.5, 10)},
		{candidate("agent-m", 0.5, 10), candidate("agent-z", 0.5, 10), candidate("agent-a", 0.5, 10)},
	}
	want := []string{"agent-a", "agent-m", "agent-z"}
	for i, in := range tests {
		slots := Select("task-1", "v0.1", in)
		got := []string{slots[0].AgentID, slots[1].AgentID, slots[2].AgentID}
		for j := range want {
			if got[j] != want[j] {
				t.Fatalf("input order %d: expected agentID order %v, got %v", i, want, got)
			}
		}
	}
}

func TestSelect_Deterministic_SameTaskAndVersionReproduceSamePick(t *testing.T) {
	build := func() []ScoredCandidate {
		return []ScoredCandidate{
			candidate("agent-a", 0.9, 10),
			candidate("agent-b", 0.8, 10),
			candidate("agent-c", 0.7, 1),
			candidate("agent-d", 0.6, 2),
			candidate("agent-e", 0.5, 3),
		}
	}

	first := Select("task-42", "v0.1", build())
	for i := 0; i < 10; i++ {
		again := Select("task-42", "v0.1", build())
		if again[2].AgentID != first[2].AgentID {
			t.Fatalf("exploration pick not reproducible: run 0 picked %s, run %d picked %s", first[2].AgentID, i+1, again[2].AgentID)
		}
	}
}

func TestSelect_DifferentTaskIDs_SeedVariesTheChoice(t *testing.T) {
	build := func() []ScoredCandidate {
		return []ScoredCandidate{
			candidate("agent-a", 0.9, 10),
			candidate("agent-b", 0.8, 10),
			candidate("agent-c", 0.7, 1),
			candidate("agent-d", 0.6, 2),
			candidate("agent-e", 0.5, 3),
		}
	}

	picks := make(map[string]bool)
	for i := 0; i < 50; i++ {
		taskID := "task-" + strconv.Itoa(i)
		slots := Select(taskID, "v0.1", build())
		picks[slots[2].AgentID] = true
	}
	if len(picks) < 2 {
		t.Fatalf("expected the deterministic seed to vary the exploration pick across different taskIDs, got only %v", picks)
	}
}

func TestSelect_NoDuplicateAgentIDsAcrossSlots(t *testing.T) {
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.9, 10),
		candidate("agent-b", 0.8, 10),
		candidate("agent-c", 0.7, 1),
		candidate("agent-d", 0.6, 2),
	})
	seen := make(map[string]bool)
	for _, s := range slots {
		if seen[s.AgentID] {
			t.Fatalf("duplicate AgentID %q across slots: %v", s.AgentID, agentIDs(slots))
		}
		seen[s.AgentID] = true
	}
}

// Regression for Codex round 1 P2: the input itself (not just the
// already-deduplicated top-two exclusion) can contain the same AgentID
// twice — e.g. a duplicate scoring result from a caller bug. Select must
// still never place that AgentID into two slots, and must not let a
// literal duplicate entry silently consume two rank positions.
func TestSelect_DuplicateAgentIDInInput_KeepsOnlyHighestScoringOccurrence(t *testing.T) {
	slots := Select("task-1", "v0.1", []ScoredCandidate{
		candidate("agent-a", 0.95, 10), // higher-scoring duplicate, kept
		candidate("agent-a", 0.50, 10), // lower-scoring duplicate, discarded
		candidate("agent-b", 0.80, 10),
		candidate("agent-c", 0.70, 1),
	})

	seen := make(map[string]bool)
	for _, s := range slots {
		if seen[s.AgentID] {
			t.Fatalf("duplicate AgentID %q across slots: %v", s.AgentID, agentIDs(slots))
		}
		seen[s.AgentID] = true
	}

	if len(slots) == 0 || slots[0].AgentID != "agent-a" || slots[0].Score != 0.95 {
		t.Fatalf("expected rank 1 to be agent-a's higher-scoring occurrence (0.95), got %+v", slots)
	}
}

// --- ExcludeFromTopScore (Feature 13, T-1304 round 2 fix, F-1309/F-1312) ---

// TestSelect_ExcludedCandidateAlone_GetsExplorationNotTopScore is the exact
// scenario Codex's round 2 review caught: with fewer than 3 total
// candidates, the OLD logic (topCount = min(2, len(sorted))) would have
// unconditionally placed this lone candidate into a TOP_SCORE slot despite
// its Score of 0 and ExcludeFromTopScore — F-1309/F-1312 require it to be
// routed through the exploration mechanism instead, never ranked.
func TestSelect_ExcludedCandidateAlone_GetsExplorationNotTopScore(t *testing.T) {
	slots := Select("task-1", "v0.2", []ScoredCandidate{excludedCandidate("agent-nosample")})
	if len(slots) != 1 {
		t.Fatalf("expected 1 slot, got %d", len(slots))
	}
	if slots[0].SlotType != SlotTypeExploration {
		t.Fatalf("expected EXPLORATION, got %s", slots[0].SlotType)
	}
	if slots[0].Rank != 1 {
		t.Fatalf("expected rank 1 (the only slot), got %d", slots[0].Rank)
	}
	if slots[0].AgentID != "agent-nosample" {
		t.Fatalf("expected agent-nosample, got %s", slots[0].AgentID)
	}
}

// TestSelect_ExcludedCandidatesFillMostOfSmallPool_TopScoreOnlyTheEligibleOne:
// two excluded candidates plus one normal, eligible candidate (which
// out-scores both, but that's not what's being tested — even a LOW real
// score must still win TOP_SCORE over an excluded candidate's Score-0).
func TestSelect_ExcludedCandidatesFillMostOfSmallPool_TopScoreOnlyTheEligibleOne(t *testing.T) {
	slots := Select("task-1", "v0.2", []ScoredCandidate{
		excludedCandidate("agent-nosample-1"),
		candidate("agent-real", 0.1, 10), // low real score, but not excluded
		excludedCandidate("agent-nosample-2"),
	})
	if len(slots) != 2 {
		t.Fatalf("expected 2 slots (one TOP_SCORE, one EXPLORATION), got %d: %+v", len(slots), slots)
	}
	if slots[0].SlotType != SlotTypeTopScore || slots[0].AgentID != "agent-real" || slots[0].Rank != 1 {
		t.Fatalf("expected rank 1 TOP_SCORE to be agent-real (the only non-excluded candidate), got %+v", slots[0])
	}
	if slots[1].SlotType != SlotTypeExploration || slots[1].Rank != 2 {
		t.Fatalf("expected rank 2 EXPLORATION, got %+v", slots[1])
	}
	if slots[1].AgentID != "agent-nosample-1" && slots[1].AgentID != "agent-nosample-2" {
		t.Fatalf("expected the exploration pick to be one of the excluded candidates, got %s", slots[1].AgentID)
	}
}

// TestSelect_ThreePlusCandidatesWithExcluded_TopScoreSkipsExcludedByScore:
// with enough candidates that TOP_SCORE would normally be filled by rank
// alone, an excluded candidate that WOULD have scored into the top two
// (equal or higher Score than a genuine candidate) must still be skipped —
// proving exclusion is enforced independent of score comparison, not just
// "Score 0 sorts last."
func TestSelect_ThreePlusCandidatesWithExcluded_TopScoreSkipsExcludedByScore(t *testing.T) {
	high := excludedCandidate("agent-excluded-high")
	high.Result.Score = 0.99 // would rank #1 by score alone if not excluded
	slots := Select("task-1", "v0.2", []ScoredCandidate{
		high,
		candidate("agent-a", 0.9, 10),
		candidate("agent-b", 0.8, 10),
		candidate("agent-c", 0.7, 10),
	})
	for _, s := range slots {
		if s.SlotType == SlotTypeTopScore && s.AgentID == "agent-excluded-high" {
			t.Fatalf("agent-excluded-high must never win a TOP_SCORE slot despite its high Score, got slots: %+v", slots)
		}
	}
	if len(slots) < 2 || slots[0].AgentID != "agent-a" || slots[1].AgentID != "agent-b" {
		t.Fatalf("expected TOP_SCORE ranks 1-2 to be agent-a, agent-b (the highest-scoring non-excluded candidates), got %+v", slots)
	}
}

// TestSelect_ExcludeFromTopScore_DoesNotAffectV01Candidates: candidate()
// never sets ExcludeFromTopScore (Go's zero value, false), so every
// existing test above this section — all of them "v0.1" calls — already
// proves this field changes nothing when it's never set. This test makes
// that guarantee explicit and named, rather than leaving it merely implied.
func TestSelect_ExcludeFromTopScore_DoesNotAffectV01Candidates(t *testing.T) {
	build := func() []ScoredCandidate {
		return []ScoredCandidate{
			candidate("agent-a", 0.9, 10),
			candidate("agent-b", 0.8, 10),
			candidate("agent-c", 0.7, 2),
		}
	}
	withoutExclusion := Select("task-1", "v0.1", build())
	if len(withoutExclusion) != 3 {
		t.Fatalf("expected 3 slots, got %d", len(withoutExclusion))
	}
	if withoutExclusion[0].AgentID != "agent-a" || withoutExclusion[1].AgentID != "agent-b" || withoutExclusion[2].AgentID != "agent-c" {
		t.Fatalf("unexpected slot assignment: %v", agentIDs(withoutExclusion))
	}
}
