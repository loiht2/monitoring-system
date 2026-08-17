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
specs/02-metric-catalog.md      human source of truth
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
| `GET /label/{name}/values?start=&end=` | Template-variable values, e.g. `gpu_uuid`, scoped to a window |
| `GET /healthz` | Liveness |

`/query` and `/query_range` **raise** on upstream failure (503/502); `/catalog` and `/label/...` **degrade**
to an empty result with HTTP 200. This split is copied from `quota_api` on purpose: a failed query is a
foreground error the user asked for, a failed sidebar lookup is not.

### 2.2 The `$gpu` template variable

The Grafana dashboards carry one variable, `gpu`, over `label_values(gpu_uuid)`, multi-select with an "All"
option. Panel expressions embed it as `gpu_uuid=~"$gpu"`.

The UI reproduces this: it substitutes the selection into `$gpu` as a regex alternation before sending the
query. `All` substitutes `.*`. Substitution happens **in the frontend immediately before the request**, so
the stored spec stays identical to the Grafana source.

**The lookup is scoped to the selected time range.** Unscoped, Prometheus answers from the whole retention
window, so a device that no longer exists is still offered. Measured on the validation cluster: a deleted MIG
instance was still listed hours later, and selecting it would have produced a panel that could never draw.

### 2.3 A bare `label_values(gpu_uuid)` is the wrong source

Time-scoping is necessary but not sufficient. Measured on the live cluster, the lookup returns **three**
values at a 6h range and two at 1h:

```
GPU-<card-0>     ← DCGM, physical card 0
GPU-<card-1>     ← DCGM, physical card 1
MIG-<instance>   ← HAMi dra-monitor, a MIG *instance*
```

**Two exporters use the label `gpu_uuid` to mean different things.** DCGM always sets it to the *parent
card*, identifying an instance separately with `GPU_I_ID`. HAMi's dra-monitor sets it to *whatever device it
allocated*, which for a MIG-backed claim is the instance UUID. Both are internally consistent; the union is
not.

[01 §3.3](01-architecture.md) forbids one metric *name* from two exporters because duplicate series break
the scrape. This is the quieter cousin: one *label key* carrying two different entity types. Nothing breaks,
so nothing complained — a MIG instance simply appeared in a picker labelled "GPU scope", and selecting it on
the Device tab produced panels that could never draw.

**The rule: a scope picker is derived from the exporter that owns the scope, never from a bare label
lookup.** Both pickers therefore read DCGM, which is the one source that describes both scopes coherently:

| Picker | Source | Yields |
|---|---|---|
| Device scope | distinct `gpu_uuid` on `DCGM_FI_DEV_FB_USED` | the physical cards — 2 here |
| MIG scope | `(gpu_uuid, GPU_I_ID, GPU_I_PROFILE)` on `DCGM_FI_DEV_FB_USED{GPU_I_ID!=""}` | the instances — 1 here |

`gpu_uuid` on a DCGM series is the parent card whether or not the card is partitioned, so the device picker
lists both cards from one query, and HAMi's `MIG-…` value cannot enter it.

### 2.4 The MIG scope needs a second variable

DCGM publishes **no MIG instance UUID** — an instance is `(gpu_uuid, GPU_I_ID)`. So selecting one instance
cannot be expressed by `$gpu` alone, and the MIG dashboard's panels currently filter only `GPU_I_ID!=""`,
which means "any instance" and cannot narrow further.

The MIG dashboard gains a second template variable, `migid`, over `GPU_I_ID`, and its panels filter
`gpu_uuid=~"$gpu", GPU_I_ID=~"$migid"`. One control in the UI presents the pair as a single choice —
`GPU 1 · 1g.6gb · id 3` — and sets both variables, because an operator picks an instance, not a coordinate.

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
use: CSS custom properties, radius 10, and **not** Tailwind, which is installed there but unused in those
files. This is a deliberate choice to match the destination, not an endorsement — it is recorded here so the
eventual merge is a file move.

**The visual design is specified in [13 — UI visual design](13-ui-visual-design.md)**: tokens, the validated
series palette, page structure, panel anatomy, and the per-renderer specs. That document supersedes this
section on every point of appearance.

---

## 5. Exposure

**No authentication, and reachable on the node address.** Both Services are `NodePort` — the API on 30800,
the UI on 30802 — because a `ClusterIP` plus `kubectl port-forward` binds to loopback *on the node*, so a
browser on any other machine reaches nothing and the page renders empty.

**This is the weakest point in the system and it is deliberate, not accidental.** `/query` proxies arbitrary
PromQL, so anything that can route to the node can read every metric in the cluster. It is acceptable only
because this is an isolated validation cluster.

Two rules follow:

- **This manifest must not be applied on a routable network** before authentication lands.
- **Keycloak is a prerequisite for ML Platform integration, not a later nicety.** That platform's
  `/monitoring/*` routes sit behind `require_auth`, which despite its name is admin-only; this API must reach
  parity before it is deployed beside them.

### 5.1 The browser is told no address at all

An earlier design handed the browser the API's address at container start (`env.js` → `MONITORING_API`) and
listed the UI's origin in the API's `CORS_ORIGINS`. Both values are properties of *how the deployment is
reached*, not of the code, so both were wrong on any cluster but the one they were written for — and both
failed identically and silently: pod healthy, page loads, nothing renders, reason only in the browser
console.

The UI now proxies `/api/*` to the API server-side (`app/api/[...path]/route.ts`, upstream from
`MONITORING_API_UPSTREAM`, in-cluster DNS). **The browser only ever calls the UI's own origin.** No address
reaches the page, so there is nothing cluster-specific to get wrong and no cross-origin request to
configure.

One trap worth recording: this must be a **route handler**, not a `next.config.js` rewrite. Next serializes
rewrite destinations into `routes-manifest.json` at build time, so the deployment's environment variable is
read and silently ignored — reproducing the identical failure the change set out to remove.

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
