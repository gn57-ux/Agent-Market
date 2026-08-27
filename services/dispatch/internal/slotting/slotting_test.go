package slotting

import (
	"strconv"
	"testing"

	"github.com/agent-market/dispatch/internal/scoring"
)

// candidate builds a minimal ScoredCandidate fixture: agentID identifies the
// candidate, score is its scoring.ScoreResult.Score, completedTaskCount
// drives the newcomer judgment. Reasons are left empty since slotting never
// inspects them (it only passes them through).
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
