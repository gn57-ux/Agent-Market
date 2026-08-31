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

	// SemanticSimilarity is this candidate's cosine similarity (in
	// [-1, 1], practically [0, 1] for real text embeddings) against the
	// task's own embedding, as computed by apps/api's pgvector `<=>` query
	// (Feature 13, T-1303). Always 0 for a "v0.1" request — apps/api only
	// computes and fills this field when TaskFeatures.AlgorithmVersion is
	// "v0.2" (design.md's explicit contract) — and eligibility.Filter never
	// reads it for a "v0.1" task either, so a stray non-zero value here
	// under "v0.1" (which should never happen, but isn't itself checked)
	// still couldn't silently change v0.1 behavior.
	SemanticSimilarity float64

	// ReputationSignals is this candidate's v0.2 scoring input (F-1306/
	// F-1308, Feature 13/T-1305) — the zero value (every field nil) for a
	// "v0.1" request, exactly like SemanticSimilarity. Living on
	// CandidateSnapshot itself rather than a caller-maintained
	// AgentID-keyed map (an earlier version of T-1305 tried the latter and
	// a Codex review round 1 P2 caught it: this project explicitly permits
	// two candidate snapshots sharing one AgentID with different data — see
	// httpapi's runMatchPipeline binding CompletedTaskCount by shared
	// index, not by an AgentID map, for the identical earlier T-704 lesson
	// — so a map keyed by AgentID silently merges/overwrites two distinct
	// snapshots' signals). Storing it directly on the struct that already
	// survives eligibility.Filter's index-preserving filtering means this
	// field is correct by construction, with no second parallel structure
	// for any caller to keep in sync.
	ReputationSignals ReputationSignals
}

// ReputationSignals is v0.2's five-signal scoring input (F-1306/F-1308).
// apps/api's reputation-signals.ts (T-1306) computes each raw, already-
// normalized-to-[0,1] value from real settlement history; internal/scoring
// owns only how they combine into one final score (F-1306's "调用方不得
// 复制公式" boundary). A nil field means that signal is missing for this
// candidate (F-1309) — never a fabricated 0 or a borrowed prior. Field
// names match design.md's wire contract (`reputationSignals.
// {completionRate,qualityFeedback,communication,disputeSignal,
// historicalScale}`) exactly. Defined in this package (not internal/
// scoring, which is where design.md originally sketched it) purely to let
// CandidateSnapshot carry it directly — internal/scoring already imports
// internal/domain, so the reverse import this type's original location
// would have required is not possible.
type ReputationSignals struct {
	CompletionRate  *float64
	QualityFeedback *float64
	Communication   *float64
	DisputeSignal   *float64
	HistoricalScale *float64
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
