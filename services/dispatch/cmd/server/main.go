package main

import (
	"log"
	"net/http"
	"os"

	"github.com/agent-market/dispatch/internal/httpapi"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	mux := http.NewServeMux()
	httpapi.RegisterRoutes(mux)

	log.Printf("dispatch service listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
