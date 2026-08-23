package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/agent-market/dispatch/internal/domain"
	"github.com/agent-market/dispatch/internal/eligibility"
	"github.com/agent-market/dispatch/internal/explain"
	"github.com/agent-market/dispatch/internal/scoring"
	"github.com/agent-market/dispatch/internal/slotting"
)

// matchRequest is POST /match's private wire format. Converted to
// domain.TaskFeatures/domain.CandidateSnapshot immediately upon parsing —
// the domain package itself carries no JSON tags and has no awareness of
// this shape (see design.md's interface contract and T-704's capsule).
type matchRequest struct {
	TaskID           string           `json:"taskId"`
	Category         string           `json:"category"`
	SkillTags        []string         `json:"skillTags"`
	DeliveryDeadline string           `json:"deliveryDeadline"` // RFC3339
	RequiredLevel    string           `json:"requiredLevel"`
	RequesterAddress string           `json:"requesterAddress"`
	AlgorithmVersion string           `json:"algorithmVersion"`
	Candidates       []matchCandidate `json:"candidates"`
}

// matchCandidate is one wire-format candidate inside matchRequest.
// isNewcomer is intentionally not a field here: T-703 established that
// newcomer status is never trusted from an external source, only ever
// computed fresh via domain.IsNewcomer, so this wire format doesn't even
// offer a field a caller could mistakenly believe takes effect.
type matchCandidate struct {
	AgentID            string   `json:"agentId"`
	WalletAddress      string   `json:"walletAddress"`
	Status             string   `json:"status"`
	Category           string   `json:"category"`
	SkillTags          []string `json:"skillTags"`
	Level              string   `json:"level"`
	MaxConcurrentTasks int      `json:"maxConcurrentTasks"`
	ActiveTaskCount    int      `json:"activeTaskCount"`
	CompletedTaskCount int      `json:"completedTaskCount"`
	SuccessCount       int      `json:"successCount"`
	OverdueCount       int      `json:"overdueCount"`
	QualityScore       *float64 `json:"qualityScore"`
	CreatedAt          string   `json:"createdAt"` // RFC3339
	IsBanned           bool     `json:"isBanned"`
}

// matchResponse is POST /match's response wire format.
type matchResponse struct {
	TaskID           string                `json:"taskId"`
	AlgorithmVersion string                `json:"algorithmVersion"`
	Recommendations  []matchRecommendation `json:"recommendations"`
}

// matchRecommendation is one selected slot's wire-format representation.
type matchRecommendation struct {
	AgentID  string   `json:"agentId"`
	Rank     int      `json:"rank"`
	SlotType string   `json:"slotType"`
	Score    float64  `json:"score"`
	Reasons  []string `json:"reasons"`
}

// handleMatch implements POST /match: parse request -> eligibility.Filter ->
// scoring.ScoreAll -> slotting.Select -> explain.ExplainAll -> serialize
// response. No business logic lives here — every decision is delegated to
// the internal/{eligibility,scoring,slotting,explain} packages; this
// function only does wire-format conversion and orchestration in the fixed
// pipeline order the capsule specifies.
func handleMatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMatchError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var req matchRequest
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		writeMatchError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	task, candidates, err := convertMatchRequest(req)
	if err != nil {
		writeMatchError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp, err := runMatchPipeline(task, candidates)
	if err != nil {
		writeMatchError(w, http.StatusBadRequest, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// convertMatchRequest validates req's required fields and converts it into
// the domain types the eligibility/scoring/slotting/explain pipeline
// consumes. All external-input validation the capsule requires (non-empty
// taskId/requesterAddress/algorithmVersion, valid level literals, valid
// RFC3339 timestamps) happens here, before the pipeline runs.
func convertMatchRequest(req matchRequest) (domain.TaskFeatures, []domain.CandidateSnapshot, error) {
	if req.TaskID == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("taskId is required")
	}
	if req.RequesterAddress == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("requesterAddress is required")
	}
	if req.AlgorithmVersion == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("algorithmVersion is required")
	}

	requiredLevel, err := domain.ParseLevel(req.RequiredLevel)
	if err != nil {
		return domain.TaskFeatures{}, nil, errInvalidRequest("invalid requiredLevel: " + err.Error())
	}

	deadline, err := time.Parse(time.RFC3339, req.DeliveryDeadline)
	if err != nil {
		return domain.TaskFeatures{}, nil, errInvalidRequest("invalid deliveryDeadline: " + err.Error())
	}

	task := domain.TaskFeatures{
		TaskID:           req.TaskID,
		Category:         req.Category,
		SkillTags:        req.SkillTags,
		DeliveryDeadline: deadline,
		RequiredLevel:    requiredLevel,
		RequesterAddress: req.RequesterAddress,
		AlgorithmVersion: req.AlgorithmVersion,
	}

	candidates := make([]domain.CandidateSnapshot, 0, len(req.Candidates))
	for _, c := range req.Candidates {
		level, err := domain.ParseLevel(c.Level)
		if err != nil {
			return domain.TaskFeatures{}, nil, errInvalidRequest("invalid candidate level: " + err.Error())
		}
		createdAt, err := time.Parse(time.RFC3339, c.CreatedAt)
		if err != nil {
			return domain.TaskFeatures{}, nil, errInvalidRequest("invalid candidate createdAt: " + err.Error())
		}

		candidates = append(candidates, domain.CandidateSnapshot{
			AgentID:            c.AgentID,
			WalletAddress:      c.WalletAddress,
			Status:             c.Status,
			Category:           c.Category,
			SkillTags:          c.SkillTags,
			Level:              level,
			MaxConcurrentTasks: c.MaxConcurrentTasks,
			ActiveTaskCount:    c.ActiveTaskCount,
			CompletedTaskCount: c.CompletedTaskCount,
			SuccessCount:       c.SuccessCount,
			OverdueCount:       c.OverdueCount,
			QualityScore:       c.QualityScore,
			CreatedAt:          createdAt,
			IsNewcomer:         domain.IsNewcomer(c.CompletedTaskCount),
			IsBanned:           c.IsBanned,
		})
	}

	return task, candidates, nil
}

// runMatchPipeline executes the fixed orchestration pipeline: eligibility
// filtering, scoring, slot selection, and explanation text generation, then
// assembles the response DTO.
//
// scoring.ScoreAll returns its results in the same order as its input slice
// (T-702's explicit contract — "no sorting/reordering here"), so scored[i]
// is always the score for eligible[i]. Binding CompletedTaskCount by that
// shared index — not by looking AgentID up in a map — is what this
// function does (Codex review, T-704 round 1, P2: an earlier version used
// an AgentID-keyed map, which silently mis-binds when the request contains
// two candidates sharing one AgentID with different CompletedTaskCount
// values — the map keeps only the last one and can attach it to the wrong
// scored candidate. Index alignment has no such ambiguity: each ScoreResult
// is bound to the exact CandidateSnapshot it was computed from, never a
// same-AgentID stand-in).
func runMatchPipeline(task domain.TaskFeatures, candidates []domain.CandidateSnapshot) (matchResponse, error) {
	eligible := eligibility.Filter(task, candidates)

	scored, err := scoring.ScoreAll(task, eligible)
	if err != nil {
		return matchResponse{}, err
	}

	boundCandidates := make([]slotting.ScoredCandidate, 0, len(scored))
	for i, result := range scored {
		boundCandidates = append(boundCandidates, slotting.ScoredCandidate{
			Result:             result,
			CompletedTaskCount: eligible[i].CompletedTaskCount,
		})
	}

	slots := slotting.Select(task.TaskID, task.AlgorithmVersion, boundCandidates)

	recommendations := make([]matchRecommendation, 0, len(slots))
	for _, slot := range slots {
		recommendations = append(recommendations, matchRecommendation{
			AgentID:  slot.AgentID,
			Rank:     slot.Rank,
			SlotType: string(slot.SlotType),
			Score:    slot.Score,
			Reasons:  explain.ExplainAll(slot.Reasons),
		})
	}

	return matchResponse{
		TaskID:           task.TaskID,
		AlgorithmVersion: task.AlgorithmVersion,
		Recommendations:  recommendations,
	}, nil
}

// errInvalidRequest wraps msg as a plain error for convertMatchRequest's
// validation failures, all of which map to HTTP 400 in handleMatch.
func errInvalidRequest(msg string) error {
	return invalidRequestError(msg)
}

// invalidRequestError is a named string-based error type (rather than
// fmt.Errorf's opaque *errors.errorString) so its Error() text can be
// reused directly as the response body's "error" message without any
// wrapping/unwrapping machinery this single call site doesn't need.
type invalidRequestError string

func (e invalidRequestError) Error() string { return string(e) }

// writeMatchError writes a {"error": message} JSON body with the given
// status code.
func writeMatchError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
