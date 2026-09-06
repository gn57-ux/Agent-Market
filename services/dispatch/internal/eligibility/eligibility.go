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

// v02SemanticSimilarityThreshold is "v0.2"'s cosine-similarity threshold for
// the category-relatedness condition's OR branch (F-1305). A compile-time
// constant this package alone owns — apps/api only computes and forwards
// the raw similarity number, never this threshold, matching the same
// "versioned constant, single owner" convention scoring.weightsFor already
// established.
//
// T-1307 v2 (2026-08-31): calibrated from a real 12-pair golden sample set,
// embedded with the ACTUAL production model (local Ollama bge-m3:latest,
// digest 7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab)
// — not a placeholder, and not text-embedding-3-small's number this
// constant used to hold before the Ollama migration (a different model's
// cosine-similarity distribution isn't transferable; see
// specs/13-vector-recall-scoring/golden-sample-calibration.md's own
// explicit note on this). The real distribution: every negative sample
// scored <= 0.6162; every positive except one scored >= 0.6639, leaving a
// clean [0.6162, 0.6639] gap. 0.64 sits in the middle of that gap. One
// cross-category positive pair (UI design task vs. a React
// Native/Figma-focused frontend Agent) scored 0.5744 — genuinely below
// this threshold — and is a KNOWN, DISCLOSED false negative, not
// something the sample set or this value was adjusted to hide (the golden
// sample doc's own explicit instruction: report real model limits
// honestly rather than force a "clean" number). A false negative here
// only means that one candidate doesn't get v0.2's semantic-widening
// benefit — v0.1's exact-category match remains the unaffected baseline —
// which is the deliberately safer failure mode compared to a threshold
// low enough to risk a false positive (showing a requester a genuinely
// unrelated candidate).
const v02SemanticSimilarityThreshold = 0.64

// Filter returns the subset of candidates that satisfy all seven eligibility
// conditions in PRD §9.2 for task. Conditions are AND-combined — any single
// violation eliminates a candidate; this is not a scoring/penalty function
// (scoring is T-702's separate stage).
//
// Conditions, in the order checked:
//  1. Enabled status: candidate.Status == "ACTIVE".
//  2. Category relatedness: exact string match against task.Category, OR
//     (only when task.AlgorithmVersion == "v0.2") candidate.SemanticSimilarity
//     >= v02SemanticSimilarityThreshold (F-1305, Feature 13/T-1304). The
//     exact-match rule alone is this project's original behavior across
//     Feature 5/6/7 (mirroring the existing AgentMarketPage/TaskMarketPage
//     frontend exact-match filtering convention rather than inventing a
//     fuzzy/hierarchical match); the semantic OR-branch only ever WIDENS
//     the eligible set for a "v0.2" task, never narrows it, and a "v0.1"
//     task never evaluates SemanticSimilarity at all — see categoryRelated.
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
//  8. Basic-evaluation admission (Feature 20/T-2009, F-2012, 用户
//     2026-09-06 Q-2001 决策), ONLY when task.EnforceBaselineEvaluationGate
//     is true: candidate.BaselineEvaluationStatus == "PASSED". Gated behind
//     a per-request flag from apps/api (see domain.TaskFeatures' own doc
//     comment) rather than always-on, by explicit user instruction — an
//     operator only flips it on after seeding a real question bank
//     (scripts/seed-baseline-evaluation-tasks.ts) and backfilling every
//     pre-existing Agent to PASSED (scripts/backfill-existing-agents-
//     baseline-status.ts); with the flag off (the default), this condition
//     is skipped entirely and every candidate is eligible regardless of its
//     BaselineEvaluationStatus, exactly like before this condition existed.
//  9. Risk-hold admission (Feature 20/T-2008, F-2010, 用户 2026-09-06
//     Q-2003 决策), ONLY when task.EnforceRiskHoldGate is true:
//     candidate.RiskHoldStatus != "HELD". Originally unconditional (no
//     gate) — N4 round 2 found a real rolling-deployment gap (see
//     domain.TaskFeatures' own doc comment on EnforceRiskHoldGate for the
//     full reasoning) and the user explicitly decided to close it with a
//     version/readiness handshake instead of accepting the gap. apps/api's
//     own SQL-level filter (`assembleCandidateSnapshots`) is the PRIMARY,
//     always-on defense regardless of this flag — a HELD Agent is never
//     even assembled as a candidate by an apps/api instance running this
//     Task's code — so this condition is intentional defense-in-depth for
//     the specific "new apps/api, old dispatch" pairing, not the sole
//     enforcement point.
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
	if !categoryRelated(task, candidate) {
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
	if task.EnforceBaselineEvaluationGate && candidate.BaselineEvaluationStatus != "PASSED" {
		return false
	}
	if task.EnforceRiskHoldGate && candidate.RiskHoldStatus == "HELD" {
		return false
	}
	return true
}

// categoryRelated implements condition 2's category-relatedness check (see
// Filter's doc comment). Exact match always qualifies, for every
// algorithmVersion; the semantic-similarity OR-branch only applies to a
// "v0.2" task, so a "v0.1" task's eligibility is byte-for-byte identical to
// this package's pre-Feature-13 behavior regardless of what
// candidate.SemanticSimilarity happens to contain.
func categoryRelated(task domain.TaskFeatures, candidate domain.CandidateSnapshot) bool {
	if candidate.Category == task.Category {
		return true
	}
	if task.AlgorithmVersion != "v0.2" {
		return false
	}
	return candidate.SemanticSimilarity >= v02SemanticSimilarityThreshold
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
		required[strings.ToLower(tag)] = struct{}{}
	}
	for _, tag := range candidateTags {
		if _, ok := required[strings.ToLower(tag)]; ok {
			return true
		}
	}
	return false
}
