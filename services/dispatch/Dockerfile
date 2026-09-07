# T-2302 (Feature 23): services/dispatch container image. Build context is
# the repo root (this module has no cross-module Go dependency, but keeping
# the same build-context convention as the Node services avoids a second,
# divergent build-invocation pattern) — build with:
#   docker build -f services/dispatch/Dockerfile -t agent-market-dispatch .
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY services/dispatch/ .
RUN go mod download
# N4 review (round 1, T-2302): `go build -o` does create `/out` itself if
# missing (verified empirically — `docker build --no-cache` succeeds with
# no prior `/out` in this stage), but making it explicit removes any doubt
# for a future reader/reviewer.
RUN mkdir -p /out && CGO_ENABLED=0 go build -o /out/dispatch-server ./cmd/server

FROM alpine:3.20 AS runtime
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=build /out/dispatch-server ./dispatch-server
EXPOSE 8081
# GET /healthz is routes.go's existing capability-advertisement endpoint
# (T-2302 adds no new endpoint — reuses what already exists).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${DISPATCH_PORT:-8081}/healthz || exit 1
CMD ["./dispatch-server"]
