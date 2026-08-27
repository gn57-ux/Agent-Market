package domain

// newcomerCompletedTaskCountThreshold is PRD §2.4's newcomer definition: an
// enabled Agent with CompletedTaskCount strictly less than this threshold.
// This constant exists in exactly one place — nothing else in this project
// may hardcode the literal 5 for this purpose.
const newcomerCompletedTaskCountThreshold = 5

// IsNewcomer computes newcomer status fresh from completedTaskCount, per
// PRD §2.4 ("完成任务少于 5 次的启用 Agent"). This is the single authority
// for the newcomer judgment across the dispatch service.
//
// Callers must never substitute CandidateSnapshot.IsNewcomer for a call to
// this function when making a decision: that field is an independent,
// caller-supplied value (e.g. apps/api may fill it for display purposes)
// and is not guaranteed to be in sync with a fresh computation from
// CompletedTaskCount at decision time. Any stage (slotting today, others
// later) that needs to decide based on newcomer status must call
// IsNewcomer(candidate.CompletedTaskCount) itself — this is the same
// "one authoritative computation, not two independent sources for the same
// fact" lesson T-702 round 1 already established for AlgorithmVersion.
func IsNewcomer(completedTaskCount int) bool {
	return completedTaskCount < newcomerCompletedTaskCountThreshold
}
