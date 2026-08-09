# 01 — Architecture

## 1. Component topology

Every component is node-local and scrape-based. Nothing pushes; nothing aggregates across nodes except
Prometheus.

```
┌──────────────────────────── GPU node ─────────────────────────────┐
│  dcgm-exporter        nvml-exporter         ebpf-gpu-exporter      │
│  (NVIDIA image,       (ours, Go)            (ours, Go)             │
│   config only)                                                     │
│      │                  │        │                │                │
│  hardware            NVML     K8s API      uprobes on              │
│  counters            per-proc  (alloc)     libcuda / libvgpu       │
│      │                  │        │                │                │
│  DCGM_FI_*          nvml_*   gpu_alloc_*   ebpf_cuda_*             │
│                                            ebpf_hami_*             │
│                                                                    │
│  [HAMi device-plugin pod] ── vgpu-monitor sidecar ── hami_*        │
└────────────────────────────────────────────────────────────────────┘
                          │  ServiceMonitor (15s)
                          ▼
                   Prometheus ──► Grafana
```

| Component | Deliverable | Privileges | Namespace |
|---|---|---|---|
| `dcgm-exporter` | **Configuration only.** Never redeployed or forked — a second instance emits duplicate series for every name, violating the hard invariant | unchanged | `DCGM_FI_*` |
| `nvml-exporter` | New DaemonSet, Go | `hostPID: true`, read-only K8s API | `nvml_*`, `gpu_alloc_*` |
| `ebpf-gpu-exporter` | New DaemonSet, Go | privileged, `hostPID`, `hostNetwork` | `ebpf_cuda_*`, `ebpf_hami_*` |
| `vgpu-monitor` | **Not deployed by us.** Scraped where present | n/a | `hami_*` |

`gpu_alloc_*` lives **inside** the NVML exporter: it is node-local, needs the same pod cache the PID resolver
maintains, and shares its lifecycle. It stays a separate collector module with its own metric family, so it is
independently testable and can be extracted later without changing a metric name.

---

## 2. Attribution

Pod identity reaches two kinds of metric by two non-interchangeable mechanisms.

### 2.1 Per-process metrics — resolved inside the exporter

NVML keys per-process counters by **host PID**. A host PID must never become a label: PIDs churn without bound
and are recycled, producing both unbounded series growth and silent aliasing between an old and a new process.

```
nvmlDeviceGetProcessUtilization → host PID
  → /proc/<pid>/cgroup          → pod UID
  → node-scoped pod informer    → namespace, pod, container
  → summed per pod; PID discarded before exposition
```

Rules that must survive implementation:

- **Sum per pod**, so a multi-process pod contributes one series.
- **Garbage-collect each scrape**; exited processes leave no stale series.
- **`hostPID: true` is mandatory** — without it the exporter sees a private PID namespace and every lookup
  fails silently.
- The cgroup parser tolerates both cgroup versions and both common runtime naming schemes, and degrades to an
  unattributed series rather than raising.

### 2.2 Device-level metrics — joined on device UUID

A GPU UUID is stable and low-cardinality, so attribution is a Prometheus join rather than an exporter lookup.

```
gpu_alloc_device_pod_info{gpu_uuid, mig_uuid, namespace, pod, container, alloc_source} 1
```

```promql
DCGM_FI_PROF_SM_ACTIVE * on(gpu_uuid) group_left(pod, namespace) gpu_alloc_device_pod_info
```

Where several pods share a device, the join returns one row per co-tenant against the same device value. That
is the correct answer — an exporter-side approach would pick one pod and hide the co-tenancy the system exists
to expose.

### 2.3 Allocation comes from the Kubernetes API

Three mechanisms, all readable through the ordinary API (D-10):

| Mechanism | Where device identity lives |
|---|---|
| HAMi classic device-plugin | Pod annotation whose key **ends with** `vgpu-devices-allocated`; first field of the value is the device UUID |
| DRA | `ResourceClaim.status.allocation.devices.results[].device` → resolved to a UUID via the matching `ResourceSlice` device attributes |
| MIG | The allocated device resolves to a MIG instance UUID, matching DCGM's `GPU_I` entity |

This avoids a privileged kubelet-socket mount, uses one code path for all three, and removes any dependency on
whether a vendor exporter supports DRA-based pod mapping. Parsers are inherited; see
[04 § 1.2](04-exporter-nvml.md).

### 2.4 Entitlement is not occupancy

| | Meaning | Source |
|---|---|---|
| **Entitlement** | The pod has been *granted* the device | `gpu_alloc_device_pod_info` |
| **Occupancy** | The pod has a *live CUDA context* on it | `nvml_process_*` |

The gap is the signal: entitlement without occupancy is a GPU held and unused — what idle-GPU reclamation
exists to find, and what nothing else in the system can express.

---

## 3. Label contract

### 3.1 Join keys

| Key | Joins | Scope |
|---|---|---|
| `gpu_uuid` | DCGM ↔ NVML ↔ `gpu_alloc` ↔ `hami_*` | Physical device |
| `mig_uuid` | DCGM `GPU_I` ↔ `gpu_alloc` | MIG instances |

The `gpu` label is the board index and is **not** unique: a MIG instance carries its parent board's index. Aggregate on `gpu_uuid`, never on `gpu`.
| `namespace`, `pod` | NVML ↔ eBPF ↔ `hami_*` ↔ pod-metadata metrics | Workload |

### 3.2 Normalization — add, never rename

Relabeling **copies** each source's native identifier into `gpu_uuid` and **retains the original**:

| Source | Native label | Action |
|---|---|---|
| DCGM | `UUID` | copy → `gpu_uuid`, keep `UUID` |
| vGPUmonitor | `device_uuid` | copy → `gpu_uuid`, keep `device_uuid` |
| NVML / `gpu_alloc` | `gpu_uuid` | native |

**This is the canonical statement of the rule.** Dropping an original label breaks any query, dashboard or
alert referencing it — including rules that divide one metric by another without an explicit `on()` clause,
which match on the full label set and degrade to an empty vector rather than to an error
([09 — R-1](09-risks-and-open-questions.md)).

### 3.3 Ownership

```
DCGM_FI_*                  dcgm-exporter
nvml_*  gpu_alloc_*        nvml-exporter
ebpf_cuda_*  ebpf_hami_*   ebpf-gpu-exporter
hami_*                     HAMi vgpu-monitor (not ours)
```

The eBPF agent also emits its upstream framework's HTTP/RPC/DB/DNS metrics under their own names; those are
outside this contract and collide with nothing.

---

## 4. Worked queries

**Per-pod GPU busy, whole device** — NVML is authoritative:

```promql
sum by (namespace, pod, gpu_uuid) (nvml_process_sm_utilization_ratio)
```

**Per-pod GPU busy, MIG** — per-process sampling is unavailable, but a MIG instance is exclusively assigned,
so entitlement *is* attribution and the result is exact:

```promql
DCGM_FI_PROF_SM_ACTIVE
  * on(mig_uuid) group_left(namespace, pod) gpu_alloc_device_pod_info{mig_uuid!=""}
```

> **Not yet available.** Nothing populates `mig_uuid` today: entitlement is read from HAMi
> annotations and DRA `ResourceSlice` attributes, both of which carry the *physical* GPU UUID.
> Resolving a MIG instance UUID from those objects is unimplemented, so this query returns an
> empty vector. Per-pod memory on MIG still works through `nvml_process_gpu_memory_bytes`,
> which is read from the instance handle.

Because the authoritative source differs by device mode, a dashboard panel expresses this as a fallback chain,
not one expression.

**Entitled but idle** — the reclamation signal:

```promql
gpu_alloc_device_pod_info
  unless on(gpu_uuid, namespace, pod) (
    sum by (gpu_uuid, namespace, pod) (nvml_process_gpu_memory_bytes) > 0
  )
```

**`gpu_uuid` must be in the match, not just `namespace` and `pod`.** Matching on the pod alone collapses its
GPUs together, so a pod holding two cards and using one suppresses *both* entitlement rows and the idle card
becomes invisible — the exact case this query exists to catch. Both sides carry `gpu_uuid` per device, so the
three-label match is what makes partially-idle multi-GPU pods visible.

**Co-tenancy:**

```promql
count by (gpu_uuid) (gpu_alloc_device_pod_info) > 1
```

**Accounting divergence** — memory the card holds that HAMi is not counting. Non-zero is an enforcement
defect, which is why this overlap is kept ([06 § 4](06-hami-vgpumonitor.md)):

```promql
nvml_gpu_memory_used_bytes - on(gpu_uuid) sum by (gpu_uuid) (hami_vgpu_memory_used_bytes)
```

---

## 5. Attribution limits

| Metric class | Attributable to a pod? |
|---|---|
| Per-process SM utilization and GPU memory | **Yes**, directly — NVML returns the host PID |
| CUDA API behaviour | **Yes**, natively |
| HAMi enforcement view | **Yes**, natively |
| Framebuffer, device utilization, power, thermals, clocks | **Only via entitlement** — the join says who *holds* the card, not who caused the reading |
| Occupancy, pipe activity, DRAM activity | **No** — hardware counters are sampled per device, never per context |
| ECC, row remap, XID, throttle reasons | **No**, and it would be wrong to try — device health, not workload properties |

Under MIG, exclusive assignment makes every metric on an instance attributable to exactly one pod. It is the
one case where MIG improves attribution, and the reason MIG support earns its cost.
