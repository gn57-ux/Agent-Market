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

	// BaselineEvaluationStatus (Feature 20/T-2009, design.md 决策 3): F-2012's
	// basic-evaluation admission gate. A plain enum ("NOT_STARTED" |
	// "PENDING" | "PASSED" | "FAILED"), never a score — eligibility.Filter
	// reads only whether this equals "PASSED"; this service has no database
	// connection of its own, so apps/api's candidate snapshot is the ONLY
	// channel this value ever arrives through.
	BaselineEvaluationStatus string

	// RiskHoldStatus (Feature 20/T-2008, 用户 2026-09-06 Q-2003 决策): the
	// independent risk-hold module's own admission signal — DELIBERATELY a
	// separate field from BaselineEvaluationStatus above (two orthogonal
	// domain states: "hasn't proven competence" vs "confirmed antifraud
	// hold"). A plain enum ("NONE" | "HELD"), never enriched with which
	// signal caused it — eligibility.Filter reads only whether this equals
	// "HELD", always unconditionally (no config-flag gate, unlike
	// BaselineEvaluationStatus: every Agent defaults to "NONE", so there is
	// no chicken-and-egg rollout problem here).
	RiskHoldStatus string

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

	// EnforceBaselineEvaluationGate (Feature 20/T-2009, 用户 2026-09-06
	// Q-2001 决策): whether eligibility.Filter's condition 8 actually
	// excludes candidates whose BaselineEvaluationStatus isn't "PASSED".
	// A per-request flag from apps/api (see MatchRequest's own doc comment,
	// dispatch.client.ts) — this service still has no database connection
	// and no config file of its own; every business decision, including
	// whether this gate is live yet, arrives from Node.
	EnforceBaselineEvaluationGate bool

	// EnforceRiskHoldGate (Feature 20/T-2008, N4 round-2 real finding +
	// user's explicit 2026-09-06 follow-up decision): whether
	// eligibility.Filter's condition 9 actually excludes HELD candidates.
	// Originally condition 9 was unconditional (every request enforced it,
	// no gate) — N4 round 2 found a real rolling-deployment gap: an OLDER
	// apps/api instance (pre-T-2008, no risk_hold_status awareness at all)
	// forwards a HELD Agent to a NEWER dispatch instance with the
	// `riskHoldStatus` field entirely absent from the JSON; treating a
	// missing value as the safe default "NONE" (this codebase's own
	// established rolling-deploy-compat convention for every other enum
	// field) would then silently let a confirmed-antifraud-HELD Agent
	// through. Gating condition 9 behind this flag means: apps/api only
	// claims "I am risk-hold-aware" once it has independently confirmed
	// (dispatch.client.ts's `checkDispatchSupportsRiskHoldGate`, via
	// dispatch's own `/healthz` capability advertisement) that THIS
	// dispatch instance understands the field — closing the symmetric
	// "new apps/api / old dispatch" pairing with an explicit handshake
	// rather than an unverified assumption. apps/api's own SQL-level
	// filter (`assembleCandidateSnapshots`, `AND risk_hold_status =
	// 'NONE'`) remains the PRIMARY, unconditional defense — a HELD Agent
	// is never even assembled as a candidate by any apps/api instance
	// running this Task's code, regardless of what this flag is set to —
	// so this Go-side condition is intentionally defense-in-depth, not the
	// sole enforcement point. The one residual, explicitly accepted risk
	// (per the user's own decision on this exact finding): an apps/api
	// replica that has NOT yet rolled out to this Task's code at all
	// (mid-rollout of apps/api itself) still lacks both the SQL filter and
	// this flag — that window is bounded to apps/api's own rollout
	// duration and is not something a flag apps/api sends can close, since
	// the flag-sending code itself is what's missing on that replica.
	EnforceRiskHoldGate bool
}
