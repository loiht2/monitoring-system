# 10 — Metric support signal

A panel with no line has two very different causes: the GPU **cannot** produce that metric, or something is
**broken**. Grafana renders both as `No data`. This document specifies the signal that separates them.

---

## 1. The metric

```
gpu_metric_supported{gpu_uuid, mig_uuid, GPU_I_ID, metric, source} 1|0
```

| Value | Meaning |
|---|---|
| `1` | This entity produces this metric |
| `0` | This entity **cannot** produce it — hardware or driver does not implement it |
| *absent* | Unknown. Never guessed |

`metric` carries the exposed metric name (`nvml_gpu_power_watts`, `DCGM_FI_PROF_PIPE_INT_ACTIVE`), so a panel
joins on the name it already plots. `source` is `nvml` or `dcgm`.

### 1.1 Why this may emit 0, when the rest of the system must not

[02 § 5](02-metric-catalog.md) forbids substituting zero for an unreadable measurement, because a zero is
indistinguishable from a real reading and corrupts every average, rate and alert over the series.

**That rule governs measurements. This is a capability fact.** Here `0` is not a missing measurement standing
in for a real one — it is the assertion "this entity does not implement this", which is exactly the
information the dashboard needs and cannot get from absence alone. The two are not in conflict, and
`gpu_metric_supported` must not be "corrected" to omit its zeros.

---

## 2. The unit is an entity, not a card

A whole card and a MIG instance are different things to ask about, and DCGM reports them as different
entities. **The unit of this signal is `(gpu_uuid, GPU_I_ID)`**: a whole card carries no `GPU_I_ID`, a
partitioned card is described only by its instances.

Treating a card as the unit would collapse every instance into one verdict for a scope DCGM no longer
describes, and would leave instances with no verdict at all.

---

## 3. Two producers, because only one half can be probed

### 3.1 NVML — probed, authoritative

The exporter inspects every NVML return code and maps it directly:

| NVML return | Emitted |
|---|---|
| `SUCCESS` | `1` |
| `ERROR_NOT_SUPPORTED` | `0` |
| any other error | **nothing** |

The third row is the load-bearing one. A transient failure — driver busy, device lost, permission — is not
evidence of unsupported, and recording it as `0` would leave a permanent false claim in a series the dashboard
presents as fact. Unknown stays unknown.

The exporter probes each handle it holds, parent and MIG instance alike, so it already emits verdicts at both
scopes.

### 3.2 DCGM — inferred from evidence

DCGM is a separate exporter; we cannot ask it what a GPU supports. A `PrometheusRule` derives it instead. For
field `F` and entity `e`, `F` is unsupported when **all three** hold:

1. the DCGM exporter is up — otherwise absence means outage,
2. `e` reports some other DCGM field — otherwise absence means that entity is not being collected at all,
3. `F` is absent for `e`.

Conditions 1 and 2 are what stop an outage from being reported to operators as a hardware limitation.

The rule groups by `(gpu_uuid, GPU_I_ID)`. `DCGM_FI_DEV_FB_USED` is the evidence metric and already reports
one row per entity, so the two sides line up without further work.

**This requires the field to be requested.** A field absent from the counters ConfigMap proves nothing, so
fields believed unsupported are **kept in the list** rather than removed — the opposite of the rule for fields
DCGM rejects outright.

| Field | In the list? | Why |
|---|---|---|
| `DCGM_FI_PROF_PIPE_INT_ACTIVE` | **Yes** | Logs `metric not enabled` and is skipped. Harmless, and its absence is the evidence |
| `DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE` | **Yes** | Field 1015. Measured: logs `metric not enabled`, skipped; support rule records `0` on both entities. The A30 executes FP64 tensor work (visible in the aggregate `PIPE_TENSOR_ACTIVE`) but has no per-pipe counter for it ([14 § 2](14-metric-evaluation.md)) |
| `DCGM_FI_PROF_NVLINK_TX_BYTES` / `..._RX_BYTES` | **Yes** | Fields 1011/1012. Measured: **collected**, reporting `0` bytes — the links are inactive, not the counter. Support rule records `1` on the whole card, `0` on the MIG instance |
| `DCGM_FI_PROF_C2C_TX_ALL_BYTES` / `..._RX_ALL_BYTES` | **Yes** | Fields 1076/1078. Measured: skipped as `metric not enabled`; support rule records `0`. C2C is Grace-Hopper hardware an A30 does not have |
| `DCGM_FI_PROF_HOSTMEM_CACHE_HIT` / `..._MISS` | **Yes** | Fields 1080/1081. Measured: skipped as `metric not enabled`; support rule records `0` |
| `DCGM_FI_PROF_PEERMEM_CACHE_HIT` / `..._MISS` | **Yes** | Fields 1082/1083. Measured: skipped as `metric not enabled`; support rule records `0` |
| `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` | **No, never** | Not a known field in this DCGM build. An unknown field is **fatal**: the exporter serves nothing at all ([09 — R-DCGM-FIELDS](09-risks-and-open-questions.md)) |

Confusing these two costs every DCGM metric on the node.

The distinction is visible in the exporter log and was verified on rollout: every field above took the
per-line `WARN … "metric not enabled"` path and the registry still built, with the actively-scraped DCGM
metric-name count rising 31 → 33 (the two NVLink fields). A fatal unknown field would have taken it to 0.

### 3.3 One name from an exporter and a recording rule

[01 § 3.3](01-architecture.md) forbids one metric name being emitted by two **exporters**, because duplicate
series break the scrape. A recording rule is a Prometheus-side derivation evaluated after ingestion, not a
second exporter, so it cannot collide with one.

`gpu_metric_supported` is therefore written by the NVML exporter (`source="nvml"`) and by the rule
(`source="dcgm"`). This is the one sanctioned derivation of a name an exporter also writes. The alternative —
two names — pushes a union into every panel query for no gain. Any further producer of this name needs the
same explicit justification.

---

## 4. Presentation

| Surface | Shows |
|---|---|
| Device support matrix | Every metric × whole card |
| MIG support matrix | Every metric × instance |

Neither invents text for a metric whose support is unknown — an absent flag renders nothing.

### 4.1 A partitioned card is skipped by the device matrix

Once MIG is enabled, DCGM stops reporting device-level profiling fields and reports instance entities instead
([02 § 4](02-metric-catalog.md)). There is nothing at device scope left to call supported or unsupported.

**The device matrix skips such a card rather than showing it as unknown.** Synthesising a `0` row would
assert "not supported" about a scope that no longer exists on that card — a claim, not a measurement.
Skipping says only what is true: this card is described per instance, and its verdicts live on the MIG
dashboard.

| Card | Device matrix | MIG matrix |
|---|---|---|
| Whole card | one row per metric | not listed |
| Partitioned card | **skipped** | one row per metric, per instance |

---

## 5. What this does not do

- It does not explain **why** a metric is unsupported. Architecture, driver version and MIG mode all cause it,
  and distinguishing them needs information neither exporter has.
- It does not cover eBPF metrics. Those are per-pod behaviour, not device capability.
- It says nothing about a metric that is supported but idle. That is `No data`, and correctly so.
