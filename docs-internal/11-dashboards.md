# 11 — Dashboards

Two dashboards, split by **what the reader is asking about**, not by which exporter produced the number.

| Dashboard | Answers | Sources behind it |
|---|---|---|
| **GPU Hardware** | What is the silicon doing, who holds it, and is it healthy? | DCGM, NVML, `gpu_alloc_*`, `gpu_metric_supported` |
| **GPU Software** | What is each pod asking CUDA to do, and where is it waiting? | eBPF CUDA tracing |

## 1. Source is an implementation detail

The Hardware dashboard merges DCGM and NVML and never says which is which. A reader asking "is this GPU
busy?" does not care that occupancy comes from DCGM and power from NVML; they care that both describe the
card. Ownership still governs the *metric names* ([01 § 3.3](01-architecture.md)) — that rule exists to stop
duplicate series, not to organise a UI.

Where the two disagree, the disagreement is the signal, and those panels say so explicitly rather than
silently preferring one.

## 2. Panel type follows the measurement

A dashboard of nothing but line charts hides most of what it shows. Type is chosen per metric:

| Type | For | Because |
|---|---|---|
| `stat` | Totals and counts over the window — launches, errors, OOM events, GPUs online | One number, read at a glance; a line adds nothing |
| `gauge` | A bounded *current* value — utilization, memory fraction, temperature | The bound is the meaning: 0.9 matters only because the ceiling is 1.0 |
| `bargauge` | The same value compared *across GPUs* | Ranking is the question; overlapping lines answer it badly |
| `timeseries` | Anything whose *change* is the point — rates, trends, latency quantiles | |
| `heatmap` | Latency distributions from histogram buckets | A bimodal stall is invisible in a P95 line and obvious in a heatmap |
| `state-timeline` | Things that are on or off — throttle reasons, support | Shows *when* and *how long*, which a line chart of 0/1 does not |
| `table` | Identity and inventory — allocation, support matrix | Rows of labels, not a series over time |

## 3. Panels are named for the question, not the metric

A panel titled `DCGM_FI_PROF_SM_OCCUPANCY` tells the reader nothing they could not get from the query. Every
panel carries:

- **A title in plain language** — "SM Occupancy", "Who is holding each GPU".
- **A description saying what the number means and when to care.** Not a restatement of the title: "Resident
  warps against the hardware maximum. High occupancy does not imply useful work — a kernel can fill the SMs
  and still be memory-bound."

Metric names belong in the query and the description, never the title.

## 4. Layout

Both dashboards use **rows**, collapsed by default below the first, so the top of the page is a summary and
detail is one click away.

**GPU Hardware**

| Row | Contents |
|---|---|
| Overview | GPUs online, pods holding a GPU, total power, hottest card — `stat` |
| Utilization | Current busy fraction per GPU (`gauge`), utilization and occupancy over time |
| Memory | Used against total per GPU (`bargauge`), memory over time, per-pod memory |
| Power & Thermals | Current draw and temperature (`gauge`), trends |
| Clocks & Throttling | Clock frequencies, and which throttle reason is active (`state-timeline`) |
| Per-Pod | Which pod is on which card and how hard (`table`, `timeseries`) |
| Allocation & Support | Entitlement rows, and the metric support matrix (`table`) |

**GPU Software** follows the upstream eBPF-Lens layout, which is already sound: Overview (`stat`) → Compute
Activity → Memory Activity → Errors → Synchronization Latency → Kernel Dimensions.

## 5. Rules that must survive editing

- **eBPF panels aggregate by `k8s_namespace_name` and `k8s_pod_name`.** Using `namespace`/`pod` does not
  fail — it returns a plausible number attributed to the exporter's own pod, because those labels describe
  the scrape target. This is the single easiest way to make an eBPF panel confidently wrong.
- **eBPF series also carry `gpu_uuid`**, so software activity can be correlated with hardware on the same
  card without a join through pod identity.
- **An empty panel is not necessarily broken.** The support matrix distinguishes "this GPU cannot produce
  this" from "nothing is running" ([10](10-metric-support-signal.md)). Panels for metrics that are commonly
  unsupported link to it in their description.
- **Latency quantiles need the `_bucket` series**, so histogram families keep their buckets even though the
  per-metric panels use `_sum` and `_count`.
