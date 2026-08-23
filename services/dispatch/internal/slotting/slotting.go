// Package slotting implements F-704's slot selection (PRD §9.4): turning a
// scored, eligible candidate list into up to three ranked slots — the top
// two TOP_SCORE candidates plus one EXPLORATION candidate drawn
// deterministically from the newcomer pool. It is the sole place in this
// project responsible for sorting scored candidates (T-701's eligibility
// and T-702's scoring packages both explicitly leave ordering to this
// package) and for the newcomer-pool exploration pick.
//
// This package has no database/HTTP dependency; it consumes
// scoring.ScoreResult values (already computed by internal/scoring) plus
// each candidate's CompletedTaskCount, and decides newcomer status itself
// via domain.IsNewcomer — it never trusts an externally supplied
// IsNewcomer-shaped field (see domain.IsNewcomer's doc comment for why).
package slotting

import (
	"hash/fnv"
	"sort"

	"github.com/agent-market/dispatch/internal/domain"
	"github.com/agent-market/dispatch/internal/scoring"
)

// SlotType distinguishes a top-scoring slot from the exploration slot.
type SlotType string

const (
	SlotTypeTopScore    SlotType = "TOP_SCORE"
	SlotTypeExploration SlotType = "EXPLORATION"
)

// Slot is one selected candidate's dispatch outcome.
type Slot struct {
	AgentID  string
	Rank     int // 1-based
	SlotType SlotType
	Score    float64
	Reasons  []scoring.Reason // passed through from scoring verbatim; explain converts these to text, not this package
}

// ScoredCandidate binds one candidate's scoring.ScoreResult to the raw
// CompletedTaskCount slotting needs for the newcomer judgment.
// scoring.ScoreResult itself doesn't carry CompletedTaskCount (it only has
// AgentID/Score/Reasons), and binding the two together in one struct
// (rather than accepting two parallel slices, or a map keyed by AgentID)
// rules out the misalignment/mismatched-key failure mode either of those
// alternatives would let a caller introduce by construction: there is no
// way to supply a ScoreResult without also supplying its
// CompletedTaskCount in the same value.
type ScoredCandidate struct {
	Result             scoring.ScoreResult
	CompletedTaskCount int
}

// Select returns up to three slots for one task's scored candidates, per
// PRD §9.4:
//   - 0 candidates: no slots.
//   - 1 candidate: one TOP_SCORE (rank 1).
//   - 2 candidates: two TOP_SCORE (rank 1, 2), no EXPLORATION.
//   - 3+ candidates: two TOP_SCORE (rank 1, 2) plus one EXPLORATION (rank 3)
//     drawn from the newcomer pool (candidates outside the top two whose
//     domain.IsNewcomer(CompletedTaskCount) is true), selected by a
//     deterministic hash of taskID+algorithmVersion so repeated calls for
//     the same task/version reproduce the same pick (AC-705). If the
//     newcomer pool is empty, the slot is filled by the next-highest-scoring
//     remaining candidate instead, but its SlotType stays EXPLORATION (PRD:
//     "新人池为空时，由下一名最高分候选补位").
//
// candidates need not arrive pre-sorted — Select sorts them itself by
// Score descending, tie-broken by AgentID ascending, and that sort is the
// only ranking this package (or any other) performs.
func Select(taskID, algorithmVersion string, candidates []ScoredCandidate) []Slot {
	if len(candidates) == 0 {
		return nil
	}

	sorted := dedupeByAgentID(sortedCandidates(candidates))

	slots := make([]Slot, 0, 3)
	topCount := len(sorted)
	if topCount > 2 {
		topCount = 2
	}
	for i := 0; i < topCount; i++ {
		slots = append(slots, newSlot(sorted[i], i+1, SlotTypeTopScore))
	}

	if len(sorted) < 3 {
		return slots
	}

	remaining := sorted[2:] // already sorted by the same rule, per sortedCandidates
	pool := newcomerPool(remaining)

	var chosen ScoredCandidate
	if len(pool) > 0 {
		chosen = pool[explorationIndex(taskID, algorithmVersion, len(pool))]
	} else {
		// Newcomer pool empty: fall back to the next-highest-scoring
		// remaining candidate (remaining[0], since remaining is sorted).
		chosen = remaining[0]
	}

	slots = append(slots, newSlot(chosen, 3, SlotTypeExploration))
	return slots
}

func newSlot(c ScoredCandidate, rank int, slotType SlotType) Slot {
	return Slot{
		AgentID:  c.Result.AgentID,
		Rank:     rank,
		SlotType: slotType,
		Score:    c.Result.Score,
		Reasons:  c.Result.Reasons,
	}
}

// sortedCandidates returns candidates sorted by Score descending, tied
// scores broken by AgentID ascending (PRD: "分数相同按稳定规则排序，例如
// agentId"). The result is independent of the input slice's order: a new
// slice is sorted from scratch, and sort.Slice's comparator only ever
// looks at Score/AgentID, never at input position.
func sortedCandidates(candidates []ScoredCandidate) []ScoredCandidate {
	sorted := make([]ScoredCandidate, len(candidates))
	copy(sorted, candidates)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Result.Score != sorted[j].Result.Score {
			return sorted[i].Result.Score > sorted[j].Result.Score
		}
		return sorted[i].Result.AgentID < sorted[j].Result.AgentID
	})
	return sorted
}

// dedupeByAgentID keeps only the first occurrence of each AgentID in
// sorted (already Score-descending/AgentID-ascending), discarding any
// later duplicate. Since sorted is score-ordered, the kept occurrence is
// always the highest-scoring one for that AgentID. This is the structural
// guarantee behind "同一 Agent 不占两个槽位" (Codex review, T-703 round 1,
// P2): without it, a caller passing two ScoredCandidate entries for the
// same AgentID could have that Agent selected into two different slots —
// the exclusion of the top two from the exploration pool only prevents
// that within one already-deduplicated candidate set, it does nothing
// about duplicate input to begin with.
func dedupeByAgentID(sorted []ScoredCandidate) []ScoredCandidate {
	seen := make(map[string]struct{}, len(sorted))
	deduped := make([]ScoredCandidate, 0, len(sorted))
	for _, c := range sorted {
		if _, ok := seen[c.Result.AgentID]; ok {
			continue
		}
		seen[c.Result.AgentID] = struct{}{}
		deduped = append(deduped, c)
	}
	return deduped
}

// newcomerPool returns the subset of candidates (already excluding the top
// two, by construction of the caller) for which domain.IsNewcomer is true,
// preserving candidates' relative order (which is Score-descending/
// AgentID-ascending, inherited from sortedCandidates). This is the only
// place slotting decides newcomer status, and it always computes it fresh
// via domain.IsNewcomer(c.CompletedTaskCount) — never from any externally
// supplied IsNewcomer-shaped field.
func newcomerPool(candidates []ScoredCandidate) []ScoredCandidate {
	pool := make([]ScoredCandidate, 0, len(candidates))
	for _, c := range candidates {
		if domain.IsNewcomer(c.CompletedTaskCount) {
			pool = append(pool, c)
		}
	}
	return pool
}

// explorationIndex derives a deterministic index into a newcomer pool of
// the given length from taskID+algorithmVersion.
//
// Hash choice: FNV-1a (hash/fnv), not crypto/sha256 and not math/rand.
// This value has no security/collision-resistance requirement — it only
// needs to spread task/version strings evenly across pool indices — so
// FNV-1a's non-cryptographic speed is the right tradeoff over sha256's
// unneeded cryptographic strength. math/rand is excluded on principle even
// seeded deterministically: its output is not guaranteed stable across Go
// versions/platforms, which would silently break AC-705's
// reproducibility guarantee; a plain hash-then-modulo has no such risk.
func explorationIndex(taskID, algorithmVersion string, poolLen int) int {
	h := fnv.New64a()
	// hash.Hash.Write never returns an error for an in-memory FNV hash.
	_, _ = h.Write([]byte(taskID + algorithmVersion))
	return int(h.Sum64() % uint64(poolLen))
}
