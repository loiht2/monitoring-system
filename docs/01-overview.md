# Overview

## What this is

A GPU observability stack for Kubernetes. It exports GPU metrics to Prometheus and presents them in Grafana,
and it is built to answer one question that a standard GPU monitoring setup cannot:

> **Which pod is using the GPU, how hard, and what is it actually doing?**

On a cluster where GPUs are shared — HAMi fractional slicing, Dynamic Resource Allocation, or MIG — the usual
device-level metrics report the whole card. A GPU at 90% utilization tells you nothing about which of the four
pods on it is responsible, or whether the fourth is holding a slice it never uses.

## What it is made of

Three exporters run as DaemonSets on every GPU node. A fourth source is read where it already exists.

| Source | Gives you |
|---|---|
| **DCGM** | Hardware truth: SM activity and occupancy, tensor and floating-point pipe activity, memory bandwidth, framebuffer, power, temperature, clocks, throttle reasons |
| **NVML** | Per-pod GPU utilization and per-pod GPU memory — the only per-process hardware numbers available |
| **eBPF CUDA tracing** | Per-pod CUDA behaviour: kernel launch rate and latency, allocation and transfer volume, synchronization waits, CUDA errors, HAMi throttling and out-of-memory events |
| **HAMi vGPUmonitor** | What HAMi itself believes and enforces: each container's memory quota and what it counts against it |

Each answers a different question, and each is blind to the others' domain. DCGM knows what the silicon did but
not who did it. eBPF knows exactly which pod made every CUDA call but nothing about the hardware. NVML is the
only one that sees both at once, which is why per-pod hardware attribution works at all.

## What you can ask it

| Question | How it is answered |
|---|---|
| Which pod is consuming GPU 0? | Per-pod SM utilization from NVML |
| Is this pod actually training, or stalled? | Kernel launch rate from eBPF |
| Is this pod using tensor cores, or leaving them idle? | Tensor pipe activity from DCGM |
| Is this GPU memory-bound or compute-bound? | DRAM activity against SM activity, both from DCGM |
| Is anyone holding a GPU without using it? | Entitlement present, no live GPU process |
| Why did this GPU slow down? | Throttle reasons from DCGM, throttle delay from eBPF |
| Is HAMi enforcing the limit it thinks it is? | HAMi's own accounting against the driver's |

## What it cannot tell you

Stated plainly, because no configuration changes it:

- **Occupancy and pipe activity cannot be attributed to a pod on a shared GPU.** Hardware performance counters
  are sampled per device, not per process. If two pods share a card, "tensor cores were 60% active" is a
  property of the card, not of either pod. The exception is exclusive assignment — a whole GPU, or a MIG
  instance, held by one pod — where the attribution is exact.
- **Per-pod GPU utilization is unavailable under MIG.** The driver does not sample it for MIG devices. Per-pod
  *memory* still works, and MIG's exclusive assignment covers the rest.
- **eBPF sees requests, not execution.** It observes the CUDA call the workload made; it cannot report how the
  hardware served it.
- **Some metrics need specific hardware.** NVLink throughput needs active NVLink links; certain cache and
  interconnect metrics need Grace-coupled or Hopper-class systems. Where the hardware cannot supply a metric,
  it is **not reported at all** rather than reported as zero — a zero would be indistinguishable from a real
  measurement.

Full list in [05 — Limitations](05-limitations.md).

## Next

- [02 — Metrics](02-metrics.md) — every metric, with its meaning
- [03 — Deployment](03-deployment.md) — how to install it
- [04 — Querying](04-querying.md) — how to answer the questions above
