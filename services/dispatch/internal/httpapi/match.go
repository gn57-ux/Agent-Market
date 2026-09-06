package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
	// EnforceBaselineEvaluationGate (Feature 20/T-2009): see
	// domain.TaskFeatures' own field of the same meaning. A plain bool, not
	// a pointer — an OLDER apps/api that predates this field entirely
	// (rolling deployment) decodes it to Go's natural zero value `false`,
	// which is the safe default (gate disabled) exactly like
	// `baselineEvaluationStatus`'s own missing-field handling below.
	EnforceBaselineEvaluationGate bool `json:"enforceBaselineEvaluationGate"`
	// EnforceRiskHoldGate (Feature 20/T-2008, N4 round-2 follow-up
	// decision): see domain.TaskFeatures' own field of the same meaning.
	// Same rolling-deploy-safe reasoning as EnforceBaselineEvaluationGate
	// above — an OLDER apps/api decodes this to Go's zero value `false`
	// (gate disabled, condition 9 skipped), which is exactly the intended
	// fallback: apps/api's own SQL-level filter is the primary, always-on
	// defense regardless of this flag.
	EnforceRiskHoldGate bool `json:"enforceRiskHoldGate"`
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
	// BaselineEvaluationStatus (Feature 20/T-2009): F-2012's admission-gate
	// enum, passed straight through to domain.CandidateSnapshot and checked
	// by eligibility.Filter — see that field's own doc comment.
	BaselineEvaluationStatus string `json:"baselineEvaluationStatus"`
	// RiskHoldStatus (Feature 20/T-2008): the independent risk-hold
	// module's own admission enum — see domain.CandidateSnapshot's own doc
	// comment for why this is a SEPARATE field from BaselineEvaluationStatus.
	RiskHoldStatus string `json:"riskHoldStatus"`
	// SemanticSimilarity (Feature 13, T-1304): apps/api only sends this
	// non-zero for a "v0.2" request (design.md's contract) — a plain
	// (non-pointer) float64 so an absent field on the wire (every "v0.1"
	// request today) decodes to Go's natural zero value with no special
	// casing needed here, matching domain.CandidateSnapshot's identical
	// field.
	SemanticSimilarity float64 `json:"semanticSimilarity"`
	// ReputationSignals (Feature 13, T-1305): nil for every "v0.1" request
	// (apps/api's reputation-signals.ts, T-1306, only computes this for
	// "v0.2") — a pointer to the whole nested object, not five separate
	// pointer fields flattened here, so "the object was entirely absent"
	// and "the object was present with every field null" stay
	// distinguishable at the wire layer, even though convertMatchRequest
	// converts both shapes to the same domain.ReputationSignals{} zero
	// value (see its own comment on why that's the correct choice).
	ReputationSignals *matchReputationSignals `json:"reputationSignals"`
}

// matchReputationSignals is POST /match's wire format for one candidate's
// F-1306/F-1308 five-signal input. Field names match design.md's interface
// contract and domain.ReputationSignals exactly — see that type's doc
// comment for why a nil field means "this signal is missing," never 0.
type matchReputationSignals struct {
	CompletionRate  *float64 `json:"completionRate"`
	QualityFeedback *float64 `json:"qualityFeedback"`
	Communication   *float64 `json:"communication"`
	DisputeSignal   *float64 `json:"disputeSignal"`
	HistoricalScale *float64 `json:"historicalScale"`
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

	// F-1919 (Feature 19, T-1912): the one point where this service
	// participates in the cross-process trace Node originates for one
	// `/match` call — Go never calls Python and has no reason to know
	// about the eventual `/rerank` leg (F-1914/F-1915's own three-party
	// boundary stays unchanged), but logging the SAME `X-Trace-Id` Node
	// generated lets a real operator grep one id across Node's own log
	// line, this one, and Python's (`main.py`'s matching read of the same
	// header) to reconstruct one request's full path. Using this
	// package's already-established `log.Printf` convention
	// (`cmd/server/main.go`), not introducing a new logging library for
	// one line.
	if traceID := r.Header.Get("X-Trace-Id"); traceID != "" {
		log.Printf("trace_id=%s POST /match", traceID)
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
			// reputationSignals (Feature 13, T-1305) is the one nested
			// object this service's wire format defines — every other
			// object shape it parses is flat (matchRequest, matchCandidate;
			// see checkNoDuplicateKeys' own scope-limitation note). A
			// duplicate key inside THIS object needs its own check for the
			// exact same reason the two calls above exist: without it,
			// {"completionRate":0.1,"completionRate":0.9} silently keeps
			// only the last value instead of being rejected.
			var rawForReputationSignals struct {
				ReputationSignals json.RawMessage `json:"reputationSignals"`
			}
			if err := json.Unmarshal(c, &rawForReputationSignals); err == nil &&
				len(rawForReputationSignals.ReputationSignals) > 0 &&
				!bytes.Equal(bytes.TrimSpace(rawForReputationSignals.ReputationSignals), []byte("null")) {
				label := fmt.Sprintf("candidates[%d].reputationSignals", i)
				if err := checkNoDuplicateKeys(rawForReputationSignals.ReputationSignals, label); err != nil {
					writeMatchError(w, http.StatusBadRequest, err.Error())
					return
				}
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
//
// ReputationSignals (Feature 13, T-1305) is set directly on each returned
// CandidateSnapshot — never returned via a second, AgentID-keyed map. A
// map was this function's first version; a Codex review round 1 P2 caught
// that it silently mis-binds when two candidates share one AgentID (this
// project explicitly permits that — see CandidateSnapshot.ReputationSignals'
// own doc comment). Threading the value through the same struct that
// already survives eligibility.Filter's index-preserving filtering closes
// that class of bug structurally.
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
		TaskID:                        req.TaskID,
		Category:                      req.Category,
		SkillTags:                     req.SkillTags,
		DeliveryDeadline:              deadline,
		RequiredLevel:                 requiredLevel,
		RequesterAddress:              req.RequesterAddress,
		AlgorithmVersion:              req.AlgorithmVersion,
		EnforceBaselineEvaluationGate: req.EnforceBaselineEvaluationGate,
		EnforceRiskHoldGate:           req.EnforceRiskHoldGate,
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
		if c.SemanticSimilarity < -1 || c.SemanticSimilarity > 1 {
			return domain.TaskFeatures{}, nil, fieldErr("semanticSimilarity must be between -1 and 1")
		}
		if err := validateReputationSignalsRange(c.ReputationSignals); err != nil {
			return domain.TaskFeatures{}, nil, fieldErr(err.Error())
		}
		// N4 real finding (P1): an EMPTY string (the field entirely absent
		// on the wire, since this is a plain non-pointer string) must NOT
		// be rejected — apps/api and this service deploy independently, so
		// a rolling deployment that ships this service before apps/api
		// starts sending the field would otherwise turn every real match
		// request into a 400 until both sides finish deploying. Missing
		// resolves to the same conservative "NOT_STARTED" a fresh Agent
		// already gets from the migration's own column default — never
		// eligible, exactly the safe direction to fail in. An explicitly
		// PROVIDED but unrecognized value is still rejected as real
		// malformed input.
		if c.BaselineEvaluationStatus != "" && !isValidBaselineEvaluationStatus(c.BaselineEvaluationStatus) {
			return domain.TaskFeatures{}, nil, fieldErr(`baselineEvaluationStatus must be one of "NOT_STARTED", "PENDING", "PASSED", "FAILED"`)
		}
		baselineEvaluationStatus := c.BaselineEvaluationStatus
		if baselineEvaluationStatus == "" {
			baselineEvaluationStatus = "NOT_STARTED"
		}

		// Same rolling-deploy-safe missing-field handling as
		// baselineEvaluationStatus above — an absent riskHoldStatus
		// resolves to "NONE" (0034_add_agents_risk_hold_status.sql's own
		// column default), which happens to ALSO be the eligible direction
		// here (unlike baselineEvaluationStatus's "NOT_STARTED"). This is
		// not a coincidence worth relying on elsewhere — it's simply true
		// that a fresh/never-held Agent should be eligible with respect to
		// this specific condition, matching the column's own real default.
		if c.RiskHoldStatus != "" && !isValidRiskHoldStatus(c.RiskHoldStatus) {
			return domain.TaskFeatures{}, nil, fieldErr(`riskHoldStatus must be one of "NONE", "HELD"`)
		}
		riskHoldStatus := c.RiskHoldStatus
		if riskHoldStatus == "" {
			riskHoldStatus = "NONE"
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
			AgentID:                  c.AgentID,
			WalletAddress:            c.WalletAddress,
			Status:                   c.Status,
			Category:                 c.Category,
			SkillTags:                c.SkillTags,
			Level:                    level,
			MaxConcurrentTasks:       c.MaxConcurrentTasks,
			ActiveTaskCount:          c.ActiveTaskCount,
			CompletedTaskCount:       c.CompletedTaskCount,
			SuccessCount:             c.SuccessCount,
			OverdueCount:             c.OverdueCount,
			QualityScore:             c.QualityScore,
			CreatedAt:                createdAt,
			IsNewcomer:               domain.IsNewcomer(c.CompletedTaskCount),
			IsBanned:                 c.IsBanned,
			SemanticSimilarity:       c.SemanticSimilarity,
			ReputationSignals:        toDomainReputationSignals(c.ReputationSignals),
			BaselineEvaluationStatus: baselineEvaluationStatus,
			RiskHoldStatus:           riskHoldStatus,
		})
	}

	return task, candidates, nil
}

// isValidBaselineEvaluationStatus reports whether s is one of the four
// enum values 0032_add_agents_baseline_evaluation_status.sql's CHECK
// constraint allows (Feature 20/T-2009) — this service is a trust boundary
// for apps/api's candidate snapshot exactly like every other field
// convertMatchRequest validates above.
func isValidBaselineEvaluationStatus(s string) bool {
	switch s {
	case "NOT_STARTED", "PENDING", "PASSED", "FAILED":
		return true
	default:
		return false
	}
}

// isValidRiskHoldStatus reports whether s is one of the two enum values
// 0034_add_agents_risk_hold_status.sql's CHECK constraint allows (Feature
// 20/T-2008) — same trust-boundary reasoning as isValidBaselineEvaluationStatus.
func isValidRiskHoldStatus(s string) bool {
	switch s {
	case "NONE", "HELD":
		return true
	default:
		return false
	}
}

// toDomainReputationSignals converts the wire's nilable pointer-to-object
// shape to domain.ReputationSignals' plain-value zero-means-absent shape.
// A nil wire object (the whole "reputationSignals" key absent or explicit
// JSON null) and an explicitly-present object with every field null both
// produce the same all-nil domain.ReputationSignals{} — ScoreV2 already
// treats those two input shapes identically (see its own doc comment), so
// this function doesn't need to preserve the distinction past this point.
func toDomainReputationSignals(signals *matchReputationSignals) domain.ReputationSignals {
	if signals == nil {
		return domain.ReputationSignals{}
	}
	return domain.ReputationSignals{
		CompletionRate:  signals.CompletionRate,
		QualityFeedback: signals.QualityFeedback,
		Communication:   signals.Communication,
		DisputeSignal:   signals.DisputeSignal,
		HistoricalScale: signals.HistoricalScale,
	}
}

// validateReputationSignalsRange checks every present field of signals (nil
// itself is valid — see matchReputationSignals' doc comment) is within
// [0, 1], the range every F-1308 signal definition is normalized to. A nil
// field is skipped, not defaulted to any value, matching F-1309. Checked in
// this fixed field order — same convention as the sequential candidate
// field checks above it — so a request with multiple out-of-range fields
// always reports the same one first.
func validateReputationSignalsRange(signals *matchReputationSignals) error {
	if signals == nil {
		return nil
	}
	if signals.CompletionRate != nil && (*signals.CompletionRate < 0 || *signals.CompletionRate > 1) {
		return fmt.Errorf("reputationSignals.completionRate must be between 0 and 1")
	}
	if signals.QualityFeedback != nil && (*signals.QualityFeedback < 0 || *signals.QualityFeedback > 1) {
		return fmt.Errorf("reputationSignals.qualityFeedback must be between 0 and 1")
	}
	if signals.Communication != nil && (*signals.Communication < 0 || *signals.Communication > 1) {
		return fmt.Errorf("reputationSignals.communication must be between 0 and 1")
	}
	if signals.DisputeSignal != nil && (*signals.DisputeSignal < 0 || *signals.DisputeSignal > 1) {
		return fmt.Errorf("reputationSignals.disputeSignal must be between 0 and 1")
	}
	if signals.HistoricalScale != nil && (*signals.HistoricalScale < 0 || *signals.HistoricalScale > 1) {
		return fmt.Errorf("reputationSignals.historicalScale must be between 0 and 1")
	}
	return nil
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
//
// Scoring branch (Feature 13, T-1305): "v0.2" calls scoring.ScoreAllV2
// (ReputationSignals-based, never errors); every other value — including
// "v0.1" and any unrecognized string — goes through the untouched
// scoring.ScoreAll path, which still fails loudly on an unrecognized
// version via weightsFor. This `if` is the only place that knows two
// scoring entry points exist; nothing downstream (slotting, explain) is
// aware which one produced a given ScoreResult.
func runMatchPipeline(task domain.TaskFeatures, candidates []domain.CandidateSnapshot) (matchResponse, error) {
	eligible := eligibility.Filter(task, candidates)

	var scored []scoring.ScoreResult
	if task.AlgorithmVersion == "v0.2" {
		scored = scoring.ScoreAllV2(eligible)
	} else {
		var err error
		scored, err = scoring.ScoreAll(task, eligible)
		if err != nil {
			return matchResponse{}, err
		}
	}

	boundCandidates := make([]slotting.ScoredCandidate, 0, len(scored))
	for i, result := range scored {
		boundCandidates = append(boundCandidates, slotting.ScoredCandidate{
			Result:             result,
			CompletedTaskCount: eligible[i].CompletedTaskCount,
			// F-1309/F-1312 (Feature 13, T-1304 round 2 fix): a "v0.2"
			// candidate with no historical sample must never win a
			// TOP_SCORE slot on its Score alone — result.NoHistoricalSample
			// is always false for a v0.1 Score/ScoreAll result, so this
			// line is a no-op for every "v0.1" request.
			ExcludeFromTopScore: result.NoHistoricalSample,
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
