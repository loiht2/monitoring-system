# Metrics

Every metric the system exposes, with what the number means.

Naming is by source, so an unfamiliar metric name tells you which agent produced it and therefore what it can
mean: `DCGM_FI_*` hardware counters, `nvml_*` driver-reported per-device and per-pod values, `gpu_alloc_*`
allocation state, `ebpf_*` CUDA API behaviour, `hami_*` HAMi's own accounting.

**Availability.** Metrics marked with a hardware requirement appear only on GPUs that satisfy it. A metric the
hardware cannot supply is **absent, never zero**.

---

## 1. Hardware — `DCGM_FI_*`

Reported per GPU. Under MIG, per MIG instance.

### 1.1 Utilization

| Metric | Meaning |
|---|---|
| `DCGM_FI_PROF_GR_ENGINE_ACTIVE` | Ratio of time the graphics/compute engine was active. A stricter measure than `nvml_gpu_utilization_ratio` (§2.2), and the one to use under MIG |
| `DCGM_FI_PROF_SM_ACTIVE` | Ratio of cycles at least one warp was resident on an SM, averaged over all SMs. **0.5 is ambiguous** — it can mean half the SMs fully busy, or all SMs half busy |
| `DCGM_FI_PROF_SM_OCCUPANCY` | Resident warps as a ratio of the hardware maximum. Measures how much parallelism is in flight. High occupancy does **not** mean efficient work |

### 1.2 Compute pipes

Which arithmetic units the workload is actually using. The most direct way to see whether a training job is
using the accelerator it was given.

| Metric | Meaning | Requires |
|---|---|---|
| `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE` | Ratio of cycles any tensor-core pipe was active | Volta+ |
| `DCGM_FI_PROF_PIPE_TENSOR_HMMA_ACTIVE` | Tensor activity from FP16/BF16 matrix operations | Volta+ |
| `DCGM_FI_PROF_PIPE_TENSOR_IMMA_ACTIVE` | Tensor activity from INT8 matrix operations — quantized inference | Turing+ |
| `DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE` | Tensor activity from FP64 operations | Hopper+ |
| `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` | Cycles the FP64 matrix pipe was active. A **raw counter** — use a rate, not a percentage | Ampere+ |
| `DCGM_FI_PROF_PIPE_FP64_ACTIVE` | Ratio of cycles the non-tensor FP64 pipe was active | Volta+ |
| `DCGM_FI_PROF_PIPE_FP32_ACTIVE` | Ratio of cycles the non-tensor FP32 pipe was active. High FP32 with low tensor activity in a training job usually means mixed precision is not engaged | Volta+ |
| `DCGM_FI_PROF_PIPE_FP16_ACTIVE` | Ratio of cycles the non-tensor FP16 pipe was active | Volta+ |
| `DCGM_FI_PROF_PIPE_INT_ACTIVE` | Ratio of cycles the integer pipe was active — addressing, indexing, control | Volta+ |

### 1.3 Memory bandwidth

| Metric | Meaning |
|---|---|
| `DCGM_FI_PROF_DRAM_ACTIVE` | Ratio of cycles the device memory interface was moving data. **The memory-bandwidth measure** — high DRAM with low SM activity means the workload is memory-bound |

How much memory is *in use* is an NVML metric — see §2.2. Under MIG, DCGM also reports framebuffer per
instance (`DCGM_FI_DEV_FB_USED` / `_FREE` / `_TOTAL`), which is the only way to get it per MIG instance.

### 1.4 Interconnect

| Metric | Meaning | Requires |
|---|---|---|
| `DCGM_FI_PROF_PCIE_RX_BYTES` | Bytes received over PCIe — host to device, typically input batches | Volta+ |
| `DCGM_FI_PROF_PCIE_TX_BYTES` | Bytes sent over PCIe — device to host, typically results | Volta+ |
| `DCGM_FI_PROF_NVLINK_RX_BYTES` / `_TX_BYTES` | Bytes over NVLink — peer GPU traffic in multi-GPU training | Active NVLink links |
| `DCGM_FI_PROF_HOSTMEM_CACHE_HIT` / `_MISS` | L2 hit and miss rate for host-memory access over PCIe | Grace-coupled |
| `DCGM_FI_PROF_PEERMEM_CACHE_HIT` / `_MISS` | L2 hit and miss rate for peer-GPU memory over NVLink | Hopper+ with NVLink |
| `DCGM_FI_PROF_C2C_*_BYTES` | Chip-to-chip bandwidth to and from the CPU, as total and payload-only | Grace-coupled |


---

## 2. Per-pod hardware — `nvml_*`

### 2.1 Per pod

Labels: `namespace`, `pod`, `container`, `gpu_uuid`. **These are the metrics that make a shared GPU
interpretable.**

| Metric | Meaning | Under MIG |
|---|---|---|
| `nvml_process_sm_utilization_ratio` | Fraction of SM capacity consumed by this pod's processes (0-1). On a shared GPU this is what separates a saturated tenant from an idle one | Unavailable |
| `nvml_process_memory_utilization_ratio` | Fraction of the period this pod's processes were reading or writing device memory | Unavailable |
| `nvml_process_gpu_memory_bytes` | Device memory held by this pod's processes | Available |

Values are summed per pod, so a pod with several worker processes produces one series. Process IDs never
appear as labels.

### 2.2 Per device

Labels: `gpu_uuid`, `gpu`, `node`. Device state — how much memory is in use, power, temperature, clocks and
why a clock dropped — comes from here, not from DCGM.

| Metric | Meaning |
|---|---|
| `nvml_gpu_utilization_ratio` | Fraction of the period one or more kernels was executing (0-1) |
| `nvml_gpu_memory_used_bytes` / `_free_bytes` / `_total_bytes` | Device memory allocated, available, total |
| `nvml_gpu_power_watts` | Board power draw |
| `nvml_gpu_temperature_celsius` | Core temperature |
| `nvml_gpu_clock_hertz{clock="sm\|mem"}` | Clock frequency of the named domain |
| `nvml_gpu_clocks_event_reason_active{reason="…"}` | Whether the named clock-limiting reason is active (0 or 1). One series per reason the GPU supports |

---

## 3. Allocation — `gpu_alloc_*`

| Metric | Meaning |
|---|---|
| `gpu_alloc_device_pod_info` | **Which pod has been granted which GPU**, whether or not it is using it. Always `1` — the information is in the labels |

Labels: `gpu_uuid`, `mig_uuid`, `namespace`, `pod`, `container`, `alloc_source` (`device-plugin`,
`annotation` or `dra`). Identifiers only — a MIG instance's profile and SM count come from DCGM's
`GPU_I_PROFILE` label, not from here.

This is what attributes device-level hardware metrics to pods, and it is the only way to see a GPU that is
**allocated but unused** — a pod holding a card with no live GPU process produces this metric and no
`nvml_process_*` metric at all.

---

## 4. CUDA behaviour — `ebpf_*`

Labels include `namespace`, `pod`. Every metric describes **a request the workload made**, not what the
hardware did with it.

### 4.1 Kernel launches

| Metric | Meaning |
|---|---|
| `ebpf_cuda_kernel_launch_calls_total` | Kernels launched. The clearest liveness signal for a GPU workload — a flat rate while holding a GPU means the pod has stalled |
| `ebpf_cuda_kernel_launch_duration_seconds` | Time spent inside the launch call. Launches are asynchronous, so a rise means the submission queue is backed up or something is throttling it |
| `ebpf_cuda_kernel_grid_size_total` / `_block_size_total` | Parallelism requested per launch. Explains an occupancy figure |
| `ebpf_cuda_kernel_shared_memory_bytes` | Shared memory requested per launch. Large requests limit blocks per SM and cap occupancy |
| `ebpf_cuda_graph_launch_calls_total` | CUDA graph launches — batched work that does not appear in the per-kernel counter |

### 4.2 Memory operations

| Metric | Meaning |
|---|---|
| `ebpf_cuda_memory_allocations_bytes_total` / `_calls_total` | Memory requested, by kind. Many small allocations mid-training suggests an allocator not reusing its pool |
| `ebpf_cuda_memory_frees_bytes_total` / `_calls_total` | Memory released. Allocations persistently outrunning frees is the leak signature |
| `ebpf_cuda_memory_copies_bytes_total` | Bytes copied host↔device, by direction. The input-pipeline cost — rising while kernel launches stay flat means the GPU is starved |
| `ebpf_cuda_memory_peer_copies_bytes_total` | Bytes copied directly between GPUs |
| `ebpf_cuda_memory_memset_bytes_total` | Bytes cleared on the device |

### 4.3 Waiting and failures

| Metric | Meaning |
|---|---|
| `ebpf_cuda_stream_sync_duration_seconds` | Time blocked waiting for a stream — **the host waiting for the GPU** |
| `ebpf_cuda_device_sync_duration_seconds` | Time blocked waiting for the whole device. Frequent full-device syncs serialize a pipeline |
| `ebpf_cuda_event_sync_duration_seconds` | Time blocked waiting for an event |
| `ebpf_cuda_event_elapsed_seconds` | **Real on-device execution time.** Only present for workloads that measure themselves with CUDA events |
| `ebpf_cuda_errors_total` | CUDA calls returning an error, by function and code. Catches failures a workload swallows without logging |

### 4.4 HAMi enforcement

Present only where HAMi's interception library is injected into the container.

| Metric | Meaning |
|---|---|
| `ebpf_hami_compute_throttle_duration_seconds` | Delay HAMi imposed before passing a launch to the driver — **the compute limit being enforced, measured directly** |
| `ebpf_hami_oom_events_total` | Allocations HAMi refused because the pod hit its memory limit. Distinguishes a quota rejection from a real device out-of-memory |

---

## 5. HAMi accounting — `hami_*`

Present only where HAMi's classic device-plugin is deployed. Labels: `namespace`, `pod`, `container`,
`vdevice_index`, `device_uuid`.

| Metric | Meaning |
|---|---|
| `hami_vgpu_memory_limit_bytes` | The memory ceiling HAMi enforces for this container — its quota, not the GPU's capacity |
| `hami_vgpu_memory_used_bytes` | What HAMi counts against that ceiling |
| `hami_vgpu_memory_context_bytes` / `_module_bytes` / `_buffer_bytes` | Breakdown by CUDA contexts, loaded modules and data buffers. Buffers are the part a workload can actually reduce |
| `hami_container_device_memory_bytes` | Memory this container holds on one virtual device |
| `hami_container_device_utilization_ratio` | Compute utilization as HAMi's own sampling measures it — the number its throttling decisions use |
| `hami_container_last_kernel_elapsed_seconds` | Time since this container's last kernel |
| `hami_mig_device_info` | Which MIG instance a container is bound to |

**These deliberately overlap with `nvml_process_*`, and the difference is the point.** HAMi reports what it
believes; NVML reports what the driver sees. When they disagree, HAMi is enforcing against a number that does
not match reality — see [04 — Querying](04-querying.md).
