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

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
