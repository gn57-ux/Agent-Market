package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Fixed UUID-shaped test IDs. taskId and candidates[].agentId are now
// validated as UUID-format strings (capsule T-708, category 4), so the
// human-readable taskIDFixture/agentEligible1Fixture-style IDs the fixtures used
// before this Task are no longer legal wire input — these constants keep
// each test's IDs distinct and stable without losing that readability
// entirely (the variable names still say what each ID represents).
const (
	taskIDFixture              = "11111111-1111-1111-1111-111111111111"
	agentEligible1Fixture      = "22222222-2222-2222-2222-222222222221"
	agentEligible2Fixture      = "22222222-2222-2222-2222-222222222222"
	agentNewcomerFixture       = "22222222-2222-2222-2222-222222222223"
	agentIneligibleStatusFix   = "22222222-2222-2222-2222-222222222224"
	agentIneligibleCategoryFix = "22222222-2222-2222-2222-222222222225"
	agent1Fixture              = "33333333-3333-3333-3333-333333333331"
	agent2Fixture              = "33333333-3333-3333-3333-333333333332"
	agentAFixture              = "44444444-4444-4444-4444-444444444441"
	agentBFixture              = "44444444-4444-4444-4444-444444444442"
	agentOtherFixture          = "44444444-4444-4444-4444-444444444443"
	agentDupFixture            = "44444444-4444-4444-4444-444444444444"
)

// validCandidate returns a JSON-decodable map for one eligible candidate,
// merged/overridden by overrides. Used to build request bodies without
// repeating every field in each test.
func validCandidate(agentID string, overrides map[string]any) map[string]any {
	base := map[string]any{
		"agentId":            agentID,
		"walletAddress":      "0x" + strings.Repeat("a", 40),
		"status":             "ACTIVE",
		"category":           "design",
		"skillTags":          []string{"figma", "branding"},
		"level":              "INTERMEDIATE",
		"maxConcurrentTasks": 5,
		"activeTaskCount":    0,
		"completedTaskCount": 10,
		"successCount":       8,
		"overdueCount":       1,
		"qualityScore":       0.8,
		"createdAt":          "2024-01-01T00:00:00Z",
		"isBanned":           false,
	}
	for k, v := range overrides {
		base[k] = v
	}
	return base
}

func validRequestBody(candidates []map[string]any) map[string]any {
	return map[string]any{
		"taskId":           taskIDFixture,
		"category":         "design",
		"skillTags":        []string{"figma"},
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel":    "BEGINNER",
		"requesterAddress": "0x" + strings.Repeat("b", 40),
		"algorithmVersion": "v0.1",
		"candidates":       candidates,
	}
}

func postMatch(t *testing.T, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to marshal request body: %v", err)
	}
	return postMatchRaw(t, raw)
}

func postMatchRaw(t *testing.T, raw []byte) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodPost, "/match", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestHandleMatch_HappyPath(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agentEligible1Fixture, map[string]any{"completedTaskCount": 10, "successCount": 9}),
		validCandidate(agentEligible2Fixture, map[string]any{"completedTaskCount": 20, "successCount": 15}),
		validCandidate(agentNewcomerFixture, map[string]any{"completedTaskCount": 1, "successCount": 1}),
		validCandidate(agentIneligibleStatusFix, map[string]any{"status": "INACTIVE"}),
		validCandidate(agentIneligibleCategoryFix, map[string]any{"category": "engineering"}),
	}

	rec := postMatch(t, validRequestBody(candidates))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp matchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.TaskID != taskIDFixture {
		t.Errorf("expected taskId %q, got %q", taskIDFixture, resp.TaskID)
	}
	if resp.AlgorithmVersion != "v0.1" {
		t.Errorf("expected algorithmVersion v0.1, got %q", resp.AlgorithmVersion)
	}

	// 3 eligible candidates -> 2 TOP_SCORE + 1 EXPLORATION.
	if len(resp.Recommendations) != 3 {
		t.Fatalf("expected 3 recommendations, got %d: %+v", len(resp.Recommendations), resp.Recommendations)
	}

	slotTypes := map[string]int{}
	agentIDs := map[string]bool{}
	for _, rec := range resp.Recommendations {
		slotTypes[rec.SlotType]++
		agentIDs[rec.AgentID] = true
		if len(rec.Reasons) == 0 {
			t.Errorf("expected non-empty reasons for %s", rec.AgentID)
		}
	}
	if slotTypes["TOP_SCORE"] != 2 {
		t.Errorf("expected 2 TOP_SCORE slots, got %d", slotTypes["TOP_SCORE"])
	}
	if slotTypes["EXPLORATION"] != 1 {
		t.Errorf("expected 1 EXPLORATION slot, got %d", slotTypes["EXPLORATION"])
	}
	for _, ineligible := range []string{agentIneligibleStatusFix, agentIneligibleCategoryFix} {
		if agentIDs[ineligible] {
			t.Errorf("ineligible candidate %s should not appear in recommendations", ineligible)
		}
	}
}

func TestHandleMatch_AllIneligible_ReturnsEmptyArrayNotNull(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"status": "INACTIVE"}),
		validCandidate(agent2Fixture, map[string]any{"category": "engineering"}),
	}

	rec := postMatch(t, validRequestBody(candidates))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Assert on the raw body: json.Unmarshal into a Go slice can't
	// distinguish `[]` from `null` the way the wire body can, so check the
	// literal bytes.
	body := rec.Body.String()
	if !strings.Contains(body, `"recommendations":[]`) {
		t.Fatalf("expected recommendations to be an empty array, got body: %s", body)
	}
}

func TestHandleMatch_InvalidJSON(t *testing.T) {
	rec := postMatchRaw(t, []byte(`{not valid json`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleMatch_EmptyTaskID(t *testing.T) {
	body := validRequestBody(nil)
	body["taskId"] = ""

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleMatch_InvalidCandidateLevel(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"level": "NOT_A_LEVEL"}),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleMatch_InvalidRequiredLevel(t *testing.T) {
	body := validRequestBody(nil)
	body["requiredLevel"] = "NOT_A_LEVEL"

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandleMatch_InvalidAlgorithmVersion(t *testing.T) {
	body := validRequestBody([]map[string]any{validCandidate(agent1Fixture, nil)})
	body["algorithmVersion"] = "v99.9"

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// Regression for Codex round 1 P2: a request with two candidates sharing
// one AgentID but different CompletedTaskCount must not let a map-based
// lookup silently bind the WRONG duplicate's CompletedTaskCount to the
// winning (higher-scoring, post-dedup) scored candidate —
// runMatchPipeline now binds CompletedTaskCount by the shared index
// scoring.ScoreAll preserves from its input, not by an AgentID-keyed map
// (which only remembers whichever duplicate was processed last).
//
// Fixture design (all candidates share category/skillTags with the task,
// so categoryCompatibility=1.0 and tagSimilarity=1.0 for everyone —
// scores differ only via completionRate/qualityScore, which are fully
// controlled below):
//   - agent-a, agent-b: two clear TOP_SCORE winners.
//   - agent-other: a non-newcomer (completedTaskCount=10) remaining
//     candidate with a HIGHER score than agent-dup's winning entry.
//   - agent-dup: two raw entries for the same AgentID. The higher-scoring
//     one (completedTaskCount=1, a newcomer) must win the score comparison
//     and be the one slotting actually keeps; the lower-scoring one
//     (completedTaskCount=50, NOT a newcomer) is listed LAST in the
//     request so a map-based ("last write wins") binding would
//     incorrectly attach completedTaskCount=50 to the winning entry.
//
// With the fix (index-aligned binding), agent-dup's winning entry is
// correctly bound to completedTaskCount=1 → it IS a newcomer → the
// newcomer pool is {agent-dup} (agent-other is excluded, not a newcomer)
// → EXPLORATION is drawn from that pool → agent-dup wins the slot,
// regardless of agent-other's higher raw score (PRD: newcomer pool takes
// priority over score-ranked fallback when non-empty).
//
// With the bug (AgentID-map binding), agent-dup would incorrectly read
// completedTaskCount=50 → NOT a newcomer → the newcomer pool would be
// empty → slotting falls back to the highest-scoring remaining candidate,
// which is agent-other, not agent-dup. This is the exact, observable,
// deterministic difference this test pins down.
func TestHandleMatch_DuplicateAgentID_BindsCompletedTaskCountToWinningSnapshot(t *testing.T) {
	skillTags := []string{"figma"}
	candidates := []map[string]any{
		validCandidate(agentAFixture, map[string]any{
			"skillTags": skillTags, "completedTaskCount": 10, "successCount": 10, "qualityScore": 1.0,
		}), // score = 0.30+0.30+0.20*1.0+0.20*1.0 = 1.00
		validCandidate(agentBFixture, map[string]any{
			"skillTags": skillTags, "completedTaskCount": 10, "successCount": 9, "qualityScore": 0.9,
		}), // score = 0.60+0.20*0.9+0.20*0.9 = 0.96
		validCandidate(agentOtherFixture, map[string]any{
			"skillTags": skillTags, "completedTaskCount": 10, "successCount": 10, "qualityScore": 0.5,
		}), // score = 0.60+0.20*1.0+0.20*0.5 = 0.90, not a newcomer
		validCandidate(agentDupFixture, map[string]any{
			"skillTags": skillTags, "completedTaskCount": 1, "successCount": 0, "qualityScore": 0.3,
		}), // WINNING entry: score = 0.60+0.20*0+0.20*0.3 = 0.66, a newcomer (completedTaskCount=1)
		validCandidate(agentDupFixture, map[string]any{
			"skillTags": skillTags, "completedTaskCount": 50, "successCount": 1, "qualityScore": 0.1,
		}), // LOSING entry, listed last: score = 0.60+0.20*0.02+0.20*0.1 = 0.624, not a newcomer
	}

	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp matchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	var explorationAgentID string
	for _, r := range resp.Recommendations {
		if r.SlotType == "EXPLORATION" {
			explorationAgentID = r.AgentID
		}
	}
	if explorationAgentID != agentDupFixture {
		t.Fatalf("expected EXPLORATION to go to agent-dup (correctly bound to completedTaskCount=1, a newcomer) — got %q instead, which means CompletedTaskCount was mis-bound to the wrong duplicate's value: %+v", explorationAgentID, resp.Recommendations)
	}
}

func TestHandleMatch_ReasonsAreExplainChineseText(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, nil),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp matchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(resp.Recommendations) != 1 {
		t.Fatalf("expected 1 recommendation, got %d", len(resp.Recommendations))
	}

	reasons := resp.Recommendations[0].Reasons
	if len(reasons) == 0 {
		t.Fatal("expected non-empty reasons")
	}
	// explain.Explain always returns human-readable Chinese text, never a
	// raw Reason struct's field names (e.g. it must not contain "Code" or
	// "NormalizedValue", which a raw json.Marshal(scoring.Reason) would).
	for _, reason := range reasons {
		if strings.Contains(reason, "Code") || strings.Contains(reason, "NormalizedValue") {
			t.Errorf("reason %q looks like raw Reason struct JSON, not explain.ExplainAll text", reason)
		}
	}
	found := false
	for _, reason := range reasons {
		if reason == "任务分类完全匹配" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected the category-match Chinese reason text among %v", reasons)
	}
}

// --- T-708: input-validation coverage (human supplemental review, P1) ---
//
// The tests below cover each of the capsule's 10 validation categories,
// positive and negative. They deliberately assert on rec.Code plus a
// substring of the error body, not full string equality, per
// errInvalidRequest's convention that every rejection carries a
// field-identifiable message (not one generic "invalid request" for
// everything).

// TestHandleMatch_RequestBodyTooLarge covers capsule category 1
// (http.MaxBytesReader body-size cap). category is padded far past
// maxMatchRequestBodyBytes (5MB); the request must be rejected before
// json.Decoder even runs, regardless of whether the rest of the payload
// would otherwise be valid.
func TestHandleMatch_RequestBodyTooLarge(t *testing.T) {
	body := validRequestBody(nil)
	body["category"] = strings.Repeat("x", maxMatchRequestBodyBytes+1024)

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleMatch_UnknownTopLevelField covers capsule category 2
// (DisallowUnknownFields).
func TestHandleMatch_UnknownTopLevelField(t *testing.T) {
	body := validRequestBody(nil)
	body["notARealField"] = "surprise"

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleMatch_DuplicateKey_TopLevel covers capsule category 3 at the
// matchRequest level: the same top-level key ("taskId") appears twice in
// the raw JSON object. encoding/json's default behavior would silently
// keep the second value; checkNoDuplicateKeys must reject this before
// decode.
func TestHandleMatch_DuplicateKey_TopLevel(t *testing.T) {
	raw := []byte(`{
		"taskId": "11111111-1111-1111-1111-111111111111",
		"taskId": "22222222-2222-2222-2222-222222222222",
		"category": "design",
		"skillTags": [],
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel": "BEGINNER",
		"requesterAddress": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"algorithmVersion": "v0.1",
		"candidates": []
	}`)
	rec := postMatchRaw(t, raw)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "duplicate key") {
		t.Errorf("expected error to mention duplicate key, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_DuplicateKey_Candidate covers capsule category 3 at the
// matchCandidate level: a duplicate key inside one element of the
// "candidates" array.
func TestHandleMatch_DuplicateKey_Candidate(t *testing.T) {
	raw := []byte(`{
		"taskId": "11111111-1111-1111-1111-111111111111",
		"category": "design",
		"skillTags": [],
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel": "BEGINNER",
		"requesterAddress": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"algorithmVersion": "v0.1",
		"candidates": [{
			"agentId": "22222222-2222-2222-2222-222222222222",
			"agentId": "33333333-3333-3333-3333-333333333333",
			"walletAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"status": "ACTIVE",
			"category": "design",
			"skillTags": [],
			"level": "INTERMEDIATE",
			"maxConcurrentTasks": 5,
			"activeTaskCount": 0,
			"completedTaskCount": 10,
			"successCount": 8,
			"overdueCount": 1,
			"qualityScore": 0.8,
			"createdAt": "2024-01-01T00:00:00Z",
			"isBanned": false
		}]
	}`)
	rec := postMatchRaw(t, raw)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "duplicate key") {
		t.Errorf("expected error to mention duplicate key, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_DuplicateKey_CaseVariant covers the case-insensitive
// bypass Codex flagged in T-708 round 1 (P2): encoding/json binds a JSON
// key to a struct field case-insensitively when no exact-match field
// exists, so a byte-for-byte-only duplicate check would miss
// {"taskId":..., "TaskId":...} even though both values collide into the
// same Go field.
func TestHandleMatch_DuplicateKey_CaseVariant(t *testing.T) {
	raw := []byte(`{
		"taskId": "11111111-1111-1111-1111-111111111111",
		"TaskId": "22222222-2222-2222-2222-222222222222",
		"category": "design",
		"skillTags": [],
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel": "BEGINNER",
		"requesterAddress": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"algorithmVersion": "v0.1",
		"candidates": []
	}`)
	rec := postMatchRaw(t, raw)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "duplicate key") {
		t.Errorf("expected error to mention duplicate key, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_DuplicateKey_Candidate_CaseVariant is the candidate-level
// counterpart of TestHandleMatch_DuplicateKey_CaseVariant.
func TestHandleMatch_DuplicateKey_Candidate_CaseVariant(t *testing.T) {
	raw := []byte(`{
		"taskId": "11111111-1111-1111-1111-111111111111",
		"category": "design",
		"skillTags": [],
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel": "BEGINNER",
		"requesterAddress": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"algorithmVersion": "v0.1",
		"candidates": [{
			"agentId": "22222222-2222-2222-2222-222222222222",
			"AgentId": "33333333-3333-3333-3333-333333333333",
			"walletAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"status": "ACTIVE",
			"category": "design",
			"skillTags": [],
			"level": "INTERMEDIATE",
			"maxConcurrentTasks": 5,
			"activeTaskCount": 0,
			"completedTaskCount": 10,
			"successCount": 8,
			"overdueCount": 1,
			"qualityScore": 0.8,
			"createdAt": "2024-01-01T00:00:00Z",
			"isBanned": false
		}]
	}`)
	rec := postMatchRaw(t, raw)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "duplicate key") {
		t.Errorf("expected error to mention duplicate key, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_TaskIDNotUUID covers capsule category 4 (taskId).
func TestHandleMatch_TaskIDNotUUID(t *testing.T) {
	body := validRequestBody(nil)
	body["taskId"] = "not-a-uuid"

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "taskId") {
		t.Errorf("expected error to mention taskId, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_AgentIDNotUUID covers capsule category 4 (agentId).
func TestHandleMatch_AgentIDNotUUID(t *testing.T) {
	candidates := []map[string]any{
		validCandidate("not-a-uuid", nil),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "agentId") {
		t.Errorf("expected error to mention agentId, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_RequesterAddressNotWalletFormat covers capsule category 5
// (requesterAddress).
func TestHandleMatch_RequesterAddressNotWalletFormat(t *testing.T) {
	body := validRequestBody(nil)
	body["requesterAddress"] = "0xnothex"

	rec := postMatch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "requesterAddress") {
		t.Errorf("expected error to mention requesterAddress, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_CandidateWalletAddressNotWalletFormat covers capsule
// category 5 (walletAddress).
func TestHandleMatch_CandidateWalletAddressNotWalletFormat(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"walletAddress": "not-an-address"}),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "walletAddress") {
		t.Errorf("expected error to mention walletAddress, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_InvalidStatus covers capsule category 6.
func TestHandleMatch_InvalidStatus(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"status": "PENDING"}),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "status") {
		t.Errorf("expected error to mention status, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_NegativeCountFields covers capsule category 7 (each
// count field's own >= 0 range).
func TestHandleMatch_NegativeCountFields(t *testing.T) {
	fields := []string{"activeTaskCount", "completedTaskCount", "successCount", "overdueCount"}
	for _, field := range fields {
		t.Run(field, func(t *testing.T) {
			candidates := []map[string]any{
				validCandidate(agent1Fixture, map[string]any{field: -1}),
			}
			rec := postMatch(t, validRequestBody(candidates))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), field) {
				t.Errorf("expected error to mention %s, got: %s", field, rec.Body.String())
			}
		})
	}
}

// TestHandleMatch_MaxConcurrentTasksOutOfRange covers capsule category 7
// (MaxConcurrentTasks's mirrored DB CHECK range, 1..100).
func TestHandleMatch_MaxConcurrentTasksOutOfRange(t *testing.T) {
	for _, v := range []int{0, 101} {
		t.Run(fmt.Sprintf("%d", v), func(t *testing.T) {
			candidates := []map[string]any{
				validCandidate(agent1Fixture, map[string]any{"maxConcurrentTasks": v}),
			}
			rec := postMatch(t, validRequestBody(candidates))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestHandleMatch_MaxConcurrentTasksBoundaryValuesAllowed is the positive
// counterpart to TestHandleMatch_MaxConcurrentTasksOutOfRange: the
// inclusive boundary values 1 and 100 must both be accepted.
func TestHandleMatch_MaxConcurrentTasksBoundaryValuesAllowed(t *testing.T) {
	for _, v := range []int{1, 100} {
		t.Run(fmt.Sprintf("%d", v), func(t *testing.T) {
			candidates := []map[string]any{
				validCandidate(agent1Fixture, map[string]any{"maxConcurrentTasks": v}),
			}
			rec := postMatch(t, validRequestBody(candidates))
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestHandleMatch_SuccessCountExceedsCompletedTaskCount covers capsule
// category 7's cross-field relationship: successCount must not exceed
// completedTaskCount.
func TestHandleMatch_SuccessCountExceedsCompletedTaskCount(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"completedTaskCount": 5, "successCount": 6}),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "successCount") {
		t.Errorf("expected error to mention successCount, got: %s", rec.Body.String())
	}
}

// TestHandleMatch_SuccessCountEqualsCompletedTaskCountAllowed is the
// positive boundary counterpart: successCount == completedTaskCount is
// legal (every completed task succeeded).
func TestHandleMatch_SuccessCountEqualsCompletedTaskCountAllowed(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"completedTaskCount": 5, "successCount": 5}),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleMatch_ActiveTaskCountExceedingMaxConcurrentTasksAllowed pins
// down the capsule's explicit "do NOT add this check" instruction: a
// snapshot with ActiveTaskCount > MaxConcurrentTasks (a possible transient
// race-condition artifact upstream) must still be accepted, not rejected.
func TestHandleMatch_ActiveTaskCountExceedingMaxConcurrentTasksAllowed(t *testing.T) {
	candidates := []map[string]any{
		validCandidate(agent1Fixture, map[string]any{"maxConcurrentTasks": 2, "activeTaskCount": 5}),
	}
	rec := postMatch(t, validRequestBody(candidates))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (activeTaskCount > maxConcurrentTasks must NOT be rejected per capsule), got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleMatch_QualityScoreOutOfRange covers capsule category 8.
func TestHandleMatch_QualityScoreOutOfRange(t *testing.T) {
	for _, v := range []float64{-0.01, 1.01} {
		t.Run(fmt.Sprintf("%v", v), func(t *testing.T) {
			candidates := []map[string]any{
				validCandidate(agent1Fixture, map[string]any{"qualityScore": v}),
			}
			rec := postMatch(t, validRequestBody(candidates))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "qualityScore") {
				t.Errorf("expected error to mention qualityScore, got: %s", rec.Body.String())
			}
		})
	}
}

// TestHandleMatch_QualityScoreBoundaryValuesAllowed is the positive
// counterpart: 0 and 1 (the inclusive range endpoints) and nil (no
// recorded score yet) must all be accepted.
func TestHandleMatch_QualityScoreBoundaryValuesAllowed(t *testing.T) {
	for _, v := range []any{0.0, 1.0, nil} {
		t.Run(fmt.Sprintf("%v", v), func(t *testing.T) {
			candidates := []map[string]any{
				validCandidate(agent1Fixture, map[string]any{"qualityScore": v}),
			}
			rec := postMatch(t, validRequestBody(candidates))
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestHandleMatch_EmptyCategory covers capsule category 9, for both the
// task-level and candidate-level category field.
func TestHandleMatch_EmptyCategory(t *testing.T) {
	t.Run("task", func(t *testing.T) {
		body := validRequestBody(nil)
		body["category"] = ""
		rec := postMatch(t, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("candidate", func(t *testing.T) {
		candidates := []map[string]any{
			validCandidate(agent1Fixture, map[string]any{"category": ""}),
		}
		rec := postMatch(t, validRequestBody(candidates))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
	})
}

// TestHandleMatch_EmptySkillTagsAllowed covers capsule category 10: an
// empty skillTags array is a legal "no skill requirement" state, not a
// validation failure, for both the task and the candidate.
func TestHandleMatch_EmptySkillTagsAllowed(t *testing.T) {
	body := validRequestBody([]map[string]any{
		validCandidate(agent1Fixture, map[string]any{"skillTags": []string{}}),
	})
	body["skillTags"] = []string{}

	rec := postMatch(t, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}
