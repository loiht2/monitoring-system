# 05 — eBPF CUDA-tracing exporter

**Deliverable: a build of an existing GPU-instrumented agent, renamed, deployed as our own manifest.**
Metric list in [02 § 4](02-metric-catalog.md).

---

## 1. The two repositories, tracked as submodules

| Repository | Role |
|---|---|
| `eBPF-Lens-core` | Instrumentation core — BPF programs, CUDA/HAMi probes, metric definitions |
| `eBPF-Lens` | Distributable agent; carries the chart, dashboards and examples, and tracks the core as its own submodule |

The agent already declares the core as a submodule pinned to a branch, so **this repository adds `eBPF-Lens`
as a submodule and inherits the chain**:

```
monitoring-system
  └─ exporters/ebpf/eBPF-Lens          (submodule, pinned commit)
       └─ .obi-src → eBPF-Lens-core    (submodule, pinned commit)
```

Both repositories are ours, so this is a fork we maintain rather than an upstream we petition.

**Why a submodule rather than documented refs.** A pinned commit pair is the difference between a
reproducible build and a build that depends on whichever branch state a developer happens to have. CI clones
with `--recurse-submodules` and needs no external checkout instructions.

**Consequence — a change is a three-step promotion.** Edit the core → the agent bumps its `.obi-src` pointer →
this repository bumps its `eBPF-Lens` pointer. A change made only in the agent's vendored copy is lost at the
next sync; a change made only in the core never reaches a built image. The submodule makes each hop an explicit
commit instead of an undocumented assumption.

---

## 2. The metric rename

Upstream emits GPU families under `gpu_*`; we rename to `ebpf_cuda_*` / `ebpf_hami_*` (D-12). This makes
prefix-by-source universal across all four sources, and removes a real ambiguity — with vGPUmonitor emitting
`hami_*`, an eBPF family named `gpu_hami_*` sits adjacent to it while measuring something entirely different
(API-interception timing versus the library's own accounting).

Metric identities are declared as a three-field record:

```go
type Name struct {
    Section Section  // attribute-selection configuration key
    Prom    string   // Prometheus name    ← only this changes
    OTEL    string   // OpenTelemetry name
}
```

**Only `Prom` changes** — twenty string literals in one file. `Section` untouched, so existing configuration
keys keep working; `OTEL` untouched, so OTLP consumers are unaffected. Beyond that file: unit-test
expectations, the checked-in Grafana dashboard, documentation, and the re-vendor.

**One-way door.** Renaming after dashboards exist means rewriting every panel and recorded rule. It happens
once, before deployment.

---

## 3. Deployment

Where a previous build is running it is **replaced, not supplemented** — two privileged `hostPID` agents means
two sets of uprobes on the same CUDA library. Where the previous deployment is a Helm release, uninstall it and
redeploy as numbered YAML (D-7).

**Snapshot before uninstalling.** A hand-built image at a tag with no reproducible source pin is a
configuration artifact existing nowhere else: capture release values, rendered manifest, DaemonSet and any
referenced ConfigMap, and store the snapshot outside the repository
([09 — R-5](09-risks-and-open-questions.md)). Confirm nothing consumes the outgoing agent's non-GPU metrics
first (OQ-3).

| Requirement | Reason |
|---|---|
| `privileged` | BPF program loading and uprobe attachment |
| `hostPID` | Resolving traced processes to containers |
| `hostNetwork` | As deployed upstream. **The container port becomes a host port**, colliding with anything else on that number — including the DCGM exporter's conventional port. Assign a distinct host port explicitly |
| Kernel with BTF and uprobe support | Probes attach to userspace library symbols |

---

## 4. Configuration traps

Each yields **zero GPU metrics with a healthy-looking agent** — no error, an endpoint serving other families
normally. They are why "deployed successfully" means nothing here without a metric-level check.

| Trap | Requirement |
|---|---|
| Instrumentation selection excludes the GPU family | The Prometheus export instrumentation set must include GPU instrumentation explicitly, or be a wildcard |
| Discovery does not match the workload | Discovery must select the workload containers; a default matching nothing produces silence |
| Probes declared optional | An absent family may mean "the workload never called that function", not "broken" |
| Workload links a different CUDA library path | Uprobes attach to a resolved path inside the container's mount namespace |
| Metric expiry | See below |

**Metric expiry.** The agent drops a series whose flow has been idle beyond a TTL. Harmless for continuous
training; for bursty workloads a series appears and disappears, breaking `rate()` over long windows and making
counters look like resets. Keep the scrape interval well below the TTL, and handle absent series explicitly in
dashboards. Raising the TTL trades agent memory for continuity and should be measured.

---

## 5. Cardinality — the system's dominant cost

Twelve histogram families multiplied by pod × CUDA function × memory/copy kind, each histogram costing one
series per bucket plus sum and count. **This exporter produces roughly an order of magnitude more active
series than every other source combined**, so:

- Backend retention and memory sizing are driven by this exporter alone
  ([07 § 3.3](07-backend-and-deployment.md)).
- Deploy it **last**, after real backend memory consumption has been measured with the cheap exporters running.
- To reduce cardinality, drop *label dimensions* (e.g. aggregate over CUDA function name), not whole families.
  A dropped dimension loses detail; a dropped family loses a capability.

---

## 6. Export path

The Prometheus endpoint, not OTLP push — a failed scrape target is visible as staleness, whereas a failed push
is indistinguishable from an idle workload. A ServiceMonitor selects the agent's service, which under
`hostNetwork` targets the host port.

**Capability boundary:** this exporter reports what the workload asked CUDA to do, never what the silicon did.
The one exception is the elapsed-time family derived from CUDA event timing, which is real on-device time but
exists only for workloads that call it themselves — a bonus signal, never a dependency.
