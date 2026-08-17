# 02 — Metric catalog

Every metric the dashboards present, in the order they present it. **Grouping and field selection come from**
`metrics/hw-metrics/[our]gpu-metrics-general.csv` and `[our]gpu-metrics-mig-slice.csv`, which are the source of
truth for what is collected and how it is organised.

Panel names follow those CSVs except for five, listed in § 0.2, where a name was kept deliberately.

| Scope | Dashboard | Applies to |
|---|---|---|
| [Device](#1-device-level) | GPU Hardware — Device | A whole physical card |
| [MIG](#2-mig-level) | GPU Hardware — MIG | One GPU instance on a partitioned card |
| [Software](#3-software-ebpf) | GPU Software — eBPF | One pod's CUDA API behaviour |

## 0. Sourcing rules

**DCGM is the source for device readings.** NVML remains the source for exactly three things, because DCGM
cannot supply them:

| Kept on NVML | Why |
|---|---|
| GPU Utilization per Pod | DCGM has no per-process field |
| Memory Held by Each Pod | DCGM has no per-process field |
| Clocks Throttle Reasons | DCGM exposes a single **bitmask**; NVML gives one 0/1 series per reason, which is what a state timeline needs |

**The NVML exporter keeps emitting its device metrics even though no panel plots them.** They are the
independent cross-check that caught HAMi over-reserving memory by 5.7 GB, and the NVML probe is what makes
`gpu_metric_supported` a measurement rather than an inference ([10 § 3.1](10-metric-support-signal.md)).
Retiring them from the dashboards is a presentation decision, not a collection one.

### 0.1 Field names are dcgm-exporter's, not the C API's

`dcgm_fields.h` names these fields `DCGM_FI_PROF_SM_UTIL_RATIO`, `…_DRAM_UTIL_RATIO` and so on.
**dcgm-exporter's own CSV uses the older `_ACTIVE` spellings for the same field IDs**, and that CSV is what we
edit, so the `_ACTIVE` names are what this catalog records.

**An unknown name is fatal**: the exporter then serves nothing at all, losing every field that worked
([09 — R-DCGM-FIELDS](09-risks-and-open-questions.md)). Nine names below are catalogued but deliberately
**not** in this cluster's ConfigMap, because they have never been proven to load here and cannot produce data
on an A30 anyway: the four cache fields, both C2C fields, both NVLink fields, and DFMA. Adding one on a fleet
that needs it means diffing the served `# HELP` count before and after.

### 0.2 Five panel names deliberately diverge from the CSVs

| CSV name | Panel name here | Why |
|---|---|---|
| GPU Utilization per process | **GPU Utilization per Pod** | Values are summed per pod and the host PID never becomes a label ([01 § 2.1](01-architecture.md)), so "per process" would describe something the dashboard does not show |
| GPU Memory Utilization | **Memory Used vs Total**, **Memory Used Over Time** | One CSV row backs two panels: a current comparison against installed memory, and a trend. Splitting them was confirmed as the wanted shape |
| GPU Memory per process | **Memory Held by Each Pod** | Same per-pod reasoning as above |
| *(MIG)* Memory Utilization | **Memory Used vs Total**, **Memory Used Over Time** | Kept identical to the device dashboard so the two read consistently |
| *(MIG)* Memory per process | **Memory Held by Each Pod** | As above |

Everything else uses the CSV name verbatim. A future CSV edit that renames a panel should be taken as
authoritative unless it collides with one of these five.

### 0.3 Units that bite

`DCGM_FI_DEV_FB_USED` and `FB_FREE` are **MiB**, not bytes. Any panel or comparison against a byte-valued
metric must multiply by 1048576.

---

## 1. Device level

### 1.1 Performance

| Panel | Definition | Field | ID | Source |
|---|---|---|---|---|
| GPU Utilization | Percent of time the GPU was actively processing. | `DCGM_FI_DEV_GPU_UTIL` | 203 | DCGM |
| GPU Utilization per Pod | GPU utilization per process, summed per pod. | `nvmlDeviceGetProcessUtilization` | — | NVML |
| SM Activity | Percent of cycles where an SM had at least one warp resident. | `DCGM_FI_PROF_SM_ACTIVE` | 1002 | DCGM |
| SM Occupancy | Percent of number of warps resident on an SM. | `DCGM_FI_PROF_SM_OCCUPANCY` | 1003 | DCGM |
| Tensor Core Utilization | Percent of cycles when any tensor pipe was active, and per pipe: HMMA, IMMA, DFMA. | `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`, `…_HMMA_ACTIVE`, `…_IMMA_ACTIVE`, `…_DFMA_ACTIVE` | 1004, 1014, 1013, 1015 | DCGM |
| FP & Integer Utilization | Percent of cycles when the FP64, FP32, FP16 and integer pipes were active. | `DCGM_FI_PROF_PIPE_FP64_ACTIVE`, `…_FP32_ACTIVE`, `…_FP16_ACTIVE`, `…_INT_ACTIVE` | 1006, 1007, 1008, 1016 | DCGM |
| Cache Hit Rates | Percent of requests to host memory and to peer memory that were cache hits. | `DCGM_FI_PROF_HOSTMEM_CACHE_HIT`, `…_PEERMEM_CACHE_HIT` | 1080, 1082 | DCGM |
| Cache Miss Rates | Percent of requests to host memory and to peer memory that were cache misses. | `DCGM_FI_PROF_HOSTMEM_CACHE_MISS`, `…_PEERMEM_CACHE_MISS` | 1081, 1083 | DCGM |

**HMMA is 1014 and IMMA is 1013.** They are easy to transpose, and an earlier revision of this catalog had
them the wrong way round.

### 1.2 Memory

| Panel | Definition | Field | ID | Source |
|---|---|---|---|---|
| Memory Used vs Total | Memory in use, against the memory installed on the card. | `DCGM_FI_DEV_FB_USED`, `DCGM_FI_DEV_FB_FREE` | 252, 251 | DCGM |
| Memory Used Over Time | Memory in use. | `DCGM_FI_DEV_FB_USED` | 252 | DCGM |
| Memory Held by Each Pod | Memory in use per process, summed per pod. | `nvmlDeviceGetComputeRunningProcesses_v3` | — | NVML |
| Memory Bandwidth Utilization | Percent of cycles the device memory interface is active. | `DCGM_FI_PROF_DRAM_ACTIVE` | 1005 | DCGM |

The first three keep the shape they already had; bandwidth is added as a fourth panel rather than replacing
them.

### 1.3 Interconnect

| Panel | Definition | Field | ID | Source |
|---|---|---|---|---|
| PCIe Transmission Throughput | Rate of data received by, and transmitted from, the GPU over PCIe. | `DCGM_FI_PROF_PCIE_RX_BYTES`, `…_TX_BYTES` | 1010, 1009 | DCGM |
| NVLink Transmission Throughput | Rate of data received by, and transmitted from, the GPU over NVLink. | `DCGM_FI_PROF_NVLINK_RX_BYTES`, `…_TX_BYTES` | 1012, 1011 | DCGM |
| Chip to Chip Bandwidth | Total bytes received over, and transmitted over, the chip-to-chip link. | `DCGM_FI_PROF_C2C_RX_ALL_BYTES`, `…_TX_ALL_BYTES` | 1078, 1076 | DCGM |

### 1.4 Power & Thermals

| Panel | Definition | Field | ID | Source |
|---|---|---|---|---|
| GPU Power Usage | Power usage of the device in watts. | `DCGM_FI_DEV_POWER_USAGE` | 155 | DCGM |
| GPU Temperature | Current GPU device temperature in Celsius. | `DCGM_FI_DEV_GPU_TEMP` | 150 | DCGM |

### 1.5 Clocks

| Panel | Definition | Field | ID | Source |
|---|---|---|---|---|
| Clock Frequencies | Current SM and memory clock frequency in MHz. | `DCGM_FI_DEV_SM_CLOCK`, `DCGM_FI_DEV_MEM_CLOCK` | 100, 101 | DCGM |
| Clocks Throttle Reasons | Fraction of the interval each throttle reason was active. | `nvmlDeviceGetCurrentClocksEventReasons` | — | **NVML** |

### 1.6 Allocation and support

| Panel | Definition | Metric |
|---|---|---|
| Entitlement | The pod granted this device. Constant 1; the identity is in the labels. | `gpu_alloc_device_pod_info` |
| Metric Support Matrix | Whether an entity can produce a metric: 1 supported, 0 not supported, absent when unknown. | `gpu_metric_supported` |

---

## 2. MIG level

The same fields scoped to one GPU instance, read from the `GPU_I` entity. Definitions match the device level
wherever the field is the same; only the scope differs.

A MIG series carries `gpu_uuid` for the **parent card**, `mig_uuid` for the instance, and `GPU_I_ID`, the only
identifier DCGM publishes for an instance ([01 § 3.1](01-architecture.md)). `gpu_metric_supported` is keyed
the same way, and a partitioned card is skipped by the device matrix
([10 § 4.1](10-metric-support-signal.md)).

### 2.1 Performance

| Panel | Definition | Field | ID |
|---|---|---|---|
| GPU Utilization | Percent of time the MIG instance was actively processing. | `DCGM_FI_PROF_GR_ENGINE_ACTIVE` | 1001 |
| SM Efficiency | Percent of cycles where an SM had at least one warp resident. | `DCGM_FI_PROF_SM_ACTIVE` | 1002 |
| SM Occupancy | Percent of number of warps resident on an SM. | `DCGM_FI_PROF_SM_OCCUPANCY` | 1003 |
| Tensor Core Utilization | Percent of cycles when any tensor pipe was active, and per pipe: HMMA, IMMA, DFMA. | `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`, `…_HMMA_ACTIVE`, `…_IMMA_ACTIVE`, `…_DFMA_ACTIVE` | 1004, 1014, 1013, 1015 |
| FP & Integer Utilization | Percent of cycles when the FP64, FP32, FP16 and integer pipes were active. | `DCGM_FI_PROF_PIPE_FP64_ACTIVE`, `…_FP32_ACTIVE`, `…_FP16_ACTIVE`, `…_INT_ACTIVE` | 1006, 1007, 1008, 1016 |

### 2.2 Memory

| Panel | Definition | Field | ID | Source |
|---|---|---|---|---|
| Memory Used vs Total | Memory in use inside the instance, against the memory assigned to it. | `DCGM_FI_DEV_FB_USED`, `DCGM_FI_DEV_FB_FREE` | 252, 251 | DCGM |
| Memory Used Over Time | Memory in use inside the instance. | `DCGM_FI_DEV_FB_USED` | 252 | DCGM |
| Memory Held by Each Pod | Memory in use per process inside the instance, summed per pod. | `nvmlDeviceGetComputeRunningProcesses_v3` | — | NVML |
| Memory Bandwidth Utilization | Percent of cycles the device memory interface is active. | `DCGM_FI_PROF_DRAM_ACTIVE` | 1005 | DCGM |

Per-process memory is the only per-process metric that survives MIG; per-process utilization is unavailable on
any MIG handle.

### 2.3 Support

The metric support matrix, filtered to instances.

---

## 3. Software (eBPF)

Per-pod CUDA API behaviour traced by uprobes on the CUDA driver library. Aggregated by
**`k8s_namespace_name`** and **`k8s_pod_name`**; the series also carry `gpu_uuid`.

| Group | Metrics |
|---|---|
| Compute activity | `ebpf_cuda_kernel_launch_calls_total`, `…_kernel_launch_duration_seconds`, `…_graph_launch_calls_total` |
| Kernel dimensions | `ebpf_cuda_kernel_grid_size_total`, `…_kernel_block_size_total`, `…_kernel_shared_memory_bytes` |
| Memory activity | `ebpf_cuda_memory_allocations_bytes_total`, `…_allocations_calls_total`, `…_frees_bytes_total`, `…_frees_calls_total`, `…_memory_copies_bytes_total`, `…_memory_memset_bytes_total`, `…_memory_peer_copies_bytes_total` |
| Synchronization | `ebpf_cuda_stream_sync_duration_seconds`, `…_device_sync_duration_seconds`, `…_event_sync_duration_seconds`, `…_event_elapsed_seconds` |
| Errors | `ebpf_cuda_errors_total` |
| HAMi enforcement | `ebpf_hami_compute_throttle_duration_seconds`, `ebpf_hami_oom_events_total` |

Each group above is one row on the dashboard, in this order: Compute activity, Memory activity, Errors, HAMi enforcement, Synchronization, Kernel dimensions. **HAMi enforcement is its own row, not part of Errors**: a throttle is the quota working as configured, an OOM is a workload exceeding it, and neither is a CUDA error. Filing them together invites reading enforcement as malfunction.

Eight of the twenty have produced data here. The rest are not broken: PyTorch's caching allocator stops
calling `cudaMalloc` after warm-up, no workload uses CUDA Graphs, device barriers or event timing, and the
HAMi families need enforcement that is not happening ([05](05-exporter-ebpf.md)).

---

## 4. MIG utilization is instance-normalized

Measured on a partitioned A30, one `1g.6gb` instance holding **14 of the card's 56 SMs**, saturated:

| | Reading |
|---|---|
| `DCGM_FI_PROF_GR_ENGINE_ACTIVE{GPU_I_ID!=""}` | **0.999962** |
| `DCGM_FI_PROF_SM_ACTIVE{GPU_I_ID!=""}` | **0.998474** |
| device-normalized would have read | ~0.25 |

An instance at 100% does not mean the card is busy, and instance utilizations must never be summed into a
device figure. There is also **no device-level profiling series on a partitioned card**: only instance
entities are reported.

---

## 5. Absent, never zero

A reading the hardware cannot supply is **omitted**, never emitted as `0`. A zero is indistinguishable from a
real measurement and corrupts every average, rate and alert over the series. `gpu_metric_supported` is the one
deliberate exception, because there `0` is itself the fact ([10 § 1.1](10-metric-support-signal.md)).
