#!/usr/bin/env bash
# Run one PromQL instant query against the Prometheus deployed by this project.
# Usage: scripts/promq.sh 'up{job="gpu-dcgm"}'
# Prints one line per series: <value> <labels>
set -euo pipefail

NS="${NS:-gpu-monitoring}"
QUERY="${1:?usage: promq.sh '<promql>'}"
PORT="${PROMQ_PORT:-19090}"

kubectl -n "$NS" port-forward svc/prometheus-operated "${PORT}:9090" >/dev/null 2>&1 &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  # Fail fast rather than polling a dead forward for 15s and then crashing
  # confusingly downstream.
  kill -0 "$PF_PID" 2>/dev/null || { echo "port-forward to svc/prometheus-operated in ns $NS failed" >&2; exit 1; }
  curl -sf "http://127.0.0.1:${PORT}/-/ready" >/dev/null 2>&1 && break
  sleep 0.5
done

# NOT -f on this one. curl -f suppresses the response body on any non-2xx, and
# a bad query or an unready Prometheus returns its explanation IN the body —
# which is exactly what _promq_fmt.py's "status != success" branch prints.
# With -f the formatter gets zero bytes and dies with a JSONDecodeError instead.
curl -sG "http://127.0.0.1:${PORT}/api/v1/query" --data-urlencode "query=${QUERY}" \
  | python3 "$(cd "$(dirname "$0")" && pwd)/_promq_fmt.py"
