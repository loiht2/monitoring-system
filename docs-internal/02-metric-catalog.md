# 02 — Metric catalog

Reference. Every metric this system produces or consumes: what it means, its unit, its origin, and its
hardware precondition.

Capability is expressed against **GPU architecture tiers**, never a GPU model. The **Catalog** column gives the
requirement row each metric satisfies.

---

## 1. Capability tiers

| Tier | Unlocks |
|---|---|
| **Kepler+** (every NVML device) | Device utilization, per-process utilization, framebuffer, per-process memory, power, temperature, SM/memory clocks, clock-throttle reasons |
| **Maxwell+** | PCIe throughput via NVML |
| **Volta+** | The profiling engine: graphics-engine active, SM active, SM occupancy, tensor-pipe active, HMMA, FP64/FP32/FP16 pipe active, integer pipe active, DRAM active, PCIe RX/TX bytes |
| **Turing+** | IMMA (INT8 matrix) pipe activity |
| **Ampere+** | DMMA cycle counter (raw cycles; no ratio field exists at any tier) |
| **Hopper+** | DFMA tensor-pipe activity; the entire NVML **GPM** metric-id family |
| **NVLink-equipped** *(precondition)* | NVLink RX/TX bytes — requires **active links**, not merely capable silicon |
| **Grace-coupled** *(precondition)* | Host-memory and C2C L2 cache hit/miss rates, C2C RX/TX bytes |
| **MIG enabled** (Ampere+) | All `PROF_*` metrics re-scoped to `GPU_I` instance entities |

Four consequences that are easy to get wrong:

- **NVML GPM is Hopper+.** On any pre-Hopper fleet the catalog's "or NVML GPM …" alternatives do not exist;
  DCGM profiling is the only route to occupancy and pipe activity.
- **DMMA has no ratio field at any tier** — raw cycles, present as a rate, never as a percentage.
- **NVLink metrics require active links.** An unpopulated bridge reports all links inactive and every NVLink
  field stays blank. Discovered at runtime (§5), never assumed from a model name.
- **Under MIG, device-level utilization becomes invalid.** `DCGM_FI_DEV_GPU_UTIL` and the NVML device
  utilization call report N/A; `PROF_GR_ENGINE_ACTIVE` on the instance entity replaces them.

### 1.1 Catalog coverage

The catalog's `Source` column assigns each of the 33 general rows to exactly one source — **24 to DCGM, 9 to
NVML** ([00 § 3](00-decisions.md)). NVML's nine are rows 1, 2, 21, 22 and 29-33; DCGM has the rest.

**22 of the 33 rows are obtainable on any Volta+ fleet.** The remaining 11 are gated by a hardware
precondition, and two of those have no DCGM field at any tier:

| Rows | Gate |
|---|---|
| 8 — FP64 tensor (DFMA) | Hopper+ |
| 15, 18 — L2 hit/miss, host memory | Grace-coupled |
| 16, 19 — L2 hit/miss, peer memory | Hopper+ with NVLink |
| 25, 26 — NVLink RX/TX | Active NVLink links |
| 27, 28 — C2C bandwidth | Grace-coupled |
| **17, 20 — L2 hit/miss over C2C** | **No DCGM ratio field exists at any tier.** The nearest signal is the C2C byte counters (rows 27-28), which is a different measurement. Not deliverable |

---

## 2. DCGM — `DCGM_FI_*`

Owner: NVIDIA's `dcgm-exporter`. Our deliverable is the field list only ([03](03-exporter-dcgm.md)).
Sections follow the catalog's own taxonomy.

### 2.1 Performance (catalog rows 3-20)

| Catalog | Field | Meaning | Tier |
|---|---|---|---|
| — | `DCGM_FI_DEV_GPU_UTIL` | Percent of the period one or more kernels was executing. **Row 1 is NVML's** (§3.1); this field is retained only because it is already collected and an existing consumer depends on it. Build nothing new on it | Kepler+ |
| — | `DCGM_FI_PROF_GR_ENGINE_ACTIVE` | Ratio of time the graphics/compute engine was active. A stricter measure than row 1, and its **MIG-valid replacement** (catalog MIG row 3) | Volta+ |
| 3 | `DCGM_FI_PROF_SM_ACTIVE` | Ratio of cycles at least one warp was resident on an SM, averaged over SMs. **0.5 is ambiguous** — half the SMs fully busy, or all SMs half busy | Volta+ |
| 4 | `DCGM_FI_PROF_SM_OCCUPANCY` | Resident warps as a ratio of the hardware maximum. Measures parallelism in flight; high occupancy does **not** imply efficient work | Volta+ |
| 5 | `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE` | Ratio of cycles any tensor-core pipe was active. The clearest indicator that a training job is using the accelerator it was given | Volta+ |
| 6 | `DCGM_FI_PROF_PIPE_TENSOR_HMMA_ACTIVE` | Tensor activity from **FP16/BF16** matrix operations | Volta+ |
| 7 | `DCGM_FI_PROF_PIPE_TENSOR_IMMA_ACTIVE` | Tensor activity from **INT8** matrix operations — quantized inference | Turing+ |
| 8 | `DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE` | Tensor activity from **FP64** operations | **Hopper+** |
| 9 | `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` | Cycles the FP64 matrix pipe was active. **Raw counter, not a ratio** | **Ampere+** |
| 10 | `DCGM_FI_PROF_PIPE_FP64_ACTIVE` | Ratio of cycles the **non-tensor** FP64 pipe was active — double-precision scientific compute | Volta+ |
| 11 | `DCGM_FI_PROF_PIPE_FP32_ACTIVE` | Ratio of cycles the **non-tensor** FP32 pipe was active. High FP32 with low tensor activity in training usually means mixed precision is not engaged | Volta+ |
| 12 | `DCGM_FI_PROF_PIPE_FP16_ACTIVE` | Ratio of cycles the **non-tensor** FP16 pipe was active | Volta+ |
| 13 | `DCGM_FI_PROF_PIPE_INT_ACTIVE` | Ratio of cycles the integer pipe was active — addressing, indexing, control | Volta+ |
| 14 | `DCGM_FI_PROF_DRAM_ACTIVE` | Ratio of cycles the device memory interface was sending or receiving data. **The memory-bandwidth proxy** — high DRAM with low SM activity means memory-bound | Volta+ |
| 15 / 18 | `DCGM_FI_PROF_HOSTMEM_CACHE_HIT` / `_MISS` | L2 hit/miss rate for accesses to **host** memory over PCIe | **Grace-coupled** |
| 16 / 19 | `DCGM_FI_PROF_PEERMEM_CACHE_HIT` / `_MISS` | L2 hit/miss rate for accesses to **peer GPU** memory over NVLink | **Hopper+ / NVLink** |
| 17 / 20 | *no field exists* | L2 hit/miss over the C2C link. See §1.1 — not deliverable at any tier | — |

Catalog rows 1 and 2 are NVML's — see §3.1 and §3.2. Row 2 has no DCGM equivalent at any tier.

### 2.2 Memory (catalog MIG row 16)

General-catalog row 21 is NVML's (§3.1). These fields are DCGM's only **under MIG**, where MIG row 16 requires
framebuffer per instance and NVML cannot supply it. Off MIG they are retained but not the designated source.

| Catalog | Field | Meaning | Unit |
|---|---|---|---|
| MIG 16 | `DCGM_FI_DEV_FB_USED` | Framebuffer memory currently allocated | MiB |
| MIG 16 | `DCGM_FI_DEV_FB_FREE` | Framebuffer memory available for allocation | MiB |
| MIG 16 | `DCGM_FI_DEV_FB_TOTAL` | Total framebuffer memory | MiB |

Catalog row 22 (VRAM per process) has no DCGM equivalent at any tier; see §3.2.

### 2.3 Data transfer (catalog rows 23-28)

| Catalog | Field | Meaning | Tier |
|---|---|---|---|
| 23 | `DCGM_FI_PROF_PCIE_RX_BYTES` | Bytes received by the GPU over PCIe — host-to-device, typically input batches | Volta+ |
| 24 | `DCGM_FI_PROF_PCIE_TX_BYTES` | Bytes transmitted over PCIe — device-to-host, typically results and gradients | Volta+ |
| 25 | `DCGM_FI_PROF_NVLINK_RX_BYTES` | Bytes received over NVLink — peer GPU traffic in multi-GPU training | **active links** |
| 26 | `DCGM_FI_PROF_NVLINK_TX_BYTES` | Bytes transmitted over NVLink | **active links** |
| 27 | `DCGM_FI_PROF_C2C_RX_ALL_BYTES` / `_RX_DATA_BYTES` | Chip-to-chip bandwidth from the CPU: total including protocol overhead, and payload only | **Grace-coupled** |
| 28 | `DCGM_FI_PROF_C2C_TX_ALL_BYTES` / `_TX_DATA_BYTES` | Chip-to-chip bandwidth to the CPU, same two forms | **Grace-coupled** |

### 2.4 Hardware (catalog rows 29-33) — NVML's, not DCGM's

Power, temperature, clocks and throttle reasons are assigned to **NVML** by the catalog; see §3.1.

The vendor's default DCGM field list already emits `DCGM_FI_DEV_POWER_USAGE`, `DCGM_FI_DEV_GPU_TEMP`,
`DCGM_FI_DEV_SM_CLOCK` and `DCGM_FI_DEV_MEM_CLOCK`. They stay — removing an already-collected field breaks
existing consumers — but they are not the designated source and no dashboard or query is built on them.
`DCGM_FI_DEV_CLOCK_THROTTLE_REASONS` is **not** added to the field list, because row 33 is NVML's and adding
it would create a second source for one requirement.

### 2.5 MIG (catalog MIG rows 1-17)

Under MIG, DCGM emits `PROF_*` and framebuffer fields on `GPU_I` entities. Every catalog performance and
memory row above re-scopes to the instance, so the field list does not change — only the entity does.

`nvidia-smi` is **not** a collection source anywhere in this system. It is a command, not a pollable endpoint;
where a catalog row lists it as an alternative, the DCGM or NVML route is used instead.

| Catalog | Item | Source |
|---|---|---|
| 1 | Instance identity — `GPU_I_ID` (which instance) and `GPU_I_PROFILE` (its size, e.g. a 1-slice/6 GB profile) | dcgm-exporter entity labels |
| 2 | **SMs assigned to the instance** — needed to normalize utilization across unequal instances (see A-8). DCGM emits the profile *name*, not an SM count: derive the count from `GPU_I_PROFILE` via the vendor's published profile table for the GPU model. It is static per profile, so it is a lookup in a recording rule or dashboard, never a polled measurement | dcgm-exporter entity labels |
| 3 | Instance busy — `PROF_GR_ENGINE_ACTIVE`. `DCGM_FI_DEV_GPU_UTIL` and NVML report **N/A** under MIG | DCGM on `GPU_I` |
| 4-15 | SM activity, occupancy, tensor and pipe breakdowns, DRAM activity | Same fields as §2.1, `GPU_I` entity |
| 16 | VRAM used in the instance — `FB_USED` / `FB_FREE` / `FB_TOTAL` | DCGM on `GPU_I` |
| 17 | VRAM per process in the instance — **the only per-process metric that survives MIG** | NVML on the MIG device handle (§3.2) |

Because an instance is exclusively assigned, every one of these becomes attributable to exactly one pod.


---

## 3. NVML exporter — `nvml_*` and `gpu_alloc_*`

Owner: this project ([04](04-exporter-nvml.md)). Prometheus conventions: base units, `_ratio` in 0-1 (never
percent), explicit unit suffixes.

### 3.1 Device level — labels `{gpu_uuid, gpu, node}`

| Catalog | Metric | Meaning | Unit |
|---|---|---|---|
| 1 | `nvml_gpu_utilization_ratio` | Fraction of the period one or more kernels was executing. Occupied, not saturated — one tiny kernel reads 100%. N/A under MIG | 0-1 |
| 21 | `nvml_gpu_memory_used_bytes` / `_free_bytes` / `_total_bytes` | Device memory allocated / available / total | bytes |
| 29 | `nvml_gpu_power_watts` | Instantaneous board power draw | W |
| 30 | `nvml_gpu_temperature_celsius` | GPU core temperature | °C |
| 31, 32 | `nvml_gpu_clock_hertz{clock="sm\|mem"}` | Current clock frequency of the named domain | Hz |
| 33 | `nvml_gpu_clocks_event_reason_active{reason="…"}` | Whether the named clock-limiting reason is currently active. One series per reason the device supports — the per-reason form of row 33 | 0\|1 |

### 3.2 Per-pod — labels `{gpu_uuid, namespace, pod, container}`

The reason this exporter exists: the two catalog rows with **no DCGM equivalent at any tier**.

| Catalog | Metric | Meaning | MIG |
|---|---|---|---|
| 2 | `nvml_process_sm_utilization_ratio` | Fraction of SM capacity consumed by **this pod's** processes. On a shared device this is what separates a saturated tenant from an idle one | **N/A** |
| 2 | `nvml_process_memory_utilization_ratio` | Fraction of the period **this pod's** processes were reading or writing device memory. Distinguishes a bandwidth-bound tenant from a compute-bound one on the same card | **N/A** |
| 22 / MIG 17 | `nvml_process_gpu_memory_bytes` | Device memory held by this pod's processes. The only per-process metric that survives MIG | available |

Summed per pod; host PID never becomes a label ([01 § 2.1](01-architecture.md)).

### 3.3 Allocation

| Metric | Meaning | Labels |
|---|---|---|
| `gpu_alloc_device_pod_info` | **Entitlement**: this pod has been granted this device or MIG instance, whether or not it is using it. Constant `1`; the information is in the labels. Joining it to DCGM attributes device metrics to pods; its presence without live NVML process metrics is the idle-GPU signal | `gpu_uuid`, `mig_uuid`, `namespace`, `pod`, `container`, `alloc_source="device-plugin\|annotation\|dra"` |

Labels are **identifiers only** — no instance profile, no SM count. MIG rows 1-2 are DCGM's, and duplicating
them here would make this a second source for a requirement DCGM already owns ([00 § 3](00-decisions.md)).


---

## 4. eBPF exporter — `ebpf_cuda_*`, `ebpf_hami_*`

Owner: this project, inherited and renamed ([05](05-exporter-ebpf.md)). The requirement is the CUDA-API
tracing catalog: the CUDA driver functions to trace and, separately, the HAMi interception library's entry
points. Every metric is captured by uprobes, so each describes **a request the workload made**, never what the
hardware did with it.

### 4.1 Kernel launch

| Metric | Meaning | Type |
|---|---|---|
| `ebpf_cuda_kernel_launch_calls_total` | Kernels launched — from `cuLaunchKernel`, `cuLaunchCooperativeKernel`, `cuLaunchKernelEx`. Rate is the clearest liveness signal for a GPU workload; flat under an active allocation means the pod has stalled | counter |
| `ebpf_cuda_kernel_launch_duration_seconds` | Time inside the launch call. Launches are asynchronous, so a rise means queue backpressure or throttled submission | histogram |
| `ebpf_cuda_kernel_grid_size_total` | Cumulative grid dimensions requested — how much parallelism per launch | counter |
| `ebpf_cuda_kernel_block_size_total` | Cumulative block dimensions requested. With grid size, explains an occupancy figure | counter |
| `ebpf_cuda_kernel_shared_memory_bytes` | Shared memory requested per launch. High requests limit blocks per SM, capping occupancy | histogram |
| `ebpf_cuda_graph_launch_calls_total` | `cuGraphLaunch` — batched work submitted as one unit, so it does not appear in the per-kernel counter | counter |

### 4.2 Memory

| Metric | Meaning | Type |
|---|---|---|
| `ebpf_cuda_memory_allocations_bytes_total` | Bytes requested via the device, managed, pinned-host and stream-ordered allocators, labelled by memory kind | counter |
| `ebpf_cuda_memory_allocations_calls_total` | Allocation calls. Many small allocations mid-training indicates an allocator not reusing its pool | counter |
| `ebpf_cuda_memory_frees_bytes_total` | Bytes released, including host-pinned unregister. Allocations persistently exceeding frees is the leak signature | counter |
| `ebpf_cuda_memory_frees_calls_total` | Free calls | counter |
| `ebpf_cuda_memory_copies_bytes_total` | Bytes copied host↔device or device↔device, labelled by direction. The input-pipeline cost; rising with flat launches means the GPU is starved | counter |
| `ebpf_cuda_memory_peer_copies_bytes_total` | Bytes copied directly between GPUs | counter |
| `ebpf_cuda_memory_memset_bytes_total` | Bytes cleared on the device | counter |

### 4.3 Synchronization and errors

| Metric | Meaning | Type |
|---|---|---|
| `ebpf_cuda_stream_sync_duration_seconds` | Time blocked waiting for a stream to drain — **the host waiting for the GPU** | histogram |
| `ebpf_cuda_device_sync_duration_seconds` | Time blocked waiting for the whole device. Frequent full-device syncs serialize a pipeline | histogram |
| `ebpf_cuda_event_sync_duration_seconds` | Time blocked waiting for a specific event | histogram |
| `ebpf_cuda_event_elapsed_seconds` | **Real on-device execution time** between two events — the one genuine hardware timing here. Exists only for workloads that request it themselves, so it is a bonus, never a dependency | histogram |
| `ebpf_cuda_errors_total` | CUDA calls returning a non-zero status, labelled by function and code. Catches failures a workload swallows without logging | counter |

### 4.4 HAMi interception

Present only where HAMi's interception library is injected into the workload container.

| Metric | Meaning | Type |
|---|---|---|
| `ebpf_hami_compute_throttle_duration_seconds` | Delay the library imposed before passing a launch to the driver — **the compute limit being enforced, measured directly** | histogram |
| `ebpf_hami_oom_events_total` | Allocations the library refused because the pod's memory limit was reached, labelled by memory kind. Distinguishes a HAMi quota rejection from a genuine device OOM | counter |

### 4.5 Cardinality

Twelve histogram families × pod × CUDA function × memory/copy kind. **This exporter dominates the system's
series count by an order of magnitude**; sizing and retention follow from it alone
([05 § 5](05-exporter-ebpf.md)).

---

## 5. Runtime discovery

Exporters never hardcode hardware capability.

### 5.1 Device enumeration

Devices, UUIDs and MIG mode are enumerated from NVML at startup and re-enumerated
on change. A MIG-enabled device is expanded into its instances, and per-process utilization is not attempted
on it.

### 5.2 Optional-field probing

Fields gated by architecture or configuration are probed once at startup. A
field reporting unsupported is **not emitted at all — never emitted as zero.** A zero is indistinguishable
from a real measurement and corrupts every average, rate and alert computed over the series. Applies to
NVLink throughput, clock-event reasons (the supported mask determines which `reason` values exist), and every
precondition-gated row in §1.1.

### 5.3 Profiling-field verification

Adding profiling fields can make DCGM multiplex, changing the sampling
duty cycle of fields already collected. Availability is verified by **value comparison under identical load,
before and after** a configuration change — not by presence ([08 § Phase 1](08-validation.md)).

---

## 6. HAMi vGPUmonitor — `hami_*`

Consumed, not produced ([06](06-hami-vgpumonitor.md)). Not part of the hardware catalog: it reports HAMi's
enforcement view, which no catalog row covers and no other source can supply. Labels:
`{namespace, pod, container, vdevice_index, device_uuid}`. Two device-level families it also emits are
dropped at scrape time; see [06 § 3](06-hami-vgpumonitor.md).

| Metric | Meaning | Kept |
|---|---|---|
| `hami_vgpu_memory_limit_bytes` | The memory ceiling HAMi enforces for this container — its quota, not the device's capacity | ✅ |
| `hami_vgpu_memory_used_bytes` | What HAMi counts against that ceiling. Differs from NVML by design; the difference is memory the card holds that HAMi is not counting | ✅ |
| `hami_vgpu_memory_context_bytes` | Portion of usage held by CUDA contexts | ✅ |
| `hami_vgpu_memory_module_bytes` | Portion held by loaded CUDA modules | ✅ |
| `hami_vgpu_memory_buffer_bytes` | Portion held by data buffers — the part a workload can actually reduce | ✅ |
| `hami_container_device_memory_bytes` | Memory this container holds on one virtual device | ✅ |
| `hami_container_device_utilization_ratio` | Compute utilization as **HAMi's own sampling** measures it — the number its throttling decisions are based on | ✅ |
| `hami_container_last_kernel_elapsed_seconds` | Time since this container's last kernel. An idle signal independent of both NVML and eBPF | ✅ |
| `hami_mig_device_info` | Which MIG instance a container is bound to, as HAMi sees it | ✅ |

---

## 7. Deliberate semantic overlap

Three concepts are measured by more than one source **on purpose**. The divergence is the diagnostic, not a
defect to clean up. **None of them crosses the DCGM/NVML boundary** — that comparison is forbidden by
[00 § 3](00-decisions.md), which is why device busy is not listed here even though both sources emit a form
of it.

| Concept | Sources | What disagreement means |
|---|---|---|
| Per-container GPU memory | `nvml_process_gpu_memory_bytes` vs `hami_vgpu_memory_used_bytes` | Memory on the card that HAMi is not counting toward its limit |
| Per-container utilization | `nvml_process_sm_utilization_ratio` vs `hami_container_device_utilization_ratio` | HAMi's sampling disagrees with the driver's — it is throttling against the wrong number |
| Idleness | `nvml_process_*` absent, `hami_container_last_kernel_elapsed_seconds` large, `ebpf_cuda_kernel_launch_calls_total` flat | Three independent idle signals; agreement across them is what makes automated reclamation safe |
