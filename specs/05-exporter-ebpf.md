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


---

## Validation result (gpu-burn)

**Working.** Per-pod CUDA tracing is live: kernel-launch rate resolves per pod
(`gpu-burn-a` 6.47/s, `gpu-burn-b` 6.35/s) on one shared card. No `gpu_cuda_*` or `gpu_hami_*` name survives
anywhere, so the rename is complete cluster-wide.

### The label names are not `namespace` and `pod`

The agent emits **`k8s_namespace_name`** and **`k8s_pod_name`**. Querying `sum by (namespace, pod)` does not
fail — it returns a plausible non-zero number attributed to `pod=ebpf-gpu-exporter-…`, because those labels
come from the *scrape target* rather than the traced workload. Measured: 12.9 launches/s credited to the agent
pod instead of split across the two workloads that caused them.

That is worse than an empty result. Any per-pod eBPF query must use the `k8s_*` names.

### 7 of 20 families appeared, and gpu-burn is why

| Present | Absent under this workload |
|---|---|
| kernel launch calls / duration / grid / block / shared memory, memory copies, memset | device+stream+event sync, event elapsed, graph launch, allocations, frees, peer copies, both `ebpf_hami_*` |

gpu-burn allocates once and then loops kernels, so sync, event, graph and peer-copy probes legitimately never
fire. **This workload does not validate 13 of the 20 families.** A framework workload (PyTorch) exercises
allocation, free and stream-sync paths continuously and is what the remaining families need.

### HAMi throttling: instrumented, but nothing to report

`gpu-burn-a` carries `LIBVGPU_LIMITER` and `GPU_CORE_UTILIZATION_POLICY`, so HAMi's interception library *is*
injected — yet `ebpf_hami_compute_throttle_duration_seconds` never appears. This is the second independent
signal that HAMi is not enforcing its `cores` grant here; the first was per-pod SM utilization sitting near
50/50 against a 3:1 grant ([04 § 5](04-exporter-nvml.md)). Two unrelated measurements agreeing is the reason
to believe it.

### Cardinality against A-5

| | Series |
|---|---|
| `ebpf_*` | 168 |
| `nvml_*` + `DCGM_FI_*` + `gpu_alloc_*` | 97 |

**1.7x, not the assumed order of magnitude** — with two GPU pods. eBPF series scale with instrumented pods
while the others scale with devices, so the ratio grows with tenancy and this number must be re-measured at
realistic pod counts before sizing Prometheus. Prometheus RSS at this point: 227 MiB, well inside its 2Gi
limit.


### Real training workload (resnet50 + shufflenet_v2, HAMi co-scheduled)

Re-run against the DL benchmark harness rather than gpu-burn, because gpu-burn exercises only a narrow slice
of the CUDA API.

| | gpu-burn | + real training |
|---|---|---|
| Families with data | 7 of 20 | **8 of 20** |
| Gained | | `ebpf_cuda_stream_sync_duration_seconds` |

Per-pod attribution held on the training pods (977k and 1.16M kernel launches over the run).

**The allocation and free families stayed absent, and that is expected rather than broken.** PyTorch uses a
caching allocator: it takes a small number of large `cudaMalloc` calls during warm-up and then reuses that
arena for the rest of training, so steady-state has almost nothing for those probes to see. Catching them
needs a workload that allocates continuously, or a measurement taken across process start.

Still unobserved after both workloads: device and event sync, event elapsed, graph launch, peer copies, CUDA
errors, and both `ebpf_hami_*` families. The HAMi families remaining empty under a `force` throttle policy is
the third independent signal that HAMi is not enforcing its grant here.
