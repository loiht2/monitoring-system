# 08 — Validation

Every phase ends with a **metric-level check on a live cluster under real load**, never with a successful
`kubectl apply`. Three failure modes here are invisible to deployment-level checks: a ServiceMonitor scraped by
nothing because no operator controller runs; an eBPF agent healthy with zero probes attached; a DCGM field
present but degraded by profiling multiplexing.

---

## 1. Phases

Cheap-and-safe sources first; the expensive one last, after the backend's real cost is known.

| Phase | Delivers |
|---|---|
| **0** | Repository, CI, image publishing; Prometheus Operator, Prometheus, Grafana, storage |
| **1** | DCGM field-list extension, ServiceMonitor, relabeling, hardware dashboard |
| **2** | NVML exporter — device metrics, per-pod metrics, `gpu_alloc` |
| **3** | eBPF exporter — rename, build, replace the legacy agent |
| **4** | MIG validation on a dedicated MIG-enabled device |
| **5** | Port to the production environment, including vGPUmonitor integration |

MIG awareness is **built** in phases 1-3 and **validated** in phase 4 — toggling MIG per phase costs more than
one consolidated pass, and requires an idle device.

---

## 2. Exit criteria

### Phase 0 — backend

| Check | Passing result |
|---|---|
| Operator controller | Running — not merely CRDs present |
| End-to-end scrape | Our own ServiceMonitor for the existing DCGM exporter produces `DCGM_FI_*` series in Prometheus. Pre-existing ServiceMonitors are **not** used as the proof: they do not carry our selector label, and adopting them would mean widening `serviceMonitorSelector` to select everything |
| Storage | Prometheus survives a pod delete with TSDB intact, or `emptyDir` is a recorded temporary choice |
| Grafana | Datasource provisioned; no pre-existing datasource removed |

### Phase 1 — DCGM

| Check | Passing result |
|---|---|
| Added fields | Every field whose tier the fleet satisfies returns non-blank values under load |
| **Regression on existing fields** | Fields collected before the change report statistically indistinguishable values under the *same* load after it |
| Relabeling | `gpu_uuid` present **and** the original label retained, including after the exporter restarts |

Pod attribution is **not** a Phase 1 criterion: `gpu_alloc_device_pod_info` does not exist until Phase 2, so
device metrics are legitimately unattributed at the end of this phase. The join is tested in Phase 2.

The regression check is the only test that detects profiling multiplexing
([03 § 1.1](03-exporter-dcgm.md)); without it the phase can pass while silently degrading working data.

### Phase 2 — NVML

Full criteria in [04 § 5](04-exporter-nvml.md). The acceptance test for the entire design:

> Two pods sharing one physical device with different compute shares are **distinguishable** by
> `nvml_process_sm_utilization_ratio`, in the direction their shares predict.

### Phase 3 — eBPF

| Check | Passing result |
|---|---|
| Probes attached | `ebpf_cuda_kernel_launch_calls_total` increases during a training workload |
| Rename complete | No `gpu_cuda_*` / `gpu_hami_*` series anywhere; dashboards use the new names |
| Throttle path | `ebpf_hami_compute_throttle_duration_seconds` non-zero under enforced throttling |
| Legacy agent | Removed, configuration snapshot stored outside the repository |
| Port | No collision with the DCGM or NVML exporter |
| Cardinality | Measured against the Phase 0 assumption; backend resources revised if exceeded |

### Phase 4 — MIG

| Check | Passing result |
|---|---|
| DCGM | `PROF_*` series appear on instance entities carrying `GPU_I_ID` **and** `GPU_I_PROFILE` (A-9) |
| Utilization normalization | Saturating one small instance shows whether `GR_ENGINE_ACTIVE` is instance- or device-normalized (A-8). Record the answer — every MIG utilization panel depends on it |
| `gpu_alloc` | Carries `mig_uuid` for pods holding an instance |
| Attribution | Instance hardware metrics join to exactly one pod |
| NVML degradation | `nvml_process_sm_utilization_ratio` absent; `nvml_process_gpu_memory_bytes` present |
| **Non-MIG devices unaffected** | Whole-device workloads and their metrics unchanged |
| Dashboards | The per-pod-busy fallback chain resolves on both device modes |

### Phase 5 — production port

| Check | Passing result |
|---|---|
| Dashboards | Render with **no panel edits** |
| vGPUmonitor | Scraped; two device-level families dropped; legacy names confirmed disabled |
| Existing consumers | Every pre-existing DCGM consumer behaves identically — verified explicitly, not assumed |
| Metadata join | Works where the metadata source exists; panels degrade to anonymous where it does not |

---

## 3. Load generators

Existing platform workloads rather than synthetic tools, so the metrics are confirmed against real training
behaviour.

| Generator | Exercises |
|---|---|
| CNN training, several model families and batch sizes | Sustained compute, tensor and FP32 pipes, steady launch rate, periodic host-to-device transfer |
| Transformer training | Larger allocations, different access pattern, higher DRAM activity |
| **Paired co-tenant runs at differing compute shares** | The Phase 2 acceptance test |
| Pod claiming a device, never initializing CUDA | Entitlement without occupancy |
| Deliberately over-allocating workload | Allocation failure paths, HAMi OOM counters |
| Whole-device stress | Upper bounds, throttle reasons, thermal and power ceilings |

---

## 4. Signature-to-metric mapping

Confirms a metric is *real* rather than merely *present* — a field that does not respond to a load change is
not working.

| Load signature | Expected response |
|---|---|
| Convolution-heavy training | `PROF_PIPE_FP32_ACTIVE` and `PROF_PIPE_TENSOR_ACTIVE` rise together; `PROF_SM_ACTIVE` high |
| Mixed precision | `PROF_PIPE_TENSOR_HMMA_ACTIVE` rises; FP32 pipe falls relative to it |
| Batch boundaries | Periodic `ebpf_cuda_memory_copies_bytes_total` increments |
| Model initialization | `ebpf_cuda_memory_allocations_bytes_total` step, then plateau |
| Enforced throttling | `ebpf_hami_compute_throttle_duration_seconds` rises **while** `PROF_GR_ENGINE_ACTIVE` stays below the configured share |
| Two co-tenants, unequal shares | `nvml_process_sm_utilization_ratio` differs in the predicted direction |
| Idle holder | `gpu_alloc_device_pod_info` present; `nvml_process_*` absent; `hami_container_last_kernel_elapsed_seconds` grows |
| Memory exhaustion | `ebpf_hami_oom_events_total` increments; `nvml_gpu_memory_used_bytes` at ceiling |

---

## 5. Environment hazards

| Hazard | Effect |
|---|---|
| Admission-time mutation | A policy injecting environment variables into GPU-claiming pods changes enforcement for every test pod. Read admission policies before attributing a measurement to the workload |
| Node labels contradicting hardware | Device-manager labels can report a MIG configuration never applied. The device query tool is the only truth |
| Concurrent profiling | An attached profiler can prevent DCGM's profiling context initializing. Do not profile during validation |
| Memory pressure | Where scheduler request accounting is below actual usage, adding the backend triggers contention unrelated to the test |
| Single-node clusters | Cross-node aggregation, node-failure behaviour and scheduler spread are **untestable** and must be marked so, not assumed working |

---

## 6. Data hygiene

- Record the exact workload configuration with every measurement — "utilization was 80%" without batch size and
  compute share is not a result.
- Take before/after measurements under the **same** load for any configuration change.
- Keep raw exporter output for anomalies, not just dashboard screenshots — the label set is usually the answer.
- An unexplained metric is a finding: record it in [09](09-risks-and-open-questions.md) rather than discard it.
