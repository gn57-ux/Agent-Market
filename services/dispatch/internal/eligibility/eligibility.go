// Package eligibility implements F-702's candidate eligibility filter
// (PRD §9.2). It is a pure function package: no database queries, no HTTP
// calls — every value it needs arrives already resolved inside
// domain.TaskFeatures / domain.CandidateSnapshot, and it returns only an
// in-memory subset of the input candidates.
package eligibility

import (
	"regexp"
	"strings"

	"github.com/agent-market/dispatch/internal/domain"
)

// walletAddressPattern matches a lowercase, 0x-prefixed 20-byte hex address.
// This mirrors the same CHECK constraint used by the blocked_wallets and
// tasks.accepted_agent_address columns (T-700's migration).
var walletAddressPattern = regexp.MustCompile(`^0x[0-9a-f]{40}$`)

// Filter returns the subset of candidates that satisfy all seven eligibility
// conditions in PRD §9.2 for task. Conditions are AND-combined — any single
// violation eliminates a candidate; this is not a scoring/penalty function
// (scoring is T-702's separate stage).
//
// Conditions, in the order checked:
//  1. Enabled status: candidate.Status == "ACTIVE".
//  2. Category compatibility: exact string match against task.Category.
//     This project has never defined a category-compatibility mapping
//     table across Feature 5/6/7, so this mirrors the existing
//     AgentMarketPage/TaskMarketPage frontend exact-match filtering
//     convention rather than inventing a fuzzy/hierarchical match.
//  3. Required skill tag match: at least one tag in candidate.SkillTags
//     overlaps task.SkillTags (non-empty intersection); a task declaring no
//     required tags at all requires nothing and is vacuously satisfied by
//     every candidate (see skillTagsOverlap). PRD prose mentions an "all
//     required tags must match" mode, but no task-level flag for selecting
//     that mode exists anywhere in this project's schema — Feature 6's
//     task_skills table is a plain (task_id, skill_tag) multi-value set
//     with no such flag. This function therefore implements only the "at
//     least one overlaps" rule, which has real data support; the "all
//     required" branch is deliberately NOT implemented because there is no
//     field to decide when to apply it. This is a documented assumption,
//     not a silent gap.
//  4. Level: candidate.Level.Satisfies(task.RequiredLevel).
//  5. Capacity: candidate.ActiveTaskCount < candidate.MaxConcurrentTasks.
//  6. Self-acceptance ban: candidate.WalletAddress != task.RequesterAddress,
//     compared case-insensitively. Both sides are expected to already be
//     lowercase-normalized addresses; the lowercasing here is a defensive
//     second pass, not a normalization this function is responsible for
//     upstream of.
//  7. Wallet validity + ban list: address matches ^0x[0-9a-f]{40}$ and
//     candidate.IsBanned is false.
func Filter(task domain.TaskFeatures, candidates []domain.CandidateSnapshot) []domain.CandidateSnapshot {
	eligible := make([]domain.CandidateSnapshot, 0, len(candidates))
	for _, candidate := range candidates {
		if isEligible(task, candidate) {
			eligible = append(eligible, candidate)
		}
	}
	return eligible
}

func isEligible(task domain.TaskFeatures, candidate domain.CandidateSnapshot) bool {
	if candidate.Status != "ACTIVE" {
		return false
	}
	if candidate.Category != task.Category {
		return false
	}
	if !skillTagsOverlap(candidate.SkillTags, task.SkillTags) {
		return false
	}
	if !candidate.Level.Satisfies(task.RequiredLevel) {
		return false
	}
	if candidate.ActiveTaskCount >= candidate.MaxConcurrentTasks {
		return false
	}
	if strings.EqualFold(candidate.WalletAddress, task.RequesterAddress) {
		return false
	}
	// No ToLower here: the format check mirrors the database CHECK
	// constraint (~ '^0x[0-9a-f]{40}$'), which is case-sensitive and
	// requires the address to already be lowercase-normalized. Unlike
	// condition 6's comparison (which tolerates either side being
	// mis-cased defensively), an uppercase-containing address here is a
	// genuine format violation, not just a comparison mismatch.
	if !walletAddressPattern.MatchString(candidate.WalletAddress) {
		return false
	}
	if candidate.IsBanned {
		return false
	}
	return true
}

// skillTagsOverlap reports whether candidateTags and taskTags share at least
// one element. An empty taskTags means the task declared no required
// skills at all (apps/api's schema.ts defaults skillTags to []) — nothing
// is required, so this condition is vacuously satisfied for every
// candidate, not eliminating. This mirrors how an empty/absent filter value
// means "no filter applied" elsewhere in this project (e.g.
// TaskMarketPage's category/skillTag query params). An empty
// candidateTags against a non-empty taskTags is a real non-match, though:
// the Agent has declared no skills that could overlap task's requirement.
func skillTagsOverlap(candidateTags, taskTags []string) bool {
	if len(taskTags) == 0 {
		return true
	}
	if len(candidateTags) == 0 {
		return false
	}
	required := make(map[string]struct{}, len(taskTags))
	for _, tag := range taskTags {
		required[tag] = struct{}{}
	}
	for _, tag := range candidateTags {
		if _, ok := required[tag]; ok {
			return true
		}
	}
	return false
}
