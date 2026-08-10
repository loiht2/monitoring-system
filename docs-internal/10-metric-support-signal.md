# 10 — Metric support signal

A panel with no line has two very different causes: the GPU **cannot** produce that metric, or something is
**broken**. Grafana renders both as `No data`. This document specifies the signal that separates them.

---

## 1. The metric

```
gpu_metric_supported{gpu_uuid, mig_uuid, metric, source} 1|0
```

| Value | Meaning |
|---|---|
| `1` | This GPU produces this metric |
| `0` | This GPU **cannot** produce it — hardware or driver does not implement it |
| *absent* | Unknown. Never guessed |

`metric` carries the exposed metric name (`nvml_gpu_power_watts`, `DCGM_FI_PROF_PIPE_INT_ACTIVE`), so a panel
joins on the name it already plots. `source` is `nvml` or `dcgm`.

### 1.1 Why this may emit 0, when the rest of the system must not

[02 § 5.2](02-metric-catalog.md) forbids substituting zero for an unreadable measurement, because a zero is
indistinguishable from a real reading and corrupts every average, rate and alert over the series.

**That rule governs measurements. This is a capability fact.** Here `0` is not a missing measurement standing
in for a real one — it is the assertion "this GPU does not implement this", which is exactly the information
the dashboard needs and cannot get from absence alone. The two are not in conflict, and `gpu_metric_supported`
must not be "corrected" to omit its zeros.

---

## 2. Two producers, because only one half can be probed

### 2.1 NVML — probed, authoritative

The exporter already inspects every NVML return code. It maps them directly:

| NVML return | Emitted |
|---|---|
| `SUCCESS` | `1` |
| `ERROR_NOT_SUPPORTED` | `0` |
| any other error | **nothing** |

The third row is the load-bearing one. A transient failure — driver busy, device lost, permission — is not
evidence of unsupported, and recording it as `0` would leave a permanent false claim in a series the dashboard
presents as fact. Unknown stays unknown.

### 2.2 DCGM — inferred from evidence

DCGM is a separate exporter; we cannot ask it what a GPU supports. A `PrometheusRule` derives it instead. For
field `F` and GPU `g`, `F` is unsupported when **all three** hold:

1. the DCGM exporter is up — otherwise absence means outage,
2. `g` reports some other DCGM field — otherwise absence means that GPU is not being collected at all,
3. `F` is absent for `g`.

Conditions 1 and 2 are what stop an outage from being reported to operators as a hardware limitation.

**This requires the field to be requested.** A field absent from the counters ConfigMap proves nothing, so
fields believed unsupported are **kept in the list** rather than removed — the opposite of the rule for fields
DCGM rejects outright.

| Field | In the list? | Why |
|---|---|---|
| `DCGM_FI_PROF_PIPE_INT_ACTIVE` | **Yes** | Logs `metric not enabled` and is skipped. Harmless, and its absence is the evidence |
| `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` | **No, never** | Not a known field in this DCGM build. An unknown field is **fatal**: the exporter serves nothing at all ([09 — R-DCGM-FIELDS](09-risks-and-open-questions.md)) |

Confusing these two costs every DCGM metric on the node.

### 2.3 One name from an exporter and a recording rule

[01 § 3.3](01-architecture.md) forbids one metric name being emitted by two **exporters**, because duplicate
series break the scrape. A recording rule is a Prometheus-side derivation evaluated after ingestion, not a
second exporter, so it cannot collide with one.

`gpu_metric_supported` is therefore written by the NVML exporter (`source="nvml"`) and by the rule
(`source="dcgm"`). This is the one sanctioned derivation of a name an exporter also writes. The alternative —
two names — pushes a union into every panel query for no gain. Any further producer of this name needs the
same explicit justification.

---

## 3. Presentation

| Surface | Shows |
|---|---|
| **Support matrix** — one table panel | Every metric × GPU, as `Supported` / `Not supported on this GPU` |
| **Per-panel note** — a stat under each timeseries | The metrics unsupported on the currently selected GPUs. Empty when all are supported |

The per-panel note answers the question where the operator is already looking; the matrix gives the whole
picture. Neither invents text for a metric whose support is unknown — an absent flag renders nothing.

---

## 4. What this does not do

- It does not explain **why** a metric is unsupported. Architecture, driver version and MIG mode all cause it,
  and distinguishing them needs information neither exporter has.
- It does not cover eBPF metrics. Those are per-pod behaviour, not device capability.
- It says nothing about a metric that is supported but idle. That is `No data`, and correctly so.
