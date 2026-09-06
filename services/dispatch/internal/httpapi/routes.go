package httpapi

import (
	"encoding/json"
	"net/http"
)

// RegisterRoutes wires the dispatch service's HTTP endpoints onto mux.
func RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/match", handleMatch)
}

// healthzCapabilities is /healthz's capability advertisement. apps/api's
// dispatch.client.ts (Feature 20/T-2008, N4 round-2 follow-up decision)
// polls this to confirm a running dispatch instance actually understands
// `riskHoldStatus`/`enforceRiskHoldGate` before claiming
// EnforceRiskHoldGate=true on a real /match request — an OLDER dispatch
// instance's /healthz response simply omits this key entirely (this
// service's own established "unknown field/key is safe to omit, never a
// breaking wire change" convention, same direction as every other
// rolling-deploy-safe field in this package).
var healthzCapabilities = []string{"risk_hold_gate"}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":       "ok",
		"capabilities": healthzCapabilities,
	})
}
