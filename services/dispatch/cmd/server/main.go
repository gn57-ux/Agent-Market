package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/agent-market/dispatch/internal/httpapi"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	mux := http.NewServeMux()
	httpapi.RegisterRoutes(mux)

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("dispatch service listening on :%s", port)
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
