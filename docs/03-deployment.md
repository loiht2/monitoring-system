# Deployment

## Prerequisites

| Requirement | Why |
|---|---|
| Kubernetes with GPU nodes, and a working NVIDIA driver | Everything here reads the driver |
| **Prometheus Operator, with its controller actually running** | Scrape configuration is `ServiceMonitor` objects. CRDs alone are not enough — see the check below |
| A container runtime using standard pod cgroup paths | The NVML exporter resolves processes to pods through `/proc` |
| Kernel with BTF and uprobe support | Required by the eBPF exporter only |

> **Verify the operator, do not assume it.** Prometheus Operator CRDs are often installed without the
> controller that reconciles them. In that state a `ServiceMonitor` applies successfully and is scraped by
> nothing. Confirm a controller pod is running before treating any scrape configuration as effective.

## Install

Manifests are plain YAML, numbered in dependency order, one directory per environment:

```bash
kubectl apply -f deploy/<environment>/
```

| Range | Contents |
|---|---|
| `00-` | Namespace |
| `10-` | RBAC |
| `20-` | Prometheus Operator, Prometheus, Grafana, storage |
| `30-` | DCGM configuration |
| `40-` | NVML and eBPF exporters |
| `50-` | ServiceMonitors |
| `60-` | Dashboards |

Applying the directory in lexical order produces a working stack from an empty namespace.

## What gets deployed, and what does not

**The DCGM exporter is not deployed by this system.** If one is already running, its field list is extended
through configuration — a counters ConfigMap, referenced from the GPU Operator's `ClusterPolicy` or mounted
directly by a standalone deployment. Never run a second DCGM exporter: two of them emit two series for every
metric name, and consumers that read "the first result" or sum across results will silently get wrong answers.

**HAMi's vGPUmonitor is not deployed by this system either.** Where HAMi's classic device-plugin runs, its
monitor sidecar is already there and cannot be turned off. We add a `ServiceMonitor` that scrapes it and drops
its two device-level metrics, which duplicate `nvml_*` exactly.

## Storage

Prometheus's local storage relies on memory-mapped files and POSIX locking.

> **Do not place the time-series database on a network filesystem**, even if it is the cluster default
> StorageClass. The failure mode is silent data corruption after a restart, not a clean error.

Use a local volume. Before committing to a size, check `allowVolumeExpansion` on the StorageClass — where it is
`false`, the size cannot be changed later. An `emptyDir` is acceptable while bringing the system up, since the
metrics are stateless and only history is lost on a restart.

## Sizing

The eBPF exporter produces roughly an order of magnitude more time series than every other source combined —
it emits histograms keyed by pod and CUDA function. Two consequences:

- Sizing done before the eBPF exporter is running is meaningless.
- Bring it up **last**, and measure Prometheus's actual memory use with the other exporters running first.

Set Prometheus's memory **request** to what you expect it to use, not the minimum that will schedule. On a node
whose scheduler accounting sits below its real usage, an under-requested Prometheus is admitted and then
competes for memory that was never free.

## Verify

Deployment succeeding is not evidence of collection. Check in this order:

```promql
# 1. Hardware metrics arriving
DCGM_FI_PROF_SM_ACTIVE

# 2. Per-pod attribution working — needs a running GPU workload
nvml_process_sm_utilization_ratio

# 3. Allocation visible
gpu_alloc_device_pod_info

# 4. CUDA tracing attached — needs a running GPU workload
rate(ebpf_cuda_kernel_launch_calls_total[1m])
```

If (2) is empty while a GPU workload is running, the NVML exporter is almost certainly missing `hostPID: true`.
That is the single most common misconfiguration; the exporter starts normally and silently produces no per-pod
metrics.

If (4) is empty while a GPU workload is running, the eBPF agent has attached no probes. It reports healthy and
serves an endpoint in this state — see [06 — Troubleshooting](06-troubleshooting.md).

## Ports

All three exporters must listen on distinct host ports. The DCGM exporter and the eBPF agent conventionally
use the same port number, and the eBPF agent runs with host networking, so its container port *is* a host
port. Assign it explicitly rather than relying on the default.
