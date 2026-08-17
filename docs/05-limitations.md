# Limitations

Properties of the hardware and the measurement approach, not defects. No configuration changes any of them.

---

## Attribution

| Metric class | Attributable to a pod? |
|---|---|
| Per-pod GPU utilization and memory (`nvml_process_*`) | **Yes**, directly |
| CUDA behaviour (`ebpf_*`) | **Yes**, natively |
| HAMi accounting (`hami_*`) | **Yes**, natively |
| Framebuffer, device utilization, power, temperature, clocks | **Only to whoever holds the GPU** — the join tells you who was allocated the card, not who caused the reading |
| SM occupancy, tensor and pipe activity, DRAM activity | **No** on a shared GPU |
| Throttle reasons, temperature, power | **No, and it would be misleading to try** — these are properties of the device |

**Why occupancy and pipe activity cannot be split between co-tenants:** GPU hardware performance counters are
sampled per device, not per process. When two pods share a card, "tensor cores were 60% active" is a fact about
the card. There is no mechanism in the driver or in DCGM to divide it.

The exception is **exclusive assignment**. A whole GPU or a MIG instance held by a single pod makes every one of
its metrics that pod's, exactly. This is the one respect in which MIG improves observability.

## MIG

| | Whole GPU | MIG instance |
|---|---|---|
| `nvml_gpu_utilization_ratio` | Available | **Unavailable** — use `DCGM_FI_PROF_GR_ENGINE_ACTIVE` |
| `nvml_process_sm_utilization_ratio` | Available | **Unavailable** — the driver does not sample it for MIG devices |
| `nvml_process_gpu_memory_bytes` | Available | Available |
| Hardware metrics | Per device | Per instance, and exactly attributable |

Per-pod utilization under MIG comes from the instance's hardware metrics, not from process sampling.

## What eBPF cannot see

The eBPF exporter attaches to the CUDA driver library and observes calls. It reports **what the workload asked
for**, never what the hardware did:

- No SM utilization, no occupancy, no memory bandwidth, no power.
- A kernel launch is asynchronous, so launch duration measures submission, not execution.
- The single exception is `ebpf_cuda_event_elapsed_seconds`, which is real on-device time — but it exists only
  for workloads that instrument themselves with CUDA events, so it cannot be relied on.

Some metric families are also absent simply because the workload never called that function. An absent family
is not evidence of a broken exporter.

## Hardware requirements

Some metrics need hardware the fleet may not have. Where a GPU cannot supply a metric it is **absent, not
zero** — a zero would be indistinguishable from a real measurement and would corrupt every average and alert
computed over it.

| Not available on | What is missing |
|---|---|
| Pre-Volta | All profiling metrics — occupancy, pipe activity, DRAM activity |
| Pre-Turing | INT8 matrix pipe activity |
| Pre-Ampere | FP64 matrix cycle counter |
| Pre-Hopper | FP64 tensor pipe activity |
| GPUs without active NVLink | NVLink throughput. Note this needs *active links*, not merely NVLink-capable silicon — an unpopulated bridge reports nothing |
| Non-Grace systems | Chip-to-chip bandwidth and host-memory cache rates |

Two metrics in the source catalog — L2 cache hit and miss rates over the chip-to-chip link — have **no
corresponding field in DCGM on any hardware**. They are not deliverable by configuration anywhere.

### How you find out, without guessing

You do not have to consult the table above to know what your GPU supports. The system publishes
`gpu_metric_supported{gpu_uuid, GPU_I_ID, metric, source}`:

| Value | Meaning |
|---|---|
| `1` | This entity produces this metric |
| `0` | This entity **cannot** — hardware or driver does not implement it |
| *absent* | Unknown. Never guessed |

The UI reads this directly: a panel whose metrics are all unsupported says **"Not supported on this GPU"**,
and a panel that plots four pipes where one is unsupported names the missing one in its legend rather than
quietly drawing three lines. A blank panel therefore means "nothing happened", not "your card can't do this" —
those are different answers and the system distinguishes them.

### "Not supported" describes the counter, not the silicon

Measured on an A30: `DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE` reports unsupported, yet the card demonstrably
executes FP64 tensor work — a `cublasDgemm` runs at roughly twice the vector-FP64 rate and drives the
aggregate tensor-pipe metric to near 1.0. DCGM simply has no working per-pipe counter for it on that part.

So a `0` verdict means *this metric cannot be measured here*, not *this hardware cannot do this*. Read the
aggregate alongside the per-pipe breakdown before concluding a pipe is idle.

### Measured on the validation hardware (A30)

Eight metrics report unsupported on this fleet, and that is a **pass**, not a fault — the system knowing what
it cannot measure is the feature:

| Metric | Why |
|---|---|
| `PIPE_INT_ACTIVE` | No such counter on the A30 |
| `PIPE_TENSOR_DFMA_ACTIVE` | No working per-pipe counter (see above) |
| `NVLINK_TX/RX_BYTES` | Device-scope only; reports `0` at MIG-instance scope, and these cards are not bridged |
| `C2C_TX/RX_ALL_BYTES` | Chip-to-chip is Grace-Hopper; an A30 has no such link |
| `HOSTMEM_CACHE_HIT/MISS`, `PEERMEM_CACHE_HIT/MISS` | Not implemented on this part |

## Scope

The system delivers metrics into Prometheus and dashboards in Grafana. It does not include:

- **Alerting.** No Alertmanager, no alert rules. Routing and alert policy are a separate concern.
- **Cost or energy accounting.**
- **Host-level metrics** — CPU, memory, disk, network. That is node-exporter's job.
- **Log collection.**
- **Any modification of workload scheduling, quota enforcement or GPU allocation.** This system observes; it
  does not act.
