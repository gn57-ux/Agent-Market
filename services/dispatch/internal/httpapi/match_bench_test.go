package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"
)

// matchTargetP95 is AC-704's benchmark target: the full POST /match pipeline
// (eligibility -> scoring -> slotting -> explain, driven end-to-end through
// the real HTTP handler) must complete in under 300ms for 1000 candidates.
const matchTargetP95 = 300 * time.Millisecond

// matchV02TargetP95 is AC-1308's benchmark target (Feature 13, T-1307):
// "v0.2 计算耗时不劣化到超出...300ms P95 基准一个数量级" — v0.2 does
// genuinely more work per candidate than v0.1 (the semantic OR-branch
// check, a 5-signal weighted-average computation instead of a 4-sub-score
// one), so AC-1308 deliberately does NOT re-assert the SAME 300ms ceiling;
// it only guards against an order-of-magnitude regression, i.e. up to 10x
// v0.1's own target.
const matchV02TargetP95 = 10 * matchTargetP95

// levelLiterals/statusLiterals/categoryLiterals/skillTagPool back
// benchmarkMatchRequestBody's realistic, non-identical candidate
// distribution: cycling through varied categories/skills/levels/statuses/
// scores exercises the same sort/hash/map-building code paths a uniform,
// all-identical candidate set would mask (identical candidates could let
// e.g. a map keyed by a single repeated value degenerate to O(1) instead of
// the real O(n) distinct-key cost).
var (
	levelLiterals    = []string{"BEGINNER", "INTERMEDIATE", "EXPERT"}
	categoryLiterals = []string{"design", "engineering", "writing", "marketing"}
	skillTagPool     = []string{"figma", "branding", "golang", "react", "solidity", "copywriting", "seo", "video"}
)

// benchmarkMatchRequestBody builds a realistic 1000-candidate POST /match
// request body: candidates vary across category/skill tags/level/quality
// score/completion history/ban status so eligibility filtering and scoring
// both do real, varied work instead of operating on a degenerate uniform
// input.
func benchmarkMatchRequestBody(candidateCount int) []byte {
	candidates := make([]map[string]any, 0, candidateCount)
	for i := 0; i < candidateCount; i++ {
		category := categoryLiterals[i%len(categoryLiterals)]
		// Roughly 60% of candidates share the task's category (design) so
		// eligibility.Filter does real filtering work rather than passing
		// or rejecting everything uniformly.
		if i%5 < 3 {
			category = "design"
		}

		tagCount := 1 + i%3
		tags := make([]string, 0, tagCount)
		for j := 0; j < tagCount; j++ {
			tags = append(tags, skillTagPool[(i+j)%len(skillTagPool)])
		}

		var qualityScore any
		if i%7 == 0 {
			qualityScore = nil // some candidates have no recorded score yet
		} else {
			qualityScore = float64(i%100) / 100.0
		}

		status := "ACTIVE"
		if i%23 == 0 {
			status = "INACTIVE"
		}

		// completedTaskCount/successCount must satisfy successCount <=
		// completedTaskCount and both >= 0 (T-708's new validation) —
		// deriving successCount as a modulus of (completedTaskCount+1)
		// guarantees that relationship holds for every i, unlike the
		// previous (i%30)-(i%7) formula, which could go negative (e.g.
		// i=34: 4-6=-2) and would now be rejected as invalid input.
		completedTaskCount := i % 30
		successCount := i % (completedTaskCount + 1)

		candidates = append(candidates, map[string]any{
			// agentId is now validated as UUID-shaped (T-708 category 4);
			// this deterministic, i-derived hex string satisfies
			// uuidPattern while staying unique per candidate.
			"agentId":            fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i),
			"walletAddress":      fmt.Sprintf("0x%040x", i+1),
			"status":             status,
			"category":           category,
			"skillTags":          tags,
			"level":              levelLiterals[i%len(levelLiterals)],
			"maxConcurrentTasks": 3 + i%5,
			"activeTaskCount":    i % 4,
			"completedTaskCount": completedTaskCount,
			"successCount":       successCount,
			"overdueCount":       i % 3,
			"qualityScore":       qualityScore,
			"createdAt":          "2024-01-01T00:00:00Z",
			"isBanned":           i%97 == 0,
		})
	}

	body := map[string]any{
		// taskId is now validated as UUID-shaped (T-708 category 4).
		"taskId":           "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		"category":         "design",
		"skillTags":        []string{"figma", "branding"},
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel":    "BEGINNER",
		"requesterAddress": fmt.Sprintf("0x%040x", 999999),
		"algorithmVersion": "v0.1",
		"candidates":       candidates,
	}

	raw, err := json.Marshal(body)
	if err != nil {
		panic(fmt.Sprintf("benchmarkMatchRequestBody: failed to marshal: %v", err))
	}
	return raw
}

// benchmarkMatchRequestBodyV02 is benchmarkMatchRequestBody's "v0.2"
// counterpart (Feature 13, T-1307/AC-1308): same realistic, varied
// 1000-candidate distribution, plus the two v0.2-only fields every real
// apps/api request would attach (dispatch/routes.ts's
// resolveAlgorithmVersionAndEnrichCandidates, T-1303) — semanticSimilarity
// (a real float in [-1,1]) and reputationSignals (all five sub-fields,
// with some candidates missing individual signals or the whole object, so
// ScoreV2's per-signal-missing and all-missing paths both get real,
// varied work instead of a degenerate uniform input).
func benchmarkMatchRequestBodyV02(candidateCount int) []byte {
	candidates := make([]map[string]any, 0, candidateCount)
	for i := 0; i < candidateCount; i++ {
		category := categoryLiterals[i%len(categoryLiterals)]
		if i%5 < 3 {
			category = "design"
		}

		tagCount := 1 + i%3
		tags := make([]string, 0, tagCount)
		for j := 0; j < tagCount; j++ {
			tags = append(tags, skillTagPool[(i+j)%len(skillTagPool)])
		}

		var qualityScore any
		if i%7 == 0 {
			qualityScore = nil
		} else {
			qualityScore = float64(i%100) / 100.0
		}

		status := "ACTIVE"
		if i%23 == 0 {
			status = "INACTIVE"
		}

		completedTaskCount := i % 30
		successCount := i % (completedTaskCount + 1)

		// semanticSimilarity spans [-0.2, 0.98] across candidates —
		// includes values both above and below eligibility's real
		// v02SemanticSimilarityThreshold (0.64), so the OR-branch admits
		// some category-mismatched candidates and rejects others, real
		// varied work rather than a uniform accept-or-reject-all input.
		semanticSimilarity := -0.2 + float64(i%120)/100.0

		var reputationSignals map[string]any
		switch i % 4 {
		case 0:
			// All five signals missing — exercises ScoreV2's dedicated
			// "no historical sample" path (a real, common shape for a
			// brand-new Agent, not an edge case to under-represent).
			reputationSignals = nil
		case 1:
			// Every signal present.
			reputationSignals = map[string]any{
				"completionRate":  float64(i%100) / 100.0,
				"qualityFeedback": float64((i+13)%100) / 100.0,
				"communication":   float64((i+29)%100) / 100.0,
				"disputeSignal":   float64((i+41)%100) / 100.0,
				"historicalScale": float64((i+59)%100) / 100.0,
			}
		default:
			// Some signals present, some missing — exercises the
			// renormalization path.
			reputationSignals = map[string]any{
				"completionRate":  float64(i%100) / 100.0,
				"qualityFeedback": nil,
				"communication":   float64((i+29)%100) / 100.0,
				"disputeSignal":   nil,
				"historicalScale": float64((i+59)%100) / 100.0,
			}
		}

		candidates = append(candidates, map[string]any{
			"agentId":            fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i),
			"walletAddress":      fmt.Sprintf("0x%040x", i+1),
			"status":             status,
			"category":           category,
			"skillTags":          tags,
			"level":              levelLiterals[i%len(levelLiterals)],
			"maxConcurrentTasks": 3 + i%5,
			"activeTaskCount":    i % 4,
			"completedTaskCount": completedTaskCount,
			"successCount":       successCount,
			"overdueCount":       i % 3,
			"qualityScore":       qualityScore,
			"createdAt":          "2024-01-01T00:00:00Z",
			"isBanned":           i%97 == 0,
			"semanticSimilarity": semanticSimilarity,
			"reputationSignals":  reputationSignals,
		})
	}

	body := map[string]any{
		"taskId":           "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		"category":         "design",
		"skillTags":        []string{"figma", "branding"},
		"deliveryDeadline": "2024-06-01T00:00:00Z",
		"requiredLevel":    "BEGINNER",
		"requesterAddress": fmt.Sprintf("0x%040x", 999999),
		"algorithmVersion": "v0.2",
		"candidates":       candidates,
	}

	raw, err := json.Marshal(body)
	if err != nil {
		panic(fmt.Sprintf("benchmarkMatchRequestBodyV02: failed to marshal: %v", err))
	}
	return raw
}

// BenchmarkHandleMatch_1000Candidates drives the real POST /match HTTP
// handler (via httptest.NewRecorder/httptest.NewRequest, not a direct
// in-process function call) with 1000 realistic, non-identical candidates,
// once per b.N iteration, per AC-704's benchmark methodology.
func BenchmarkHandleMatch_1000Candidates(b *testing.B) {
	raw := benchmarkMatchRequestBody(1000)

	mux := http.NewServeMux()
	RegisterRoutes(mux)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest(http.MethodPost, "/match", bytes.NewReader(raw))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			b.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
	}
}

// matchP95SampleCount is how many individual POST /match requests
// TestMatchP95UnderTarget times to compute an actual 95th-percentile
// latency (Codex review, T-704 round 1, P2: NsPerOp from testing.Benchmark
// is a MEAN across all iterations, not a percentile — a small number of
// slow outlier requests above 300ms can be diluted by many fast ones and
// still pass a mean-based check, which is not what AC-704's "P95 < 300ms"
// actually requires). 100 samples is enough to compute a meaningful P95
// (the 95th of 100 sorted samples) without the default benchmark's
// open-ended 1-second run time.
const matchP95SampleCount = 100

// measureMatchP95 times sampleCount individual real POST /match requests
// against raw (not testing.Benchmark's aggregate mean — Codex review, T-704
// round 1, P2: a mean dilutes a small number of slow outliers, which a P95
// target must not let pass) and returns the sorted min/p95/max latencies.
// Shared by TestMatchP95UnderTarget (v0.1, AC-704) and
// TestMatchV02P95UnderTarget (v0.2, AC-1308, Feature 13/T-1307) so both
// benchmarks measure identically — only the request body and target differ.
func measureMatchP95(raw []byte, sampleCount int) (minD, p95, max time.Duration) {
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	durations := make([]time.Duration, sampleCount)
	for i := 0; i < sampleCount; i++ {
		req := httptest.NewRequest(http.MethodPost, "/match", bytes.NewReader(raw))
		rec := httptest.NewRecorder()

		start := time.Now()
		mux.ServeHTTP(rec, req)
		durations[i] = time.Since(start)

		if rec.Code != http.StatusOK {
			panic(fmt.Sprintf("sample %d: expected 200, got %d: %s", i, rec.Code, rec.Body.String()))
		}
	}

	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	// The 95th percentile of N sorted samples is conventionally the value
	// at index ceil(0.95*N)-1; for N=100 that is index 94 (the 95th value).
	p95Index := int(float64(sampleCount)*0.95) - 1
	if p95Index < 0 {
		p95Index = 0
	}
	return durations[0], durations[p95Index], durations[len(durations)-1]
}

// TestMatchP95UnderTarget translates AC-704's "P95 < 300ms for 1000
// candidates" requirement into a concrete, failable go test assertion.
func TestMatchP95UnderTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping benchmark-driven check in -short mode")
	}

	raw := benchmarkMatchRequestBody(1000)
	minD, p95, max := measureMatchP95(raw, matchP95SampleCount)

	t.Logf("measured latencies for 1000-candidate v0.1 POST /match over %d samples: min=%s p95=%s max=%s (target P95 < %s)",
		matchP95SampleCount, minD, p95, max, matchTargetP95)

	if p95 >= matchTargetP95 {
		t.Fatalf("measured P95 latency %s exceeds the 300ms target (%s) for a 1000-candidate POST /match request (max observed: %s)", p95, matchTargetP95, max)
	}
}

// TestMatchV02P95UnderTarget translates AC-1308's "v0.2 计算耗时不劣化到
// 超出...300ms P95 基准一个数量级" requirement into a concrete, failable
// go test assertion (Feature 13, T-1307) — same real end-to-end HTTP
// pipeline and measurement methodology as TestMatchP95UnderTarget, but
// against a real "v0.2" 1000-candidate request (semanticSimilarity +
// varied reputationSignals on every candidate, so eligibility's OR-branch
// and ScoreV2's renormalization/all-missing paths all do real work) and
// checked against matchV02TargetP95 (10x v0.1's target), not the same
// 300ms ceiling.
func TestMatchV02P95UnderTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping benchmark-driven check in -short mode")
	}

	raw := benchmarkMatchRequestBodyV02(1000)
	minD, p95, max := measureMatchP95(raw, matchP95SampleCount)

	t.Logf("measured latencies for 1000-candidate v0.2 POST /match over %d samples: min=%s p95=%s max=%s (target P95 < %s)",
		matchP95SampleCount, minD, p95, max, matchV02TargetP95)

	if p95 >= matchV02TargetP95 {
		t.Fatalf("measured v0.2 P95 latency %s exceeds AC-1308's target (%s, 10x the v0.1 baseline) for a 1000-candidate POST /match request (max observed: %s)", p95, matchV02TargetP95, max)
	}
}
