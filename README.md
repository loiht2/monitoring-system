# GPU Monitoring System

GPU observability for Kubernetes: Prometheus exporters and Grafana dashboards built to answer one question a
standard GPU monitoring setup cannot —

> **Which pod is using the GPU, how hard, and what is it actually doing?**

Where GPUs are shared — HAMi fractional slicing, Dynamic Resource Allocation, or MIG — device-level metrics
report the whole card. A GPU at 90% utilization says nothing about which of the pods on it is responsible, or
whether one is holding a slice it never uses.

## How it works

Three exporters run as DaemonSets on every GPU node; a fourth source is read where it already exists.

| Source | Gives you |
|---|---|
| **DCGM** | Hardware truth — SM activity and occupancy, tensor and floating-point pipe activity, memory bandwidth, framebuffer, power, thermals, clocks, throttle reasons |
| **NVML** | Per-pod GPU utilization and memory — the only per-process hardware numbers that exist |
| **eBPF CUDA tracing** | Per-pod CUDA behaviour — launch rate and latency, allocation and transfer volume, sync waits, errors, HAMi throttling and OOM |
| **HAMi vGPUmonitor** | HAMi's own accounting — the quota it enforces and what it counts against it |

Each is blind to the others' domain. DCGM knows what the silicon did but not who did it; eBPF knows exactly
which pod made every call but nothing about the hardware. NVML is the only source that sees both at once, which
is what makes per-pod hardware attribution possible.

## Documentation

**[docs/](docs/)** — how to use the system:

| | |
|---|---|
| [Overview](docs/01-overview.md) | What it is, what you can ask it, what it cannot tell you |
| [Metrics](docs/02-metrics.md) | Every metric, with what the number means |
| [Deployment](docs/03-deployment.md) | Prerequisites, install, storage, sizing, verification |
| [Querying](docs/04-querying.md) | Worked queries for the questions above |
| [Limitations](docs/05-limitations.md) | What is not obtainable, and why |
| [Troubleshooting](docs/06-troubleshooting.md) | Failures that look healthy |

**[docs-internal/](docs-internal/)** — the design specification: architecture, decisions, per-exporter
implementation detail, validation plan and risk register. Read it to change the system; read `docs/` to use it.

## Status

**NVML exporter built; not yet deployed.** The Go exporter (`exporters/nvml/`) is complete
and unit-tested against fakes — no GPU or cluster needed to run its suite. It has not yet run on real
hardware. MIG entitlement (`mig_uuid`) is not implemented. The DCGM and eBPF exporters are still design only.
