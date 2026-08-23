package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		"taskId":           "task-1",
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
		validCandidate("agent-eligible-1", map[string]any{"completedTaskCount": 10, "successCount": 9}),
		validCandidate("agent-eligible-2", map[string]any{"completedTaskCount": 20, "successCount": 15}),
		validCandidate("agent-newcomer", map[string]any{"completedTaskCount": 1, "successCount": 1}),
		validCandidate("agent-ineligible-status", map[string]any{"status": "INACTIVE"}),
		validCandidate("agent-ineligible-category", map[string]any{"category": "engineering"}),
	}

	rec := postMatch(t, validRequestBody(candidates))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp matchResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.TaskID != "task-1" {
		t.Errorf("expected taskId task-1, got %q", resp.TaskID)
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
	for _, ineligible := range []string{"agent-ineligible-status", "agent-ineligible-category"} {
		if agentIDs[ineligible] {
			t.Errorf("ineligible candidate %s should not appear in recommendations", ineligible)
		}
	}
}

func TestHandleMatch_AllIneligible_ReturnsEmptyArrayNotNull(t *testing.T) {
	candidates := []map[string]any{
		validCandidate("agent-1", map[string]any{"status": "INACTIVE"}),
		validCandidate("agent-2", map[string]any{"category": "engineering"}),
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
		validCandidate("agent-1", map[string]any{"level": "NOT_A_LEVEL"}),
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
	body := validRequestBody([]map[string]any{validCandidate("agent-1", nil)})
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
		validCandidate("agent-a", map[string]any{
			"skillTags": skillTags, "completedTaskCount": 10, "successCount": 10, "qualityScore": 1.0,
		}), // score = 0.30+0.30+0.20*1.0+0.20*1.0 = 1.00
		validCandidate("agent-b", map[string]any{
			"skillTags": skillTags, "completedTaskCount": 10, "successCount": 9, "qualityScore": 0.9,
		}), // score = 0.60+0.20*0.9+0.20*0.9 = 0.96
		validCandidate("agent-other", map[string]any{
			"skillTags": skillTags, "completedTaskCount": 10, "successCount": 10, "qualityScore": 0.5,
		}), // score = 0.60+0.20*1.0+0.20*0.5 = 0.90, not a newcomer
		validCandidate("agent-dup", map[string]any{
			"skillTags": skillTags, "completedTaskCount": 1, "successCount": 0, "qualityScore": 0.3,
		}), // WINNING entry: score = 0.60+0.20*0+0.20*0.3 = 0.66, a newcomer (completedTaskCount=1)
		validCandidate("agent-dup", map[string]any{
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
	if explorationAgentID != "agent-dup" {
		t.Fatalf("expected EXPLORATION to go to agent-dup (correctly bound to completedTaskCount=1, a newcomer) — got %q instead, which means CompletedTaskCount was mis-bound to the wrong duplicate's value: %+v", explorationAgentID, resp.Recommendations)
	}
}

func TestHandleMatch_ReasonsAreExplainChineseText(t *testing.T) {
	candidates := []map[string]any{
		validCandidate("agent-1", nil),
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
