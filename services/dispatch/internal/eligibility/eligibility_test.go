package eligibility

import (
	"testing"
	"time"

	"github.com/agent-market/dispatch/internal/domain"
)

// baseTask and baseCandidate are the "everything satisfied" fixtures every
// single-condition test case starts from and then deviates from in exactly
// one field, so a failing test unambiguously points at the one condition it
// violates.
func baseTask() domain.TaskFeatures {
	return domain.TaskFeatures{
		TaskID:           "task-1",
		Category:         "data-labeling",
		SkillTags:        []string{"python", "nlp"},
		DeliveryDeadline: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		RequiredLevel:    domain.LevelIntermediate,
		RequesterAddress: "0x1111111111111111111111111111111111111111"[:42],
		AlgorithmVersion: "v0",
	}
}

func baseCandidate() domain.CandidateSnapshot {
	return domain.CandidateSnapshot{
		AgentID:            "agent-1",
		WalletAddress:      "0x2222222222222222222222222222222222222222"[:42],
		Status:             "ACTIVE",
		Category:           "data-labeling",
		SkillTags:          []string{"nlp", "labeling"},
		Level:              domain.LevelExpert,
		MaxConcurrentTasks: 3,
		ActiveTaskCount:    1,
		CompletedTaskCount: 10,
		SuccessCount:       9,
		OverdueCount:       1,
		QualityScore:       nil,
		CreatedAt:          time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		IsNewcomer:         false,
		IsBanned:           false,
	}
}

func mustEligible(t *testing.T, task domain.TaskFeatures, candidate domain.CandidateSnapshot) {
	t.Helper()
	result := Filter(task, []domain.CandidateSnapshot{candidate})
	if len(result) != 1 {
		t.Fatalf("expected candidate to pass, got %d eligible (want 1)", len(result))
	}
}

func mustEliminated(t *testing.T, task domain.TaskFeatures, candidate domain.CandidateSnapshot) {
	t.Helper()
	result := Filter(task, []domain.CandidateSnapshot{candidate})
	if len(result) != 0 {
		t.Fatalf("expected candidate to be eliminated, got %d eligible (want 0)", len(result))
	}
}

func TestFilter_SanityBaseline(t *testing.T) {
	// A candidate satisfying all seven conditions must be selected.
	mustEligible(t, baseTask(), baseCandidate())
}

// --- Condition 1: enabled status ---

func TestFilter_Status_PositiveWhenActive(t *testing.T) {
	c := baseCandidate()
	c.Status = "ACTIVE"
	mustEligible(t, baseTask(), c)
}

func TestFilter_Status_NegativeWhenInactive(t *testing.T) {
	c := baseCandidate()
	c.Status = "INACTIVE"
	mustEliminated(t, baseTask(), c)
}

// --- Condition 2: category compatibility ---

func TestFilter_Category_PositiveWhenExactMatch(t *testing.T) {
	task := baseTask()
	task.Category = "translation"
	c := baseCandidate()
	c.Category = "translation"
	mustEligible(t, task, c)
}

func TestFilter_Category_NegativeWhenMismatch(t *testing.T) {
	c := baseCandidate()
	c.Category = "translation" // task stays "data-labeling"
	mustEliminated(t, baseTask(), c)
}

// --- Condition 3: skill tag overlap (at-least-one, documented assumption) ---

func TestFilter_SkillTags_PositiveWhenOneOverlaps(t *testing.T) {
	task := baseTask()
	task.SkillTags = []string{"python", "nlp"}
	c := baseCandidate()
	c.SkillTags = []string{"nlp"} // only one of the two required tags, still eligible
	mustEligible(t, task, c)
}

func TestFilter_SkillTags_PositiveWhenCaseDiffers(t *testing.T) {
	task := baseTask()
	task.SkillTags = []string{"python"}
	c := baseCandidate()
	c.SkillTags = []string{"Python"}
	mustEligible(t, task, c)
}

func TestFilter_SkillTags_NegativeWhenNoOverlap(t *testing.T) {
	task := baseTask()
	task.SkillTags = []string{"python", "nlp"}
	c := baseCandidate()
	c.SkillTags = []string{"design", "illustration"}
	mustEliminated(t, task, c)
}

func TestFilter_SkillTags_PositiveWhenTaskHasNoTags(t *testing.T) {
	// A task declaring no required skill tags requires nothing — the
	// condition is vacuously satisfied for every candidate, matching how an
	// empty/absent filter means "no filter applied" elsewhere in this
	// project (documented in skillTagsOverlap).
	task := baseTask()
	task.SkillTags = []string{}
	c := baseCandidate()
	mustEligible(t, task, c)
}

func TestFilter_SkillTags_NegativeWhenTaskHasTagsButCandidateHasNone(t *testing.T) {
	// The asymmetric case: task requires specific tags, but the candidate
	// has declared none at all — a genuine non-match, not vacuous.
	task := baseTask()
	task.SkillTags = []string{"python", "nlp"}
	c := baseCandidate()
	c.SkillTags = []string{}
	mustEliminated(t, task, c)
}

// --- Condition 4: level satisfies ---

func TestFilter_Level_PositiveWhenExceedsRequired(t *testing.T) {
	task := baseTask()
	task.RequiredLevel = domain.LevelIntermediate
	c := baseCandidate()
	c.Level = domain.LevelExpert
	mustEligible(t, task, c)
}

func TestFilter_Level_PositiveWhenExactlyEqual(t *testing.T) {
	task := baseTask()
	task.RequiredLevel = domain.LevelIntermediate
	c := baseCandidate()
	c.Level = domain.LevelIntermediate
	mustEligible(t, task, c)
}

func TestFilter_Level_NegativeWhenBelowRequired(t *testing.T) {
	task := baseTask()
	task.RequiredLevel = domain.LevelExpert
	c := baseCandidate()
	c.Level = domain.LevelIntermediate
	mustEliminated(t, task, c)
}

// --- Condition 5: capacity ---

func TestFilter_Capacity_PositiveWhenUnderLimit(t *testing.T) {
	c := baseCandidate()
	c.MaxConcurrentTasks = 3
	c.ActiveTaskCount = 2
	mustEligible(t, baseTask(), c)
}

func TestFilter_Capacity_NegativeWhenAtLimit(t *testing.T) {
	c := baseCandidate()
	c.MaxConcurrentTasks = 3
	c.ActiveTaskCount = 3
	mustEliminated(t, baseTask(), c)
}

func TestFilter_Capacity_NegativeWhenOverLimit(t *testing.T) {
	c := baseCandidate()
	c.MaxConcurrentTasks = 3
	c.ActiveTaskCount = 4
	mustEliminated(t, baseTask(), c)
}

// --- Condition 6: self-acceptance ban (agent wallet != requester wallet) ---

func TestFilter_SelfAcceptance_PositiveWhenDifferentWallets(t *testing.T) {
	task := baseTask()
	task.RequesterAddress = "0x3333333333333333333333333333333333333333"[:42]
	c := baseCandidate()
	c.WalletAddress = "0x4444444444444444444444444444444444444444"[:42]
	mustEligible(t, task, c)
}

func TestFilter_SelfAcceptance_NegativeWhenSameWallet(t *testing.T) {
	task := baseTask()
	task.RequesterAddress = "0x5555555555555555555555555555555555555555"[:42]
	c := baseCandidate()
	c.WalletAddress = "0x5555555555555555555555555555555555555555"[:42]
	mustEliminated(t, task, c)
}

func TestFilter_SelfAcceptance_NegativeWhenSameWalletDifferentCase(t *testing.T) {
	// Defensive case-insensitive comparison even though both sides are
	// expected to already be lowercase-normalized upstream.
	task := baseTask()
	task.RequesterAddress = "0x6666666666666666666666666666666666666666"[:42]
	c := baseCandidate()
	c.WalletAddress = "0X6666666666666666666666666666666666666666"[:42]
	mustEliminated(t, task, c)
}

// --- Condition 7: wallet format valid and not banned ---

func TestFilter_WalletFormat_PositiveWhenValidAndNotBanned(t *testing.T) {
	c := baseCandidate()
	c.WalletAddress = "0x7777777777777777777777777777777777777777"[:42]
	c.IsBanned = false
	mustEligible(t, baseTask(), c)
}

func TestFilter_WalletFormat_NegativeWhenMalformed(t *testing.T) {
	c := baseCandidate()
	c.WalletAddress = "not-a-wallet-address"
	mustEliminated(t, baseTask(), c)
}

func TestFilter_WalletFormat_NegativeWhenWrongLength(t *testing.T) {
	c := baseCandidate()
	c.WalletAddress = "0x12345" // too short: not 40 hex digits
	mustEliminated(t, baseTask(), c)
}

func TestFilter_WalletFormat_NegativeWhenUppercaseHex(t *testing.T) {
	// The format regex mirrors the database CHECK constraint, which only
	// accepts lowercase hex; an uppercase-containing address fails format
	// validation even though it isn't banned.
	c := baseCandidate()
	c.WalletAddress = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"[:42]
	c.IsBanned = false
	mustEliminated(t, baseTask(), c)
}

func TestFilter_Banned_NegativeWhenBanned(t *testing.T) {
	c := baseCandidate()
	c.WalletAddress = "0x8888888888888888888888888888888888888888"[:42]
	c.IsBanned = true
	mustEliminated(t, baseTask(), c)
}

// --- Mixed candidates: verify Filter returns exactly the expected subset ---

func TestFilter_MixedCandidates_ReturnsExactSubset(t *testing.T) {
	task := baseTask()

	eligibleOne := baseCandidate()
	eligibleOne.AgentID = "eligible-one"
	eligibleOne.WalletAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"[:42]

	eligibleTwo := baseCandidate()
	eligibleTwo.AgentID = "eligible-two"
	eligibleTwo.WalletAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"[:42]
	eligibleTwo.Level = domain.LevelExpert // still satisfies IntermediateLevel requirement

	inactiveCandidate := baseCandidate()
	inactiveCandidate.AgentID = "inactive"
	inactiveCandidate.WalletAddress = "0xcccccccccccccccccccccccccccccccccccccccc"[:42]
	inactiveCandidate.Status = "INACTIVE"

	wrongCategoryCandidate := baseCandidate()
	wrongCategoryCandidate.AgentID = "wrong-category"
	wrongCategoryCandidate.WalletAddress = "0xdddddddddddddddddddddddddddddddddddddddd"[:42]
	wrongCategoryCandidate.Category = "translation"

	overCapacityCandidate := baseCandidate()
	overCapacityCandidate.AgentID = "over-capacity"
	overCapacityCandidate.WalletAddress = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"[:42]
	overCapacityCandidate.MaxConcurrentTasks = 2
	overCapacityCandidate.ActiveTaskCount = 2

	bannedCandidate := baseCandidate()
	bannedCandidate.AgentID = "banned"
	bannedCandidate.WalletAddress = "0xffffffffffffffffffffffffffffffffffffffff"[:42]
	bannedCandidate.IsBanned = true

	selfCandidate := baseCandidate()
	selfCandidate.AgentID = "self-requester"
	selfCandidate.WalletAddress = task.RequesterAddress

	candidates := []domain.CandidateSnapshot{
		eligibleOne,
		inactiveCandidate,
		wrongCategoryCandidate,
		eligibleTwo,
		overCapacityCandidate,
		bannedCandidate,
		selfCandidate,
	}

	result := Filter(task, candidates)

	gotIDs := make(map[string]bool, len(result))
	for _, r := range result {
		gotIDs[r.AgentID] = true
	}

	wantIDs := map[string]bool{
		"eligible-one": true,
		"eligible-two": true,
	}

	if len(gotIDs) != len(wantIDs) {
		t.Fatalf("expected %d eligible candidates, got %d (%v)", len(wantIDs), len(gotIDs), gotIDs)
	}
	for id := range wantIDs {
		if !gotIDs[id] {
			t.Errorf("expected %q to be eligible, but it was eliminated", id)
		}
	}
	for id := range gotIDs {
		if !wantIDs[id] {
			t.Errorf("expected %q to be eliminated, but it was returned as eligible", id)
		}
	}
}
