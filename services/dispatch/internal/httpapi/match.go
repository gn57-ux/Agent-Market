package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/agent-market/dispatch/internal/domain"
	"github.com/agent-market/dispatch/internal/eligibility"
	"github.com/agent-market/dispatch/internal/explain"
	"github.com/agent-market/dispatch/internal/scoring"
	"github.com/agent-market/dispatch/internal/slotting"
)

// maxMatchRequestBodyBytes caps POST /match's request body. 5MB is several
// times the size of the 1000-candidate benchmark fixture used by AC-704's
// P95 target (see match_bench_test.go) — enough headroom for real traffic
// while still rejecting unbounded bodies before they reach json.Decoder.
const maxMatchRequestBodyBytes = 5 << 20 // 5MB

// uuidPattern matches a generic UUID shape (8-4-4-4-12 hex digits). It
// deliberately does not pin down version/variant bits (RFC 4122 section
// 4.1.1/4.1.3) — this service treats taskId/agentId as opaque identifiers
// (see convertMatchRequest's doc comment); the goal is only to reject
// obviously-malformed strings before they enter the pipeline, not to
// enforce a specific UUID generation scheme.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// walletAddressPattern matches the "0x" + 40 hex chars format used
// elsewhere in the project (apps/api) for EVM wallet addresses.
var walletAddressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

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

	// http.MaxBytesReader wraps r.Body so any read beyond
	// maxMatchRequestBodyBytes (here, io.ReadAll below) returns an error;
	// it also calls w.WriteHeader(413) itself, but this handler still needs
	// to report 400 via writeMatchError's JSON body shape, so the error
	// path below writes its own status instead of relying on that side
	// effect.
	r.Body = http.MaxBytesReader(w, r.Body, maxMatchRequestBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeMatchError(w, http.StatusBadRequest, "request body too large or unreadable")
		return
	}

	if err := checkNoDuplicateKeys(raw, "request body"); err != nil {
		writeMatchError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Duplicate-key detection only covers the two object shapes this
	// service actually parses (matchRequest and, per-element,
	// matchCandidate) — see checkNoDuplicateKeys' doc comment for why a
	// fully general nested-duplicate-key detector isn't attempted here.
	// This lenient extraction (unknown fields allowed, malformed JSON
	// tolerated) exists only to reach into "candidates" for that check; if
	// it fails, the strict decode below still reports the real parse
	// error.
	var rawForCandidates struct {
		Candidates []json.RawMessage `json:"candidates"`
	}
	if err := json.Unmarshal(raw, &rawForCandidates); err == nil {
		for i, c := range rawForCandidates.Candidates {
			if err := checkNoDuplicateKeys(c, fmt.Sprintf("candidates[%d]", i)); err != nil {
				writeMatchError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
	}

	var req matchRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
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

// checkNoDuplicateKeys rejects a JSON object (raw) that repeats a key at
// its top level. encoding/json's default decode behavior for a repeated
// key is "last one wins" (silent overwrite, no error) — this scans raw's
// immediate key/value pairs with json.Decoder's token stream instead,
// erroring the first time a key is seen twice.
//
// Scope limitation: this only checks ONE level of nesting — the object
// raw itself, not any object/array nested inside its values. A fully
// general detector would need to recurse into every nested object (and
// object-within-array) at arbitrary depth, which balloons in complexity
// for marginal benefit here: the JSON shapes this service actually parses
// (matchRequest and, per-element, matchCandidate) are both flat objects —
// their field values are strings, numbers, bools, or arrays of strings,
// never nested objects. Callers invoke this once for the top-level
// matchRequest object and once per element of its "candidates" array
// (each a matchCandidate object), which together cover every object shape
// this service's wire format defines.
func checkNoDuplicateKeys(raw json.RawMessage, objectLabel string) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return errInvalidRequest(objectLabel + ": invalid JSON")
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return errInvalidRequest(objectLabel + " must be a JSON object")
	}

	seen := make(map[string]bool)
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return errInvalidRequest(objectLabel + ": invalid JSON")
		}
		key, ok := keyTok.(string)
		if !ok {
			return errInvalidRequest(objectLabel + " has a non-string key")
		}
		// encoding/json binds a JSON key to a struct field case-
		// insensitively when no exact-match field exists (its documented
		// fallback), so {"taskId":..., "TaskId":...} both resolve to the
		// same Go field and silently collide — exactly the "last one wins"
		// case this function exists to reject (Codex review, T-708 round 1,
		// P2). Folding to lower-case before the seen-check makes this
		// check match the decoder's own notion of "same key", not bare
		// byte-for-byte equality.
		foldedKey := strings.ToLower(key)
		if seen[foldedKey] {
			return errInvalidRequest(fmt.Sprintf("%s contains duplicate key %q", objectLabel, key))
		}
		seen[foldedKey] = true

		// Consume (and discard) the value paired with key, whatever shape
		// it is, without recursing into it for duplicate keys of its own
		// (see the scope-limitation note above).
		var discard json.RawMessage
		if err := dec.Decode(&discard); err != nil {
			return errInvalidRequest(objectLabel + ": invalid JSON")
		}
	}
	return nil
}

// convertMatchRequest validates req's required fields and converts it into
// the domain types the eligibility/scoring/slotting/explain pipeline
// consumes. All external-input validation the capsule requires (non-empty
// taskId/requesterAddress/algorithmVersion, valid level literals, valid
// RFC3339 timestamps, UUID-shaped taskId/agentId, wallet-address format,
// status enum, count field ranges/relationships, qualityScore range,
// non-empty category) happens here, before the pipeline runs.
func convertMatchRequest(req matchRequest) (domain.TaskFeatures, []domain.CandidateSnapshot, error) {
	if req.TaskID == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("taskId is required")
	}
	if !uuidPattern.MatchString(req.TaskID) {
		return domain.TaskFeatures{}, nil, errInvalidRequest("taskId must be a valid UUID")
	}
	if req.RequesterAddress == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("requesterAddress is required")
	}
	if !walletAddressPattern.MatchString(req.RequesterAddress) {
		return domain.TaskFeatures{}, nil, errInvalidRequest("requesterAddress must be a valid 0x-prefixed 40-hex-char address")
	}
	if req.AlgorithmVersion == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("algorithmVersion is required")
	}
	if req.Category == "" {
		return domain.TaskFeatures{}, nil, errInvalidRequest("category is required")
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
	for i, c := range req.Candidates {
		fieldErr := func(msg string) error {
			return errInvalidRequest(fmt.Sprintf("candidates[%d]: %s", i, msg))
		}

		if !uuidPattern.MatchString(c.AgentID) {
			return domain.TaskFeatures{}, nil, fieldErr("agentId must be a valid UUID")
		}
		if !walletAddressPattern.MatchString(c.WalletAddress) {
			return domain.TaskFeatures{}, nil, fieldErr("walletAddress must be a valid 0x-prefixed 40-hex-char address")
		}
		if c.Status != "ACTIVE" && c.Status != "INACTIVE" {
			return domain.TaskFeatures{}, nil, fieldErr(`status must be "ACTIVE" or "INACTIVE"`)
		}
		if c.Category == "" {
			return domain.TaskFeatures{}, nil, fieldErr("category is required")
		}
		if c.MaxConcurrentTasks < 1 || c.MaxConcurrentTasks > 100 {
			return domain.TaskFeatures{}, nil, fieldErr("maxConcurrentTasks must be between 1 and 100")
		}
		if c.ActiveTaskCount < 0 {
			return domain.TaskFeatures{}, nil, fieldErr("activeTaskCount must be >= 0")
		}
		if c.CompletedTaskCount < 0 {
			return domain.TaskFeatures{}, nil, fieldErr("completedTaskCount must be >= 0")
		}
		if c.SuccessCount < 0 {
			return domain.TaskFeatures{}, nil, fieldErr("successCount must be >= 0")
		}
		if c.OverdueCount < 0 {
			return domain.TaskFeatures{}, nil, fieldErr("overdueCount must be >= 0")
		}
		if c.SuccessCount > c.CompletedTaskCount {
			return domain.TaskFeatures{}, nil, fieldErr("successCount must not exceed completedTaskCount")
		}
		if c.QualityScore != nil && (*c.QualityScore < 0 || *c.QualityScore > 1) {
			return domain.TaskFeatures{}, nil, fieldErr("qualityScore must be between 0 and 1")
		}

		level, err := domain.ParseLevel(c.Level)
		if err != nil {
			return domain.TaskFeatures{}, nil, fieldErr("invalid candidate level: " + err.Error())
		}
		createdAt, err := time.Parse(time.RFC3339, c.CreatedAt)
		if err != nil {
			return domain.TaskFeatures{}, nil, fieldErr("invalid candidate createdAt: " + err.Error())
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
