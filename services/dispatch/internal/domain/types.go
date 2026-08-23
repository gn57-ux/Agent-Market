package domain

import "time"

// CandidateSnapshot is an immutable, point-in-time view of one Agent as
// supplied by apps/api's dispatch snapshot assembly. Every field here is a
// real value read from the database at request time (agents.*,
// tasks.accepted_agent_id counts, blocked_wallets) — the eligibility/
// scoring/slotting stages never re-query or re-derive these values
// themselves, they only consume what's already in the snapshot.
type CandidateSnapshot struct {
	AgentID       string
	WalletAddress string
	Status        string // "ACTIVE" | "INACTIVE" (agents.status, passed through as-is)
	Category      string
	SkillTags     []string
	Level         Level

	MaxConcurrentTasks int // agents.max_concurrent_tasks (F-711)
	ActiveTaskCount    int // real count of tasks.accepted_agent_id = this agent AND status active (T-705)

	CompletedTaskCount int
	SuccessCount       int
	OverdueCount       int

	QualityScore *float64 // nil = no real score yet; T-702's prior resolves this, eligibility never interprets it

	CreatedAt time.Time

	IsNewcomer bool // PRD §2.4: an enabled Agent with CompletedTaskCount < 5
	IsBanned   bool // from a real blocked_wallets batch lookup (F-712), never a fixed value
}

// TaskFeatures is the task-side input to eligibility/scoring/slotting, per
// PRD §9.1's field list.
type TaskFeatures struct {
	TaskID           string
	Category         string
	SkillTags        []string
	DeliveryDeadline time.Time
	RequiredLevel    Level
	RequesterAddress string
	AlgorithmVersion string
}
