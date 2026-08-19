# The API

`advanced-monitoring-api` is a **read-only proxy over Prometheus, plus the panel spec**. It stores nothing
and computes nothing: every number it returns came from Prometheus on that request.

It exists so the UI has one origin to talk to and one place the dashboard definition lives. It is also how
you script against this system — reading metrics without going through either dashboard.

---

## 1. Reaching it

```bash
kubectl -n gpu-monitoring get svc advanced-monitoring-api -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'
# 30800 by default
```

```bash
API=http://<node-ip>:30800
curl -s "$API/healthz"     # {"status":"ok"}
```

From inside the cluster: `http://advanced-monitoring-api.gpu-monitoring.svc.cluster.local:8000`.

The UI also re-exposes it at its own origin under `/api/*`, which is how the browser reaches it without a
cross-origin request — `http://<node-ip>:30802/api/query` and `http://<node-ip>:30800/query` are the same
endpoint.

> **No authentication, and `q` is passed through unvalidated.** Anything that can reach this port can run
> arbitrary PromQL and read every metric in the cluster. Keep it off a routable network, or put an
> authenticating proxy in front. This is a known, deliberate limitation — see
> [specs/12 § 12](../specs/12-monitoring-ui.md).

---

## 2. Endpoints

| Endpoint | Returns |
|---|---|
| `GET /healthz` | Liveness. `{"status":"ok"}` |
| `GET /catalog` | The panel spec: dashboards, rows, panels, queries — §4 |
| `GET /query?q=&time=` | Prometheus instant query. `time` optional, defaults to now |
| `GET /query_range?q=&start=&end=&step=` | Prometheus range query. `step` in **seconds**, integer |
| `GET /label/{name}/values?start=&end=&match=` | Values seen for a label — §5 |

`GET` only. There is nothing to write.

---

## 3. Querying metrics

`/query` and `/query_range` return Prometheus's `data` object **unwrapped** — the `{"status":"success","data":…}`
envelope is stripped, so you get `resultType` and `result` directly.

**Instant:**

```bash
curl -s -G "$API/query" --data-urlencode 'q=count(up)'
```
```json
{"resultType": "vector",
 "result": [{"metric": {}, "value": [1787125459.009, "4"]}]}
```

Values are **strings**, and timestamps are float epoch seconds — both are Prometheus's own convention, passed
through unchanged. Parse accordingly.

A real series carries its full label set:

```json
{"metric": {"__name__": "DCGM_FI_DEV_GPU_UTIL",
            "gpu_uuid": "GPU-26e02ca7-…", "gpu": "0", "node": "a30-node",
            "modelName": "NVIDIA A30", "pod": "nvidia-dcgm-exporter-mttkr", "…": "…"},
 "value": [1787125459.048, "0"]}
```

**Range** — `resultType` becomes `matrix` and `value` becomes `values`, a list of pairs:

```bash
NOW=$(date +%s)
curl -s -G "$API/query_range" \
  --data-urlencode 'q=DCGM_FI_DEV_GPU_UTIL' \
  --data-urlencode "start=$((NOW-300))" --data-urlencode "end=$NOW" \
  --data-urlencode 'step=60'
```
```json
{"resultType": "matrix",
 "result": [{"metric": {"__name__": "DCGM_FI_DEV_GPU_UTIL", "gpu_uuid": "GPU-26e02ca7-…"},
             "values": [[1787125171, "0"], [1787125231, "0"], [1787125291, "0"]]}]}
```

**What you can ask for is everything Prometheus holds** — all four sources plus the derived signals. This API
neither curates nor restricts the metric set:

| Prefix | Source |
|---|---|
| `DCGM_FI_*` | Hardware counters, per device and per MIG instance |
| `nvml_*` | Per-device and per-pod driver values |
| `ebpf_*` | Per-pod CUDA behaviour |
| `GPUDevice*` | HAMi entitlement per card (DRA clusters) |
| `gpu_alloc_device_pod_info` | Which pod holds which GPU |
| `gpu_metric_supported` | Whether an entity *can* produce a metric |

### Worked examples

```bash
# utilization per card
curl -s -G "$API/query" --data-urlencode 'q=DCGM_FI_DEV_GPU_UTIL'

# memory in use, per card and per MIG instance
curl -s -G "$API/query" --data-urlencode 'q=nvml_gpu_memory_used_bytes'

# which pod holds which GPU — empty when nothing is allocated
curl -s -G "$API/query" --data-urlencode 'q=gpu_alloc_device_pod_info'

# per-pod share of a shared card
curl -s -G "$API/query" \
  --data-urlencode 'q=sum by (namespace, pod, gpu_uuid) (nvml_process_sm_utilization_ratio)'
```

Pull just the numbers out rather than reading raw JSON:

```bash
curl -s -G "$API/query" --data-urlencode 'q=DCGM_FI_DEV_GPU_UTIL' | python3 -c "
import json, sys
for x in json.load(sys.stdin)['result']:
    print(f\"gpu{x['metric']['gpu']} {x['metric']['modelName']}: {x['value'][1]}%\")"
# gpu0 NVIDIA A30: 0%
```

**Always `--data-urlencode`.** PromQL contains `{`, `}`, `=`, `+` and spaces; a raw URL mangles them and you
get a parse error from Prometheus rather than an obvious client-side failure.

See [02 — Metrics](02-metrics.md) for what each metric means, and [04 — Querying](04-querying.md) for
expressions that answer real questions.

---

## 4. `/catalog` — the panel spec

The one thing here that is not just Prometheus. Generated from `dashboards/*.json` by
`scripts/extract-panels.py`, so the UI and Grafana cannot disagree about what a panel is.

```bash
curl -s "$API/catalog" | python3 -m json.tool | head -40
```

```
{ "dashboards": [ { "uid", "title", "description", "variables", "rows": [ { "title", "collapsed",
                                                                           "panels": [ … ] } ] } ],
  "variables": [ … ] }
```

Today: `gpu-hardware-device` (6 rows), `gpu-hardware-mig` (3), `gpu-software` (7); global variables `gpu`,
`migid`, `pod`.

Each panel carries what a renderer needs and nothing Grafana-specific:

```json
{"id": 1, "type": "gauge", "title": "GPU Utilization",
 "description": "…", "unit": "percentunit",
 "gridPos": {"h": 8, "w": 6, "x": 0, "y": 1},
 "targets": [{"expr": "…", "legendFormat": "…"}]}
```

`type` is Grafana's panel type (`timeseries`, `stat`, `gauge`, `bargauge`, `table`, `heatmap`,
`state-timeline`). `unit` is a Grafana unit id. `gridPos` is Grafana's 24-column grid. Thresholds and draw
styles are deliberately **dropped** — they are Grafana rendering concerns, not part of the panel's meaning.

**A panel's `expr` still contains `$gpu`, `$pod`, `$__rate_interval` and `$__range`.** Substitution is the
caller's job; the spec stays byte-identical to the dashboard JSON it came from. Send an unsubstituted
`$__range` to `/query` and Prometheus rejects it with a 400 → 503.

Two rules if you do substitute them yourself, both learned the hard way here:

- **A selection matching nothing must not become `.*`.** An empty `$pod` means *no pods*, and an empty
  alternation matches *every* pod — the exact inversion of what was asked for.
- **`$__rate_interval` is `max(step + scrape, 4 × scrape)`**, where the scrape interval in this deployment is
  **30s**. Narrower than that and the rate window straddles too few samples, producing gaps.

`services/advanced-monitoring-ui/lib/promql.ts` is the reference implementation.

> `/catalog` is served from `panels.json` **baked into the image**, not read from `dashboards/`. Editing a
> dashboard changes Grafana immediately and changes this endpoint only after the API image is rebuilt — see
> [08 § 7](08-usage.md).

---

## 5. `/label/{name}/values`

Backs the scope pickers. Two optional scopings, both worth using:

```bash
# every gpu_uuid in the retention window
curl -s -G "$API/label/gpu_uuid/values" \
  --data-urlencode "start=$((NOW-3600))" --data-urlencode "end=$NOW"
# {"values": ["GPU-26e02ca7-…", "GPU-a4d27439-…"]}

# pods that actually have eBPF data, not every pod in the cluster
curl -s -G "$API/label/k8s_pod_name/values" \
  --data-urlencode 'match=ebpf_cuda_kernel_launch_calls_total'
# {"values": ["gpu-burn-a", "gpu-burn-b"]}
```

**Unscoped in time**, Prometheus answers from the whole retention window — a MIG instance deleted hours ago is
still listed, which would put a dead entry in a picker that matches no current series. **Unscoped by metric**,
you get every pod in the cluster, including this monitoring stack's own pods, which can never appear in an
eBPF panel.

---

## 6. Errors

The two families behave differently, on purpose:

| Route | On upstream failure |
|---|---|
| `/query`, `/query_range` | **Raise** — `503` with `{"detail": "…"}`. You asked for this data; silence would be a lie |
| `/catalog`, `/label/…` | **Degrade** — `200` with an empty payload. A failed sidebar lookup should render an empty control, not break the page |

```bash
curl -s -G "$API/query" --data-urlencode 'q=this is not promql'
# HTTP 503  {"detail":"Prometheus returned 400: … parse error: unexpected identifier …"}

curl -s "$API/query"
# HTTP 422  {"detail":[{"type":"missing","loc":["query","q"],"msg":"Field required", …}]}

curl -s -G "$API/label/no_such_label/values"
# HTTP 200  {"values":[]}
```

`422` is FastAPI's own validation error for a missing or malformed parameter, before anything reaches
Prometheus. `503` means Prometheus was reached and refused, or was unreachable.

An empty `result` with `200` is **not** an error — it means the query was valid and matched nothing. That is
the normal answer for `ebpf_*` on an idle cluster.

---

## 7. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PROMETHEUS_URL` | `http://prometheus-operated.gpu-monitoring.svc.cluster.local:9090` | Upstream to proxy |
| `CORS_ORIGINS` | `http://localhost:3002,http://127.0.0.1:3002` | Browser origins allowed to call directly |

`deploy/70-advanced-monitoring.yaml` sets `PROMETHEUS_URL` and deliberately leaves `CORS_ORIGINS` unset, so
the code default applies. The deployed UI does not rely on CORS at all — it proxies `/api/*` server-side, so
the browser only ever calls the UI's own origin and there is no cross-origin request to allowlist. The
setting matters only when a browser hits this API directly in development, where `localhost` and
`127.0.0.1` count as two different origins.
