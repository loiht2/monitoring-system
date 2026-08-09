# 00 — Contract and decisions

The rules the rest of this specification is written against. Read this first.

---

## 1. The four sources and the authority model

Three exporters we own; one that exists wherever HAMi's classic device-plugin runs, which we consume.

| # | Source | Origin |
|---|---|---|
| 1 | **DCGM** | [NVIDIA/dcgm-exporter](https://github.com/NVIDIA/dcgm-exporter) — **configuration only**, never built or forked |
| 2 | **NVML** | New Go exporter built on [NVIDIA/go-nvml](https://github.com/NVIDIA/go-nvml) |
| 3 | **eBPF CUDA tracing** | New build of [loiht2/eBPF-Lens](https://github.com/loiht2/eBPF-Lens), which tracks [loiht2/eBPF-Lens-core](https://github.com/loiht2/eBPF-Lens-core) as a submodule |
| 4 | **HAMi vGPUmonitor** | The `vgpu-monitor` container in [Project-HAMi/HAMi](https://github.com/Project-HAMi/HAMi)'s device-plugin DaemonSet — **consumed, not deployed** |

Overlapping measurement is expected. Overlapping *authority* is not — an operator must never have to choose:

| Question | Authority |
|---|---|
| What is the hardware doing? | **DCGM** |
| What is the driver reporting per process? | **NVML** |
| What does HAMi believe and enforce? | **vGPUmonitor** (`hami_*`) |
| What did the workload ask CUDA to do? | **eBPF** |
| Which pod holds which device? | **`gpu_alloc_*`** |

**NVML is the only source returning a hardware counter and a host PID in the same call**, which is what makes
per-pod hardware attribution possible. It is the load-bearing member of the set, not the redundant one.

---

## 2. The hard invariant

> **No metric name may be emitted by two exporters.**
> `DCGM_FI_*` → dcgm-exporter. `nvml_*`, `gpu_alloc_*` → NVML exporter. `ebpf_cuda_*`, `ebpf_hami_*` → eBPF
> exporter. `hami_*` → vGPUmonitor. Verified non-colliding.

---

## 3. DCGM and NVML are separate streams

**Keep the metric streams from DCGM and NVML strictly separated. Do not cross-reference or combine metrics
between these two sources to support one another.**

Which source owns which metric is **not a judgement call**. The requirement catalog's `Source` column assigns
every row to exactly one of them — 24 rows to DCGM, 9 to NVML:

| Source | Owns |
|---|---|
| **DCGM** | Everything profiling-derived — SM activity and occupancy, tensor and FP/INT pipe activity, DRAM activity, L2 cache rates — plus PCIe, NVLink and chip-to-chip throughput |
| **NVML** | Device utilization and memory, **per-process** utilization and memory, power, temperature, clocks, throttle reasons |

Note that this is *not* a device-level / per-process split: NVML owns several device-level rows. Per-process
attribution is unique to NVML, but it is not the boundary.

**Allowed exceptions:** sharing general hardware identifiers (for example `gpu_uuid`) and standard relabeling
operations.

Three consequences that follow directly:

- A metric assigned to one source is **not emitted by the other**, and no query may use one source to
  validate, correct or fill gaps in the other.
- Where the vendor's default DCGM field list already emits a field the catalog assigns to NVML, it **stays** —
  removing an already-collected field breaks existing consumers ([03 § 1](03-exporter-dcgm.md)) — but it is
  not the designated source, and nothing new is built on it.
- `gpu_alloc_*` is **not** part of the NVML stream. It is Kubernetes allocation state that happens to be
  emitted by the same process for lifecycle reasons ([01 § 1](01-architecture.md)), and joining it to DCGM is
  an identifier join, not a cross-source metric combination.

---

## 4. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D-1** | Environments | Build and validate on the **validation cluster**; ship to the **ML Platform production cluster** | Validation hardware is what we can probe; production contracts cost nothing to honour early |
| **D-2** | Scope | Exporters **+ Prometheus + Grafana dashboards** | Acceptance is a dashboard an operator reads |
| **D-3** | Attribution depth | **Per-pod, including hardware metrics** | Device-level cannot separate co-tenants |
| **D-4** | MIG | **In scope — must work** | Validated on a dedicated MIG-enabled device while the rest of the fleet stays whole |
| **D-5** | Packaging | **Plain numbered YAML**, one directory per environment | Mirrors the platform's existing convention |
| **D-6** | NVML exporter | **Go, on NVIDIA's `go-nvml`** | One toolchain with the eBPF exporter; the binding carries both spellings of the renamed clock-event API, so no hand-written driver-version shim; `client-go` informers instead of a poll loop; static binary |
| **D-7** | eBPF deployment | **Uninstall the legacy Helm release; deploy as our own numbered YAML** | One convention across all three exporters |
| **D-8** | Images | **GHCR from day one**, built in CI | One registry for both environments |
| **D-9** | Attribution architecture | **Hybrid.** NVML self-resolves pod from cgroup; DCGM joins on device UUID against `gpu_alloc_*` | A host PID must never become a label; a device UUID is stable and joinable |
| **D-10** | Allocation source | **Kubernetes API**, inheriting the platform's parsers | One code path for device-plugin, annotation and DRA; no privileged kubelet socket |
| **D-11** | vGPUmonitor | **Fourth source, deduplicated at scrape** | Its device-level families duplicate NVML exactly; its container-level families are unobtainable elsewhere |
| **D-12** | eBPF metric prefix | **`ebpf_cuda_*` / `ebpf_hami_*`** | Prefix-by-source everywhere; disambiguates from vGPUmonitor's `hami_*` |
| **D-13** | Allocation parsing | **Reimplement the ML Platform's parsers in Go, citing the Python original as the schema reference** | The annotation and DRA-claim schemas were confirmed on a live cluster upstream; the language differs, the contract does not |
| **D-14** | eBPF source tracking | **Git submodule**, inheriting the agent's own submodule pin | Reproducible builds from this repository alone |
| **D-15** | DCGM / NVML boundary | **Strictly separate streams**, split by the requirement catalog's `Source` column — 24 rows DCGM, 9 rows NVML | §3 |

---

## 5. Document index

| Document | Contents |
|---|---|
| [01 — Architecture](01-architecture.md) | Topology, attribution architecture, label contract, PID → pod, worked queries |
| [02 — Metric catalog](02-metric-catalog.md) | Every metric with its meaning, traced to the requirement catalog — **reference** |
| [03 — DCGM exporter](03-exporter-dcgm.md) | Field-list extension, ServiceMonitor, relabeling |
| [04 — NVML exporter](04-exporter-nvml.md) | Vendoring, pod resolver, cardinality, licensing |
| [05 — eBPF exporter](05-exporter-ebpf.md) | Submodules, metric rename, configuration traps |
| [06 — HAMi vGPUmonitor](06-hami-vgpumonitor.md) | Integration and deduplication rules |
| [07 — Backend & deployment](07-backend-and-deployment.md) | Repo layout, images, Prometheus, Grafana, RBAC |
| [08 — Validation](08-validation.md) | Phases with exit criteria, load generators, signature mapping |
| [09 — Risks & open questions](09-risks-and-open-questions.md) | R-1…R-6, A-1…A-9, OQ-1…OQ-3, permanent limits, non-goals — **reference** |
| [plans/](plans/) | Per-phase implementation plans: [0 backend](plans/2026-08-09-phase-0-backend.md) · [1 DCGM](plans/2026-08-09-phase-1-dcgm.md) · [2 NVML](plans/2026-08-09-phase-2-nvml.md) · [3 eBPF](plans/2026-08-09-phase-3-ebpf.md) · [4 MIG](plans/2026-08-09-phase-4-mig.md) · [5 production](plans/2026-08-09-phase-5-production.md) |
