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
| **HAMi monitor** | HAMi's own accounting — entitlement per card under DRA, or the quota it enforces per container under the classic device-plugin |

Each is blind to the others' domain. DCGM knows what the silicon did but not who did it; eBPF knows exactly
which pod made every call but nothing about the hardware. NVML is the only source that sees both at once, which
is what makes per-pod hardware attribution possible.

## Repository layout

Organised by **role in the pipeline** — metrics are produced, stored, presented, and verified — rather than
by language or by frontend/backend. There is no single "backend": the exporters are node daemons, Prometheus
is upstream software, and presentation has two surfaces.

| Directory | What lives here | You touch it when |
|---|---|---|
| `exporters/` | The metric producers. `nvml/` is a Go DaemonSet built here; `ebpf/` is a submodule pointing at the eBPF CUDA-tracing agent | Changing what is measured, or how a metric is named |
| `dashboards/` | The three Grafana dashboards, as JSON. **The source of truth for panels** — the UI's spec is generated from these, never written twice | Adding or editing a panel |
| `services/` | The advanced monitoring UI and the API it proxies through. One deployable pair | Changing how metrics are presented in the native UI |
| `deploy/` | Numbered Kubernetes manifests, applied in lexical order. Installs the stack and nothing else | Changing how the system is installed |
| `scripts/` | Tooling: the dashboard contract checker, the panel-spec generator, PromQL helpers | Changing the build or validation tooling |
| `test/` | Everything that verifies. Unit tests, `loadgen/` fixtures, and `evaluation/` — the harness that proves each metric actually responds on real hardware | Adding a check |
| `docs/` | How to use the system | The interface changes |
| `specs/` | What the system must do, and why | A requirement or decision changes |

**Start here:** [`docs/01-overview.md`](docs/01-overview.md) to understand what it does,
[`docs/07-installation.md`](docs/07-installation.md) to install it on a new cluster, then
[`docs/08-usage.md`](docs/08-usage.md) to operate it. To change it, read
[`specs/00-decisions.md`](specs/00-decisions.md) first — it is the contract the rest is written against.

Two directories are deliberately **not** committed: `snapshots/` (pre-replacement configuration captured for
[risk R-5](specs/09-risks-and-open-questions.md)) and `NOTE-*.md` (site-specific cluster addresses and device
UUIDs). The specification proper is written to be hardware- and site-agnostic.

## Documentation

**[docs/](docs/)** — how to use the system:

| | |
|---|---|
| [Overview](docs/01-overview.md) | What it is, what you can ask it, what it cannot tell you |
| [Metrics](docs/02-metrics.md) | Every metric, with what the number means |
| [Deployment](docs/03-deployment.md) | What each manifest contains, storage, sizing |
| [Querying](docs/04-querying.md) | Worked queries for the questions above |
| [Limitations](docs/05-limitations.md) | What is not obtainable, and why |
| [Troubleshooting](docs/06-troubleshooting.md) | Failures that look healthy |
| [Installation](docs/07-installation.md) | **Start-to-finish install on a new cluster**, with a check after every step |
| [Usage](docs/08-usage.md) | Day-to-day operation: the surfaces, the controls, reading an empty panel |

**[specs/](specs/)** — the normative specification. What the system must do and why it was built this way:
the source-authority contract, architecture, metric catalogue, per-exporter detail, the dashboard and UI
specs, validation, and the risk register. Where a spec and the code disagree, that is a bug in one of them.

The split is by *what the document is for*, not by audience seniority:

| | Answers | Changes when |
|---|---|---|
| `docs/` | "How do I use this?" | The interface changes |
| `specs/` | "What must this do, and why?" | A requirement or decision changes |

## Status

**All four sources deployed and validated on an A30 node.** DCGM, NVML and eBPF run as DaemonSets; HAMi's
monitor is consumed where it exists. MIG entitlement (`mig_uuid`) is implemented and exercised against a
mixed `2g.12gb` + 2 × `1g.6gb` layout, where per-instance isolation was measured directly: loading one
instance leaves its siblings reading exactly zero.

The advanced monitoring UI is deployed alongside Grafana and reads the same Prometheus.

**Metric coverage, measured rather than asserted.** The dashboards plot **54** metric families. Eight report
unsupported at device scope and seventeen at MIG-instance scope — a pass, not a fault, and the reason
`gpu_metric_supported` exists. The counts move with the hardware, so read them live rather than trusting a
number in a README:

```bash
promq 'count by (metric) (gpu_metric_supported{GPU_I_ID=""} == 0)'
```

The NVML exporter's suite runs against fakes, so it needs no GPU or cluster.
