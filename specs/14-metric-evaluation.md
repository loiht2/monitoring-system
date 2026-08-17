# 14 — Metric evaluation and coverage

The dashboards plot **53 distinct metrics**. Prometheus has never seen **18** of them. This document
specifies how to find out, for every one, whether the metric works, is genuinely unavailable on this
hardware, or is silently broken — and the workloads needed to force that answer.

It also fixes three defects found by reading the deployed UI, all of which share one root cause.

---

## 1. The three outcomes

Every (metric, entity) pair resolves to exactly one of these. The middle one is a **pass**, and treating it
as a failure is the mistake this document exists to prevent.

| Outcome | Definition | Verdict |
|---|---|---|
| **Observed** | The metric produced a sample during a window in which a workload deliberately exercised it | Pass |
| **Unsupported** | No sample, **and** `gpu_metric_supported` says `0` for that entity | Pass — the system correctly knows it cannot |
| **Unverified** | No sample, **and no support verdict either** | **Defect** |

Unverified is the dangerous class: the panel is blank, nothing explains why, and no one can tell a hardware
limit from a broken exporter. All three defects in §2 are Unverified metrics.

An entity is `(gpu_uuid, GPU_I_ID)`, per [10 §2](10-metric-support-signal.md) — a whole card and a MIG
instance are different things to ask about.

---

## 2. What "unsupported" means

A `0` verdict is a statement about **the counter, not the silicon**. The two are routinely confused, and the
confusion produces wrong conclusions in both directions.

The sharp case: a card can report a tensor pipe unsupported while demonstrably executing work on it. A
double-precision GEMM may run at roughly twice the vector-FP64 rate — unambiguous tensor-core execution —
and drive the aggregate tensor-pipe metric near 1.0, while the per-pipe counter for that specific pipe is
simply not implemented on the part.

So:

- **`0` means "this metric cannot be measured here"**, never "this hardware cannot do this".
- A panel reading "not supported on this GPU" is accurate about the metric. A reader must not infer the pipe
  is idle or absent.
- This is why the aggregate series is kept on the panel alongside the per-pipe breakdown: the aggregate is
  the evidence the work happened.

The support signal itself — how a verdict is produced and what `1`, `0` and *absent* mean — is specified in
[10](10-metric-support-signal.md).

---

## 3. What the UI must show

### 3.1 Per-series support

A panel renders normally when *any* of its metrics is supported, and additionally names the ones that are
not. The natural place is the legend, which already exists and already carries series identity:

```
● <node> gpu0 · FP64   ● <node> gpu0 · FP32   ● <node> gpu0 · FP16
○ integer — not supported on this GPU
```

The unsupported entry is muted, carries no series colour (there is no series), and states the reason. It is
a legend row rather than a footnote because that is where a reader looks to ask "where is the fourth line?".

Only `gpu_metric_supported == 0` produces this row. An absent verdict must **not** — that is Unverified, and
claiming "not supported" without evidence is the fabrication [10 §1](10-metric-support-signal.md) forbids.

### 3.2 A partitioned card is a distinct state

Add a sixth panel state, `partitioned`:

> **Partitioned into MIG instances** — this reading is per instance. See the MIG tab.

It applies when a device-scope panel returns nothing **and** every selected GPU is MIG-partitioned. The UI
learns which cards are partitioned from one page-level query — the same evidence DCGM itself provides:

```promql
count by (gpu_uuid) (DCGM_FI_DEV_FB_USED{GPU_I_ID!=""})
```

Any `gpu_uuid` in that result is partitioned. No new exporter, no new metric.

Resolution order for an empty panel, most specific first: `rejected` → `partitioned` → `unsupported` →
`nodata`. Partitioned outranks unsupported because it is the more precise statement, and because the
support rule can legitimately report `0` for a device-scope field on a partitioned card.

### 3.3 The panel states

Specified in [13 § 6](13-ui-visual-design.md). Not restated here: two copies of a state table drift, and
this one already had.

---

## 4. The evaluation suite

### 4.1 Why the existing workloads are not enough

Only 8 of the 20 eBPF families have ever produced data, despite real DL training runs. The reason is
specific and instructive: **PyTorch's caching allocator stops calling `cudaMalloc` after warm-up**, so
allocation and free families never fire no matter how long training runs. General-purpose workloads cannot
cover an API surface; they exercise whatever they happen to use.

The evaluation therefore uses **small, single-purpose programs that call the API in question directly**,
not larger workloads that might incidentally do so.

`/home/ubuntu/loiht2/test/deep-learning-workloads` is a separate HAMi fairness harness with its own
experiment provenance. **It is not modified.** The evaluation lives in `test/evaluation/` in this repository,
next to the dashboards it validates.

### 4.2 The 18 unseen metrics, and what drives each

| Metric | Driver | Expected |
|---|---|---|
| `PIPE_TENSOR_DFMA_ACTIVE` | cuBLAS FP64 tensor GEMM | **Unsupported — already measured, §2.2.** The workload still runs, to confirm the verdict holds under load rather than only at idle |
| `PIPE_INT_ACTIVE` | Integer-heavy kernel | Unsupported — confirms §2.1 |
| `NVLINK_TX/RX_BYTES` | Peer-to-peer copy GPU0↔GPU1 | Unsupported — `nvidia-smi nvlink -s` reports all links inactive; these A30s are not bridged |
| `C2C_TX/RX_ALL_BYTES` | none | Unsupported — chip-to-chip is Grace-Hopper; an A30 has no C2C link |
| `HOSTMEM_CACHE_HIT/MISS` | Mapped host memory access via `cudaHostAlloc` | Either; the run decides |
| `PEERMEM_CACHE_HIT/MISS` | Peer memory access with `cudaDeviceEnablePeerAccess` | Either; the run decides |
| `ebpf_cuda_memory_allocations_bytes/calls_total` | Raw `cudaMalloc`/`cudaFree` loop, **no framework allocator** | Observed |
| `ebpf_cuda_errors_total` | Deliberate invalid launch and oversized allocation | Observed |
| `ebpf_cuda_graph_launch_calls_total` | `cudaGraphLaunch` of a captured graph | Observed |
| `ebpf_cuda_event_elapsed_seconds_bucket` | `cudaEventElapsedTime` around a kernel | Observed |
| `ebpf_cuda_memory_peer_copies_bytes_total_sum` | `cudaMemcpyPeer` GPU0→GPU1 | Observed |
| `ebpf_hami_oom_events_total` | Pod with a small `nvidia.com/gpumem`, allocating past it | Observed |
| `ebpf_hami_compute_throttle_duration_seconds_bucket` | Pod with low `nvidia.com/gpucores` under saturating load | Observed |

Four entries are predicted Unsupported. **The prediction is not the result** — each still runs, because the
purpose is to convert Unverified into a recorded verdict, and a metric that unexpectedly *does* produce
data is itself a finding.

### 4.3 The workloads

Two container images, each a small CUDA program with a `--mode` switch. Two rather than fifteen because
they share a build and a base, and the mode is one function call.

**`pipe-exerciser`** — one compute pipe at a time, long enough to be sampled at 15s scrape interval:
`fp64`, `fp32`, `fp16`, `tensor-hmma`, `tensor-imma`, `tensor-dfma`, `int`, `dram-bandwidth`,
`pcie-h2d`, `pcie-d2h`, `peer-copy`, `hostmem`, `peermem`, `sustained` (power/thermal/clock ramp).

**`api-exerciser`** — one CUDA API family at a time, for the eBPF dashboard:
`malloc-free`, `memcpy-h2d`, `memcpy-d2h`, `memcpy-d2d`, `memcpy-peer`, `memset-sync`, `memset-async`,
`stream-sync`, `device-sync`, `event-sync`, `event-elapsed`, `graph-launch`, `kernel-dims`, `errors`.

Both accept `--duration` and `--device`, and both must run **unmodified** on a whole card and on a MIG
instance — that is what makes MIG coverage a scheduling question rather than a second implementation.

### 4.4 Scheduling matrix

| Target | How |
|---|---|
| GPU 0 (whole card) | DRA `ResourceClaim`, `deviceClassName: gpu.nvidia.com`, pinned to the UUID by a CEL selector |
| Each MIG instance on GPU 1 | Same, selecting the instance |
| HAMi-limited | As above plus a `capacity.requests` block constraining memory and cores |

**`nvidia.com/gpu: 1` does not work on this node and must not be used.** The node advertises
`nvidia.com/gpu: 0`: the mixed layout — GPU 0 whole, GPU 1 partitioned — makes the device plugin's `single`
MIG strategy report `NVIDIA-A30-MIG-INVALID`. GPUs are scheduled through **DRA** here, the same way
`test/loadgen/gpu-burn.yaml` does it.

Job templates set `imagePullPolicy: Always`. With `IfNotPresent`, a cached tag silently re-runs the previous
build — indistinguishable from a workload that ran and a metric that did not move.

**GPU 1 currently exposes exactly one instance (`1g.6gb`), so "all MIG instances" means one today.** An A30
supports `1g.6gb`×4, `2g.12gb`×2, `4g.24gb`×1, and mixed layouts. Broader MIG coverage requires
**re-partitioning, which destroys the current instance and changes cluster state** — so it is an explicit
opt-in phase (`--repartition`), never a side effect of running the suite, and the suite reports coverage
against the instances that actually exist.

### 4.5 One instance is not enough to test the MIG dashboard

With a single instance, every per-instance query returns the same one row, so a whole class of defect is
invisible: an expression that silently aggregates across instances, a picker that cannot narrow to one, a
panel that plots the parent card while claiming to plot an instance. None of these can be seen until at
least two instances exist and disagree.

**The suite therefore partitions GPU 1 into a mixed layout — `2g.12gb` + 2 × `1g.6gb` — and runs against
every instance.** Mixed rather than uniform on purpose: instances of different sizes make a
normalisation bug obvious, because [02 A-8](02-metric-catalog.md) says utilisation is normalised *to the
instance*, so the same workload must read differently on a `2g.12gb` than on a `1g.6gb`. Four identical
`1g.6gb` slices would hide that.

This is the one destructive step in the suite. It requires `--repartition`, it prompts, and it is never
reached from `--all`.

### 4.6 eBPF is attributed per instance through the workload, not the metric

The eBPF exporter emits **no `GPU_I_ID` and no `mig_uuid`**, and labels only 3 of 43 pods with a `gpu_uuid`.
Taken alone, that would make per-instance eBPF coverage impossible.

It is not taken alone. `gpu_alloc_device_pod_info` maps each workload pod to the device it was granted and
**does** carry `mig_uuid` — populated for all 27 MIG-scheduled phases in the last run. Joining on the pod
resolves **43 of 43**, 17 of them to a MIG instance.

So the report attributes an eBPF phase to the entity its pod was allocated, and per-instance eBPF coverage
is real. What remains an exporter gap is only that eBPF's *own* labels cannot do it — recorded in
[09](09-risks-and-open-questions.md) so that a future exporter fix removes a join rather than surprising
someone.

**The join is the report's, not the dashboard's.** Panel expressions stay as extracted; the correlation
happens where the phase window is already known, which is also where a mis-join would be caught by the
phase's own pod name.

---

## 5. The harness

```
test/evaluation/
  run.sh                 phase driver: apply Job → wait → record [t0,t1] → delete
  report.py              classify every (metric, entity) over each window
  workloads/
    pipe-exerciser/      Dockerfile + main.cu
    api-exerciser/       Dockerfile + main.cu
  manifests/             Job templates, one per target class
```

**A phase is a workload plus a time window.** `run.sh` records `t0` before the Job starts and `t1` after it
finishes, then `report.py` asks Prometheus, per metric and per entity, whether a sample exists inside that
window. Windows are recorded rather than assumed, because a Job that fails to schedule must not be reported
as a metric that failed to appear.

Classification is exactly §1, and the report states its own limits:

```
DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE
  GPU-26e02… (device)          OBSERVED    peak 0.42   phase: tensor-dfma
  GPU-a4d27… GPU_I_ID=3        OBSERVED    peak 0.38   phase: tensor-dfma-mig
DCGM_FI_PROF_PIPE_INT_ACTIVE
  GPU-26e02… (device)          UNSUPPORTED gpu_metric_supported=0
DCGM_FI_PROF_NVLINK_TX_BYTES
  GPU-26e02… (device)          UNVERIFIED  no sample, no support verdict   ← defect
```

Output is Markdown for reading and JSON for diffing between runs. A run that leaves any metric UNVERIFIED
**fails**, because that is precisely the state §2 showed can hide for months.

### 5.1 What the harness must not do

- **Not assert an expected value.** Utilisation depends on the machine; the claim is that a metric
  *responds* to a workload built to drive it, not that it reaches a number.
- **Not fabricate a window.** If a Job never became `Running`, the phase is `ERROR`, not a metric verdict.
- **Not treat Unsupported as failure.** §1.
- **Not silently skip a MIG instance.** An instance that exists and was not exercised is reported as a
  coverage gap.

---

## 6. Verification

| Claim | Check |
|---|---|
| DFMA is a real field | Present in `dcgm_fields.h` as 1015 — recorded in §2.2 |
| Adding DFMA did not break DCGM | After rollout, the exporter still serves **every** previously-served field. One unknown field zeroes all of them, so this is checked explicitly, not assumed |
| Per-series support renders | With GPU 0 selected, FP & Integer names `integer` as unsupported and still plots the other three |
| Partitioned state renders | With GPU 1 selected on the Device tab, profiling panels read "Partitioned into MIG instances" |
| The suite is honest | Run it with the eBPF agent stopped: eBPF metrics must come back UNVERIFIED, not OBSERVED |
| Coverage improved | Re-run §4.2's gap query; the 18 shrink, and every remaining one carries a verdict |

The gap query, which is the top-level measure:

```bash
# metrics referenced by a panel that Prometheus has never seen
curl -s .../api/label/__name__/values          # compared against panels.json
```

---

## 7. Outcomes

The suite's output is a per-run report, regenerated by `report.py` and not committed — a measurement is
evidence, not a requirement, and pinning one run's numbers into a specification guarantees they go stale.
What follows is what the runs established and what must remain true.

**Every metric the dashboards plot carries a verdict.** No metric may sit in UNVERIFIED with no explanation;
that state is a defect in the system or in the harness, and a run that ends with one fails.

**Unsupported is the expected outcome for a substantial minority.** Several DCGM fields are requested
precisely so their absence produces evidence rather than silence ([10 § 3.2](10-metric-support-signal.md)).
A field that reports unsupported on the fleet is working as designed.

**Per-instance isolation holds.** Loading one MIG instance leaves its siblings reading zero for the same
metric. Nothing aggregates across instances and nothing leaks from the parent card.

**Utilisation is normalised to the instance, not the card.** A slice that is a quarter of a card reads near
1.0 when saturated, not 0.25. A mixed-profile layout is required to demonstrate this: uniform slices produce
identical readings consistent with either interpretation and prove nothing.

**Two eBPF metrics remain unverifiable**, both exporter-side and both recorded as risks rather than hidden
here: the copy-volume probe that does not fire ([09 — R-7](09-risks-and-open-questions.md)), and peer-copy
volume, which has no reachable driver where peer access is unavailable.

### 7.1 What the exercisers must not be trusted to prove

The exercisers use fixed dimensions and do not scale their parallelism to instance size. A larger instance
may therefore read as partially occupied under a workload that saturates a smaller one — a property of the
test, not of the metric. **A saturation test that does not saturate is worth fixing before it is trusted**,
and comparisons of utilisation *between* instance sizes are not valid until it is.
