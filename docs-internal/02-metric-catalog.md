# 02 — Metric catalog

Every metric the system collects, in the order the dashboards present it. Definitions are NVIDIA's own
wording from the DCGM and NVML references; they are definitions, not guidance.

Three scopes, one per dashboard:

| Scope | Dashboard | Applies to |
|---|---|---|
| [Device](#1-device-level) | GPU Hardware — Device | A whole physical card |
| [MIG](#2-mig-level) | GPU Hardware — MIG | One GPU instance on a partitioned card |
| [Software](#3-software-ebpf) | GPU Software — eBPF | One pod's CUDA API behaviour |

**Availability** records the hardware a field needs. A field the fleet cannot produce is still catalogued and
still gets a panel, so the dashboard stays portable across fleets; `gpu_metric_supported` is what tells a
reader whether a blank panel is unsupported or merely idle ([10](10-metric-support-signal.md)).

---

## 1. Device level

### 1.1 Performance

| Panel | Definition | Metric | Source | Availability |
|---|---|---|---|---|
| GPU Utilization | Percent of time over the past sample period during which one or more kernels was executing on the GPU. | `nvml_gpu_utilization_ratio` | NVML `nvmlDeviceGetUtilizationRates` | All GPUs, Kepler+ |
| GPU Utilization per Pod | GPU utilization attributed to the processes of one pod. | `nvml_process_sm_utilization_ratio` | NVML `nvmlDeviceGetProcessUtilization` | All GPUs, Kepler+. Unavailable on a MIG parent |
| SM Activity | The fraction of time at least one warp was active on a multiprocessor, averaged over all multiprocessors. | `DCGM_FI_PROF_SM_ACTIVE` | DCGM 1002 | Volta+ |
| SM Occupancy | The fraction of resident warps on a multiprocessor, relative to the maximum number of concurrent warps supported on a multiprocessor. | `DCGM_FI_PROF_SM_OCCUPANCY` | DCGM 1003 | Volta+ |
| Tensor Core Utilization | The fraction of cycles the tensor (HMMA / IMMA) pipe was active. | `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`, `…_HMMA_ACTIVE`, `…_IMMA_ACTIVE` | DCGM 1004 / 1013 / 1014 | Tensor: Volta+. HMMA: Volta+. IMMA: Turing+ |
| FP & Integer Utilization | The fraction of cycles the FP64, FP32 (FMA) and FP16 pipes were active. | `DCGM_FI_PROF_PIPE_FP64_ACTIVE`, `…_FP32_ACTIVE`, `…_FP16_ACTIVE`, `…_PIPE_INT_ACTIVE` | DCGM 1006 / 1007 / 1008 / 1016 | Volta+. Integer reports `metric not enabled` on A30 |
| DRAM Activity | The fraction of cycles where data was sent to or received from device memory. | `DCGM_FI_PROF_DRAM_ACTIVE` | DCGM 1005 | Volta+ |
| L2 Cache Hit Rates | L2 hit rate for accesses to host memory and to peer GPU memory. | `DCGM_FI_PROF_HOSTMEM_CACHE_HIT`, `…_PEERMEM_CACHE_HIT` | DCGM 1080 / 1082 | Host: Grace-coupled (GH200/GB200). Peer: NVLink Hopper+ |
| L2 Cache Miss Rates | L2 miss rate for accesses to host memory and to peer GPU memory. | `DCGM_FI_PROF_HOSTMEM_CACHE_MISS`, `…_PEERMEM_CACHE_MISS` | DCGM 1081 / 1083 | As above |

`DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE` (Hopper+) and `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` (Ampere+, raw
cycles with no ratio field) are catalogued but not collected. DMMA is **not a known field** in the DCGM build
shipped here, and an unknown field is fatal to the whole exporter
([09 — R-DCGM-FIELDS](09-risks-and-open-questions.md)).

### 1.2 Memory

| Panel | Definition | Metric | Source | Availability |
|---|---|---|---|---|
| Memory Used vs Total | Device memory in use, against the memory installed on the card. | `nvml_gpu_memory_used_bytes`, `nvml_gpu_memory_total_bytes` | NVML `nvmlDeviceGetMemoryInfo` | All GPUs, Kepler+ |
| Memory Used Over Time | Device memory in use. | `nvml_gpu_memory_used_bytes` | NVML `nvmlDeviceGetMemoryInfo` | All GPUs, Kepler+ |
| Memory Held by Each Pod | Device memory held by the processes of one pod. | `nvml_process_gpu_memory_bytes` | NVML `nvmlDeviceGetComputeRunningProcesses` | All GPUs, Kepler+ |

### 1.3 Data Transfer

| Panel | Definition | Metric | Source | Availability |
|---|---|---|---|---|
| PCIe Throughput | The rate of data transmitted and received over the PCIe bus, including both protocol headers and data payloads, in bytes per second. | `DCGM_FI_PROF_PCIE_TX_BYTES`, `…_RX_BYTES` | DCGM 1009 / 1010 | Maxwell+ |
| NVLink Throughput | The rate of data transmitted and received over NVLink, not including protocol headers, in bytes per second. | `DCGM_FI_PROF_NVLINK_TX_BYTES`, `…_RX_BYTES` | DCGM 1011 / 1012 | NVLink-equipped only. **Both A30s report all links inactive** |
| Chip-to-Chip Bandwidth | Chip-to-chip bandwidth transmitted to and received from the CPU. | `DCGM_FI_PROF_C2C_TX_ALL_BYTES`, `…_C2C_RX_ALL_BYTES` | DCGM 1076 / 1078 | Grace-coupled (GH200/GB200) only |

### 1.4 Power & Thermals

| Panel | Definition | Metric | Source | Availability |
|---|---|---|---|---|
| GPU Power Usage | Current board power draw in watts. | `nvml_gpu_power_watts` | NVML `nvmlDeviceGetPowerUsage` | All GPUs, Kepler+ |
| GPU Temperature | Current GPU core temperature in Celsius. | `nvml_gpu_temperature_celsius` | NVML `nvmlDeviceGetTemperature` | All GPUs, Kepler+ |

### 1.5 Clocks

| Panel | Definition | Metric | Source | Availability |
|---|---|---|---|---|
| Clock Frequencies | Current SM and memory clock frequency in MHz. | `nvml_gpu_clock_hertz{clock="sm"\|"mem"}` | NVML `nvmlDeviceGetClockInfo` | All GPUs, Kepler+ |
| Clock Throttle Reasons | Whether each clock-limiting reason is currently active. | `nvml_gpu_clocks_event_reason_active{reason=…}` | NVML `nvmlDeviceGetCurrentClocksEventReasons` | All GPUs, Kepler+ |

### 1.6 Allocation and support

| Panel | Definition | Metric | Source |
|---|---|---|---|
| Entitlement | The pod granted this device. Constant 1; the identity is in the labels. | `gpu_alloc_device_pod_info` | Kubernetes API |
| Metric Support Matrix | Whether a GPU can produce a given metric: 1 supported, 0 not supported, absent when unknown. | `gpu_metric_supported` | NVML probe, and a recording rule for DCGM |

---

## 2. MIG level

Same fields, scoped to one GPU instance. Definitions are identical to the device level — only the scope
differs — so the two dashboards read consistently.

A MIG series carries `gpu_uuid` for the **parent card**, `mig_uuid` for the instance, and `GPU_I_ID`, which is
the only identifier DCGM publishes for an instance ([01 § 3.1](01-architecture.md)).

### 2.1 Performance

| Panel | Definition | Metric | Source |
|---|---|---|---|
| GPU Utilization | The fraction of time any portion of the graphics or compute engines were active. | `DCGM_FI_PROF_GR_ENGINE_ACTIVE` | DCGM 1001 |
| SM Efficiency | The fraction of time at least one warp was active on a multiprocessor, averaged over all multiprocessors. | `DCGM_FI_PROF_SM_ACTIVE` | DCGM 1002 |
| SM Occupancy | The fraction of resident warps on a multiprocessor, relative to the maximum number of concurrent warps supported on a multiprocessor. | `DCGM_FI_PROF_SM_OCCUPANCY` | DCGM 1003 |
| Tensor Core Utilization | The fraction of cycles the tensor (HMMA / IMMA) pipe was active. | `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`, `…_HMMA_ACTIVE`, `…_IMMA_ACTIVE` | DCGM 1004 / 1013 / 1014 |
| FP & Integer Utilization | The fraction of cycles the FP64, FP32 (FMA) and FP16 pipes were active. | `DCGM_FI_PROF_PIPE_FP64_ACTIVE`, `…_FP32_ACTIVE`, `…_FP16_ACTIVE`, `…_PIPE_INT_ACTIVE` | DCGM 1006 / 1007 / 1008 / 1016 |

All are Ampere+ with MIG enabled. **Utilization is normalized to the instance, not the card** — a saturated
`1g.6gb` slice holding 14 of 56 SMs reads ~1.0, measured ([§ 4](#4-mig-utilization-is-instance-normalized)).

### 2.2 Memory

| Panel | Definition | Metric | Source |
|---|---|---|---|
| Memory Used vs Total | Device memory in use inside the instance, against the memory assigned to it. | `nvml_gpu_memory_used_bytes{mig_uuid!=""}`, `nvml_gpu_memory_total_bytes{mig_uuid!=""}` | NVML on the instance handle |
| Memory Used Over Time | Device memory in use inside the instance. | `nvml_gpu_memory_used_bytes{mig_uuid!=""}` | NVML on the instance handle |
| Memory Held by Each Pod | Device memory held by the processes of one pod inside the instance. | `nvml_process_gpu_memory_bytes{mig_uuid!=""}` | NVML on the instance handle |

Per-process memory is the only per-process metric that survives MIG; per-process utilization is unavailable
on any MIG handle.

---

## 3. Software (eBPF)

Per-pod CUDA API behaviour, traced by uprobes on the CUDA driver library. Aggregated by
**`k8s_namespace_name`** and **`k8s_pod_name`**; the series also carry `gpu_uuid`.

| Group | Metrics |
|---|---|
| Compute activity | `ebpf_cuda_kernel_launch_calls_total`, `…_kernel_launch_duration_seconds`, `…_graph_launch_calls_total` |
| Kernel dimensions | `ebpf_cuda_kernel_grid_size_total`, `…_kernel_block_size_total`, `…_kernel_shared_memory_bytes` |
| Memory activity | `ebpf_cuda_memory_allocations_bytes_total`, `…_allocations_calls_total`, `…_frees_bytes_total`, `…_frees_calls_total`, `…_memory_copies_bytes_total`, `…_memory_memset_bytes_total`, `…_memory_peer_copies_bytes_total` |
| Synchronization | `ebpf_cuda_stream_sync_duration_seconds`, `…_device_sync_duration_seconds`, `…_event_sync_duration_seconds`, `…_event_elapsed_seconds` |
| Errors | `ebpf_cuda_errors_total` |
| HAMi enforcement | `ebpf_hami_compute_throttle_duration_seconds`, `ebpf_hami_oom_events_total` |

Eight of these twenty have produced data on this cluster. The rest are not broken: PyTorch's caching
allocator stops calling `cudaMalloc` after warm-up, no workload here uses CUDA Graphs, device barriers or
event timing, and the HAMi families need enforcement that is not happening
([05 § validation](05-exporter-ebpf.md)).

---

## 4. MIG utilization is instance-normalized

Measured on a partitioned A30, one `1g.6gb` instance holding **14 of the card's 56 SMs**, saturated:

| | Reading |
|---|---|
| `DCGM_FI_PROF_GR_ENGINE_ACTIVE{GPU_I_ID!=""}` | **0.999962** |
| `DCGM_FI_PROF_SM_ACTIVE{GPU_I_ID!=""}` | **0.998474** |
| device-normalized would have read | ~0.25 |

An instance at 100% does not mean the card is busy, and instance utilizations must never be summed into a
device figure — each is a ratio against a different denominator. There is also **no device-level profiling
series on a partitioned card**: only instance entities are reported.

---

## 5. Absent, never zero

A reading the hardware cannot supply is **omitted**, never emitted as `0`. A zero is indistinguishable from a
real measurement and corrupts every average, rate and alert over the series. `gpu_metric_supported` is the one
deliberate exception, because there `0` is itself the fact ([10 § 1.1](10-metric-support-signal.md)).
