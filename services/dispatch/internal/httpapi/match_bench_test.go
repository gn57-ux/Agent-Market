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

// TestMatchP95UnderTarget translates AC-704's "P95 < 300ms for 1000
// candidates" requirement into a concrete, failable go test assertion by
// actually timing each of matchP95SampleCount individual requests (not
// relying on testing.Benchmark's aggregate mean), sorting the samples, and
// checking the 95th-percentile latency itself against matchTargetP95.
func TestMatchP95UnderTarget(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping benchmark-driven check in -short mode")
	}

	raw := benchmarkMatchRequestBody(1000)
	mux := http.NewServeMux()
	RegisterRoutes(mux)

	durations := make([]time.Duration, matchP95SampleCount)
	for i := 0; i < matchP95SampleCount; i++ {
		req := httptest.NewRequest(http.MethodPost, "/match", bytes.NewReader(raw))
		rec := httptest.NewRecorder()

		start := time.Now()
		mux.ServeHTTP(rec, req)
		durations[i] = time.Since(start)

		if rec.Code != http.StatusOK {
			t.Fatalf("sample %d: expected 200, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	// The 95th percentile of N sorted samples is conventionally the value
	// at index ceil(0.95*N)-1; for N=100 that is index 94 (the 95th value).
	p95Index := int(float64(matchP95SampleCount)*0.95) - 1
	if p95Index < 0 {
		p95Index = 0
	}
	p95 := durations[p95Index]
	max := durations[len(durations)-1]

	t.Logf("measured latencies for 1000-candidate POST /match over %d samples: min=%s p95=%s max=%s (target P95 < %s)",
		matchP95SampleCount, durations[0], p95, max, matchTargetP95)

	if p95 >= matchTargetP95 {
		t.Fatalf("measured P95 latency %s exceeds the 300ms target (%s) for a 1000-candidate POST /match request (max observed: %s)", p95, matchTargetP95, max)
	}
}
