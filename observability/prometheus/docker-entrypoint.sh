#!/bin/sh
set -eu

# T-2305: writes the real METRICS_SCRAPE_TOKEN value (this container's own
# env var, never baked into any committed file) to the path
# prometheus.yml's own `bearer_token_file` reads. Fails loudly rather than
# starting Prometheus with an empty/missing token file, which would
# otherwise silently scrape with no Authorization header and always get a
# 401 (apps/api's fail-closed default).
if [ -z "${METRICS_SCRAPE_TOKEN:-}" ]; then
  echo "docker-entrypoint.sh: METRICS_SCRAPE_TOKEN is not set" >&2
  exit 1
fi
printf '%s' "$METRICS_SCRAPE_TOKEN" > /etc/prometheus/metrics-token

exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --web.console.libraries=/usr/share/prometheus/console_libraries \
  --web.console.templates=/usr/share/prometheus/consoles
