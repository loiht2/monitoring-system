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

## Scope

The system delivers metrics into Prometheus and dashboards in Grafana. It does not include:

- **Alerting.** No Alertmanager, no alert rules. Routing and alert policy are a separate concern.
- **Cost or energy accounting.**
- **Host-level metrics** — CPU, memory, disk, network. That is node-exporter's job.
- **Log collection.**
- **Any modification of workload scheduling, quota enforcement or GPU allocation.** This system observes; it
  does not act.
