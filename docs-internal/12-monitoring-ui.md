# 12 — Advanced monitoring UI

A native web UI for this system's metrics, modelled on the ML Platform's own metrics surface so it can later
be folded in as a microservice rather than ported.

Two new deployables, both in this repository:

| Service | Stack | Role |
|---|---|---|
| `advanced-monitoring-api` | FastAPI + httpx | Proxies Prometheus, and serves the panel spec |
| `advanced-monitoring-ui` | Next.js 15, standalone output | The UI |

---

## 1. Panels are data, not code

58 panels exist across the three Grafana dashboards. Hand-writing 58 React components would guarantee drift
from [02 — the metric catalog](02-metric-catalog.md), which is the whole point of having a catalog.

```
docs-internal/02-metric-catalog.md      human source of truth
        │   enforced by scripts/check-dashboards.py
        ▼
dashboards/*.json                       Grafana, checker-verified
        │   scripts/extract-panels.py
        ▼
ui/panels.json                          machine-readable spec
        │   GET /catalog
        ▼
seven generic renderers                 the only React written
```

`panels.json` is **derived from the Grafana JSON**, which the checker already proves matches the catalog.
The native UI therefore cannot disagree with Grafana, and adding a metric stays a catalog edit followed by a
regeneration — never a frontend change.

### 1.1 PromQL lives in the spec

The ML Platform hardcodes its queries in `Overview.tsx`, where they drift silently from anything else. Here
the query text travels with the panel, so the UI never composes PromQL and there is exactly one place a
query can be wrong.

### 1.2 Seven renderers cover everything

| Renderer | Panels | Notes |
|---|---|---|
| `timeseries` | 42 | Chart.js line, the bulk of the work |
| `table` | 5 | Instant query, `transformations` honoured |
| `gauge` | 4 | SVG arc; the platform's `SemiGauge` is the reference |
| `stat` | 3 | Single reduced value |
| `bargauge` | 2 | Horizontal bars, one per series |
| `state-timeline` | 1 | **No Chart.js equivalent.** Custom SVG bands |
| `heatmap` | 1 | **No Chart.js equivalent.** Custom canvas over histogram buckets |

The last two are the only genuinely novel work; they are deliberately last in the phasing.

---

## 2. Data flow

```
browser ──► advanced-monitoring-ui ──► advanced-monitoring-api ──► Prometheus
                                          (httpx, in-cluster DNS)
```

The browser never reaches Prometheus directly — same shape as the ML Platform, and for the same reasons:
one place to add auth, no CORS, and Prometheus is never exposed.

`PROMETHEUS_URL` defaults to `prometheus-operated.gpu-monitoring.svc.cluster.local:9090` and is overridable
by environment, matching how `quota_api` resolves its own upstreams.

### 2.1 Endpoints

| Route | Purpose |
|---|---|
| `GET /catalog` | The panel spec: dashboards, rows, panels, queries |
| `GET /query?q=&time=` | Prometheus instant query |
| `GET /query_range?q=&start=&end=&step=` | Prometheus range query |
| `GET /label/{name}/values` | Template-variable values, e.g. `gpu_uuid` |
| `GET /healthz` | Liveness |

`/query` and `/query_range` **raise** on upstream failure (503/502); `/catalog` and `/label/...` **degrade**
to an empty result with HTTP 200. This split is copied from `quota_api` on purpose: a failed query is a
foreground error the user asked for, a failed sidebar lookup is not.

### 2.2 The `$gpu` template variable

The Grafana dashboards carry one variable, `gpu`, over `label_values(gpu_uuid)`, multi-select with an "All"
option. Panel expressions embed it as `gpu_uuid=~"$gpu"`.

The UI reproduces this: it fetches values from `/label/gpu_uuid/values`, and substitutes the selection into
`$gpu` as a regex alternation before sending the query. `All` substitutes `.*`. Substitution happens **in the
frontend immediately before the request**, so the stored spec stays identical to the Grafana source.

---

## 3. Behaviour carried over from the ML Platform

These are not stylistic preferences; each one exists because its absence is a visible bug.

- **Silent refresh.** A refresh never blanks the screen. Stale values stay until new ones arrive.
- **`Promise.allSettled` everywhere.** One dead panel query must not blank the other 57.
- **In-place chart updates.** Update the dataset and call `update()`; never destroy and recreate, which
  flickers the canvas on every refresh.
- **A refresh-interval selector persisted to `localStorage`**, with an SSR guard on read.
- **Never fabricate data.** No synthetic or interpolated series when a query returns nothing.

### 3.1 Empty states must distinguish three causes

An empty panel is ambiguous, and the ambiguity is exactly what this project spent weeks removing:

| Cause | How the UI knows | What it says |
|---|---|---|
| Unsupported on this hardware | `gpu_metric_supported` is `0` for that metric | "Not supported on this GPU" |
| Nothing running | Query succeeded, empty result, support is `1` or absent | "No data in this range" |
| Prometheus unreachable | `/query` returned 502/503 | "Prometheus unreachable" |

The first row is why `gpu_metric_supported` exists ([10](10-metric-support-signal.md)) and is the one thing
Grafana never rendered well.

### 3.2 A time-range picker, which the platform lacks

The ML Platform hardcodes 12 points at 60s. Replacing Grafana means offering at least the ranges Grafana
does: 5m, 15m, 1h, 6h, 24h, 7d, with `step` derived to keep each request near 200 points.

---

## 4. Styling

Follow the ML Platform's **admin-section** convention, since that is what its monitoring surfaces actually
use: inline `style={{}}` with CSS custom properties — `var(--bg-panel,#161b22)`,
`var(--border-color,#30363d)`, `var(--text-muted)`, radius 10 — and **not** Tailwind, which is installed
there but unused in those files.

This is a deliberate choice to match the destination, not an endorsement. It is recorded here so the eventual
merge is a file move.

---

## 5. Exposure

**No authentication in the standalone phase.** Reached by `ClusterIP` plus `kubectl port-forward`, exactly as
Prometheus and Grafana are reached on the validation cluster today.

**This is a validation-phase decision with a hard boundary.** The API proxies *arbitrary PromQL*, so anything
that can reach it can read every metric in the cluster. Two rules follow:

- The Service stays `ClusterIP`. No NodePort, no Ingress, in this phase.
- **Keycloak is a prerequisite for ML Platform integration, not a later nicety.** That platform's
  `/monitoring/*` routes sit behind `require_auth`, which despite its name is admin-only; this API must reach
  parity before it is deployed beside them.

---

## 6. Grafana is not deleted

"Replace" means users stop needing Grafana, not that the dashboards go away. They remain:

- the extractor's **input**, so deleting them breaks the build,
- the target `scripts/check-dashboards.py` verifies against the catalog,
- the debugging fallback when the native UI is itself suspect.

---

## 7. Phasing

| Phase | Delivers |
|---|---|
| 1 | API service, extractor, `panels.json`, Overview page |
| 2 | The five conventional renderers — ~52 of 58 panels |
| 3 | `state-timeline` and `heatmap` |
| 4 | Deployment manifests; then ML Platform integration, where auth becomes Keycloak |

Each phase leaves something running. Phase 1 alone is a usable overview.
