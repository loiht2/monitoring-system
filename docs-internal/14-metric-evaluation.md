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

## 2. Three defects, one root cause

### 2.1 The integer pipe is missing from FP & Integer Utilization

`DCGM_FI_PROF_PIPE_INT_ACTIVE` **is** requested in `30-dcgm-counters.yaml`, deliberately, as evidence.
DCGM logs `metric not enabled` and skips it, because the A30 has no such counter. The support rule works —
measured on the live cluster, both entities report:

```
gpu_metric_supported{metric="DCGM_FI_PROF_PIPE_INT_ACTIVE", gpu_uuid="GPU-26e02…"}      0
gpu_metric_supported{metric="DCGM_FI_PROF_PIPE_INT_ACTIVE", gpu_uuid="GPU-a4d27…", GPU_I_ID="3"} 0
```

**The signal exists and the UI ignores it.** Support is evaluated per *panel*: a panel is `unsupported` only
when *every* metric it plots is unsupported. FP64, FP32 and FP16 are supported, so the panel renders three
lines and the integer series vanishes with no explanation. Same for Tensor Core Utilization.

**This is correct data rendered as a lie by omission.** A reader sees three pipes and concludes the fourth
was idle.

### 2.2 The DFMA tensor pipe is never collected

`DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE` is plotted by two dashboards and requested by nothing. It is absent
from the counters ConfigMap, so there is no data **and** no support verdict — Unverified.

It was confused with `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL`, which was correctly excluded for being an
unknown field (an unknown field is fatal — the exporter then serves *nothing*). They are not the same
identifier. Checked against the DCGM 4.5.0 source at `dcgmlib/dcgm_fields.h`:

```
#define DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE 1015     ← real field, safe to request
DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL                 ← no match anywhere in the header
```

So DFMA is safe to add.

**Measured after adding it: the A30 does not implement this pipe.** DCGM logs the same non-fatal skip it
logs for `PIPE_INT_ACTIVE`, and the support rule now records `0` on both entities:

```
level=WARN msg="Skipping line 28 ('DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE'): metric not enabled"
level=WARN msg="Skipping line 32 ('DCGM_FI_PROF_PIPE_INT_ACTIVE'): metric not enabled"
→ Registry built successfully        (all 31 other DCGM fields still served)
gpu_metric_supported{metric="DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE"}  0   (device, and GPU_I_ID=3)
```

An earlier draft of this section predicted DFMA *would* produce data, reasoning from the A30 having FP64
tensor cores. That prediction was wrong, and the measurement replaces it. The point of adding the field was
never to make a line appear — it was to move the metric out of Unverified, and a recorded `0` on both
entities does that.

The log is also the structural proof that 1015 is a **known** field the hardware merely lacks: it took the
per-line `WARN`-and-skip path, not the fatal unknown-field path that empties the whole registry. That is the
categorical difference from `DMMA_CYCLES_ACTIVE_TOTAL`.

### 2.2.1 "Unsupported metric" does not mean "the hardware cannot do it"

Building the exercisers turned up the sharper version of this. A `cublasDgemm` on the A30 runs at
**10.2 TFLOP/s — twice the card's 5.2 TFLOP/s vector FP64 rate** — and drives `PIPE_TENSOR_ACTIVE` to 0.99
while `PIPE_FP64_ACTIVE` stays at 0.00025. That is DMMA: **the A30 is demonstrably executing FP64 tensor
work.**

DCGM simply has no working per-pipe counter for it on this part. The work is real and visible in the
aggregate `PIPE_TENSOR_ACTIVE`; only the DFMA-specific breakdown is missing.

So `gpu_metric_supported = 0` is a statement about **the counter**, not about the silicon. The panel's
"not supported on this GPU" wording is accurate for what it describes — the metric — and a reader must not
infer that the pipe is idle or absent. This distinction is why the aggregate tensor series is kept on the
panel alongside the per-pipe breakdown.

**Consequence for the exercisers.** `cublasDgemm` with `CUBLAS_PEDANTIC_MATH` does *not* stay off the tensor
cores, so it cannot be used to drive `PIPE_FP64_ACTIVE`. The `fp64` mode uses a dependent double-precision
`fma` chain, which has no tensor-core form: FP64 then reads 0.946 with tensor at 0.015. The `tensor-dfma`
mode keeps the `cublasDgemm` path, since that is exactly the DMMA behaviour above.

### 2.3 A MIG-partitioned card looks broken on the Device tab

GPU 1 (`GPU-a4d27439…`) has `mig.mode.current = Enabled` with one `1g.6gb` instance. Select it on the
Device tab and the profiling panels are blank, because once MIG is on, DCGM reports instance entities and
stops reporting device-scope profiling fields ([02 §4](02-metric-catalog.md)).

That is expected and already documented for the support matrix ([10 §4.1](10-metric-support-signal.md)),
but the UI says nothing. The card is not broken and the metric is not unsupported — the reading simply
lives at a different scope.

### 2.4 The common root

All three are the same shape: **the UI's support model is per-panel and binary, while the truth is
per-series and has more than two values.** §3 fixes the model; §4 and §5 supply the evidence.

---

## 3. What the UI must show

### 3.1 Per-series support

A panel renders normally when *any* of its metrics is supported, and additionally names the ones that are
not. The natural place is the legend, which already exists and already carries series identity:

```
● a30-node gpu0 · FP64   ● a30-node gpu0 · FP32   ● a30-node gpu0 · FP16
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

### 3.3 The panel states, complete

| State | Meaning |
|---|---|
| `nodata` | Query succeeded, empty, metric is supported — nothing was running |
| `unsupported` | `gpu_metric_supported` is `0` for every metric on the panel |
| `partitioned` | Device-scope panel, every selected card is MIG-partitioned |
| `rejected` | Prometheus returned 4xx — the query is malformed |
| `down` | Prometheus unreachable |

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
experiment provenance. **It is not modified.** The evaluation lives in `evaluation/` in this repository,
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
`deploy/a30-node/90-loadgen-gpu-burn.yaml` does it.

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
evaluation/
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

## 7. Results

Measured on the live cluster. 53 metrics classified over **69 phase windows**; 0 phases failed to run.
Full output: `evaluation/report.md` (Markdown) and `evaluation/report.json`.

| Verdict | Count |
|---|---|
| OBSERVED | 43 |
| UNSUPPORTED | 8 |
| UNVERIFIED | 2 |

The 18 metrics Prometheus had never seen are down to **2**, and both carry a stated reason below.

### 7.1 The eight newly-requested DCGM fields

Adding them raised the actively-scraped DCGM metric-name count 31 → 33 with no exporter outage; every skipped
field took the non-fatal per-line `WARN` path ([10 § 3.2](10-metric-support-signal.md)).

| Field | Device (GPU 0) | MIG instance (GPU 1, `GPU_I_ID=3`) |
|---|---|---|
| `NVLINK_TX_BYTES` | **OBSERVED**, peak `0` | UNSUPPORTED |
| `NVLINK_RX_BYTES` | **OBSERVED**, peak `0` | UNSUPPORTED |
| `C2C_TX_ALL_BYTES` / `C2C_RX_ALL_BYTES` | UNSUPPORTED | UNSUPPORTED |
| `HOSTMEM_CACHE_HIT` / `HOSTMEM_CACHE_MISS` | UNSUPPORTED | UNSUPPORTED |
| `PEERMEM_CACHE_HIT` / `PEERMEM_CACHE_MISS` | UNSUPPORTED | UNSUPPORTED |

**NVLink is asymmetric across scope.** The counter is supported and emits a series on the whole card, reading
`0` bytes because these A30s are not bridged — a metric reporting zero traffic is working. On the MIG instance
the support rule records `0`: NVLink is a device-scope counter and is not reported per instance. §4.2 predicted
NVLink would be Unsupported; the measurement replaces the prediction, and the distinction matters — an operator
reading `0` on the card is reading a real "no NVLink traffic", not a blank panel.

The other six are UNSUPPORTED on both entities, which is a **pass**: the hardware lacks the counter and the
system now records that fact instead of leaving a silent blank.

Because all 59 earlier phase windows predate these fields being collected, a top-up phase set (`pcie-h2d`,
`dram-bandwidth`, `hostmem`, `sustained` on gpu0, ~90s each) was run with the fields live rather than
special-casing the classifier. All four COMPLETE, exit 0.

### 7.2 The two remaining UNVERIFIED

Both are eBPF, and neither is fixable by running more workloads.

| Metric | Why it stayed UNVERIFIED |
|---|---|
| `ebpf_cuda_memory_peer_copies_bytes_total_sum` | Its only driver is `cudaMemcpyPeer`, and `cudaDeviceCanAccessPeer(0,1)` is **false** on this host. The `peer-copy` / `peermem` / `memcpy-peer` phases exit non-zero by design and are recorded as such. Not reachable on this hardware; the metric has no support verdict because eBPF exports no `gpu_metric_supported` signal |
| `ebpf_cuda_memory_copies_bytes_total_sum` | **A genuine defect.** 21142 successful `cudaMemcpy` calls, exit 0, and no sample. Other eBPF families from the same pod and window appeared, so the agent was attached. See [09 — R-7](09-risks-and-open-questions.md) |

Per §5, a run leaving any metric UNVERIFIED fails, and `report.py` exits non-zero. That is the correct outcome
here: one is an unreachable code path on this host and one is an open agent defect, and neither should be
papered over by relaxing the classifier.

### 7.3 MIG coverage caveat

GPU 1 exposes exactly **one** MIG instance (`1g.6gb`, `GPU_I_ID=3`), so "all MIG instances" means one instance
today; 28 phases ran against it. `run.sh --repartition` was **deliberately not run** — it destroys the existing
instance and changes cluster state (§4.4). Coverage is reported against the instances that actually exist, so
no instance is silently skipped.

---

## 8. Per-instance isolation and normalisation, measured

The check that a single MIG instance could never support. GPU 1 carries `2g.12gb` (id 1, 28 of the card's
56 SMs) and two `1g.6gb` (ids 5 and 6, 14 SMs each). The same `pipe-exerciser --mode fp32` ran on one
instance at a time for 120s.

| Loaded | id 1 (`2g.12gb`) | id 5 (`1g.6gb`) | id 6 (`1g.6gb`) |
|---|---|---|---|
| **id 1 only** — `SM_ACTIVE` | **0.4994** | 0.0000 | 0.0000 |
| **id 1 only** — `GR_ENGINE_ACTIVE` | **0.4999** | 0.0000 | 0.0000 |
| **id 5 only** — `SM_ACTIVE` | 0.0000 | **0.9990** | 0.0000 |
| **id 5 only** — `GR_ENGINE_ACTIVE` | 0.0000 | **0.9997** | 0.0000 |

**Isolation holds, in both directions.** An idle instance reads exactly `0.0000` while a sibling is
saturated. Nothing aggregates across instances, and nothing leaks from the parent card.

**Normalisation is per instance, and the mixed layout is what proves it.** A `1g.6gb` is a quarter of the
card; card-normalised it could never exceed 0.25, yet it reads 0.999. That single number rules out
card-normalisation — and it is only available because the layout is mixed. Four identical slices would have
produced four identical readings consistent with either interpretation.

### 8.1 An open question about the 2g.12gb reading

The `2g.12gb` peaks at 0.4994 — almost exactly half — which is *also* what card-normalisation would produce
for a 28/56-SM instance. The `1g.6gb` result rules that reading out, since both profiles are measured the
same way, so the honest interpretation is that **the workload occupies half of the larger instance**: the
exerciser uses fixed dimensions and does not scale its parallelism to instance size, so it saturates 14 SMs
and half-fills 28.

That is a property of the exerciser, not of the metric. It is recorded rather than resolved because
distinguishing the two conclusively needs a workload that provably saturates a `2g.12gb`, and **a
"saturation" test that does not saturate is worth fixing before it is trusted** — a future reader comparing
instance sizes would otherwise draw the wrong conclusion from the 0.5.
