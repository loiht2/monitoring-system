# 04 — NVML exporter

**Deliverable: a new Go DaemonSet.** The load-bearing component: it is the only source returning a hardware
counter and a host PID in the same call, so on a shared device it is the only thing that can say *which* pod is
consuming it. Metric list in [02 § 3](02-metric-catalog.md).

---

## 1. Dependencies

| Dependency | Provides |
|---|---|
| [NVIDIA/go-nvml](https://github.com/NVIDIA/go-nvml) | The NVML binding. Generated from the driver headers; loads the driver library at runtime |
| `k8s.io/client-go` | Pod informer and the `resource.k8s.io` typed clients |
| `prometheus/client_golang` | Registry and exposition |

Go over Python (D-6) for four reasons, each checkable rather than stylistic:

- **One toolchain with the eBPF exporter**, which is already Go against the same `client-go` major version.
- **The binding absorbs driver API churn.** `go-nvml` exposes both `DeviceGetCurrentClocksEventReasons` and
  the older `DeviceGetCurrentClocksThrottleReasons`, so catalog row 33 needs no hand-written version shim.
- **Informers instead of polling.** The pod cache is a watch, not a periodic full list.
- **A static binary on a distroless base**, with no interpreter or package manager in the image.

### 1.1 ABI coupling has not gone away

`go-nvml` is generated against a specific NVML header version. It is more forgiving than a Python binding
because missing symbols surface as a resolution failure at call time rather than an import crash, but the
property is the same: **a driver upgrade requires re-validating this exporter.** Pin the module version in
`go.mod` and record the driver version the pin was validated against.

### 1.2 Allocation parsing (D-13)

The ML Platform's control plane already parses all three allocation mechanisms against schemas its docstrings
record as confirmed on a live cluster. Those parsers are Python, so they are **reimplemented in Go with the
original cited as the schema reference** — the language differs, the contract does not.

| Behaviour to preserve | Why it is not obvious |
|---|---|
| The HAMi annotation key is matched by **suffix**, not by an exact prefix | Covers both the classic prefix and the DRA fork's project-scoped one |
| The device UUID is the first UUID-shaped token of that annotation's first entry | The format has drifted across HAMi versions; parsing must be tolerant and never fail hard |
| DRA identity comes from `ResourceClaim.status.allocation.devices.results[].device` | Resolved to a UUID through the matching `ResourceSlice` device attributes |
| Any missing level yields no entitlement row, never an error | A pending or unreadable claim is normal, not a fault |

**One deliberate divergence.** The upstream reader sums `consumed_capacity` and **discards
`results[].device`**, because the control plane only ever needed "how much", never "which one". That
identifier is this system's join key, so our implementation keeps it — and does not carry the capacity
summing, which is not a catalog requirement.

Record the upstream repository, file and commit in a comment at the top of the file that implements this.

---

## 2. Packages

| Package | Responsibility |
|---|---|
| `cmd/exporter` | Flag/env parsing, wiring, HTTP server |
| `internal/cgroup` | `/proc/<pid>/cgroup` → pod UID and container ID |
| `internal/podcache` | Node-scoped pod informer; pod UID → namespace/pod, container ID → container name |
| `internal/collector` | The three collectors: device, per-process, allocation |
| `internal/alloc` | Allocation parsing (§1.2) |

The NVML and Kubernetes surfaces are reached through small interfaces defined at the point of use, so every
collector is testable against fakes with no GPU and no cluster.

**We do not reimplement a general-purpose NVML wrapper.** The exporter needs nine catalog rows; anything
beyond them is scope that has to be maintained.

---

## 3. The pod resolver

Mechanism and its rules are specified in [01 § 2.1](01-architecture.md). Implementation requirements:

- **`hostPID: true`** — without it the exporter observes a private PID namespace, every `/proc` lookup misses,
  and it emits device metrics normally while silently producing nothing per pod. This is the most common way
  to deploy this component broken.
- `/proc` mounted from the host, with the host PID namespace.
- **Read-only Kubernetes access**: `get`/`list`/`watch` on pods (field-selected to this node),
  `resourceclaims` and `resourceslices`. Nothing else, no writes.

### 3.1 Degradation rules

| Situation | Behaviour |
|---|---|
| Unrecognized cgroup format | Emit with empty `namespace`/`pod`; never fail, never drop the measurement |
| Pod UID absent from the cache (deletion race) | Same |
| Process exits mid-scrape | Skip silently — normal |
| Device reports MIG enabled | Skip per-process utilization; per-process memory still applies, read from the **instance** handle |
| NVML returns "not supported" | **Do not emit the metric.** Never substitute zero — a zero is indistinguishable from a measurement and corrupts every average, rate and alert over the series ([02 § 5.2](02-metric-catalog.md)) |

### 3.2 Cardinality

Values are summed per pod; host PID never becomes a label. Pods with no live process are **dropped, not
zeroed**. Per-scrape state is rebuilt rather than accumulated, so nothing grows across the process lifetime.

Steady state: (devices × ~12 device metrics) + (GPU-holding pods × 3 process metrics) + (entitlements × 1) —
negligible beside the eBPF exporter's histograms ([05 § 5](05-exporter-ebpf.md)).

---

## 4. Deployment

DaemonSet on GPU nodes, selected by the standard GPU-present node label.

| Property | Value | Reason |
|---|---|---|
| `hostPID` | `true` | Mandatory |
| GPU resource request | **none** | Reads host NVML through the driver the container runtime mounts. A request would consume an allocatable GPU — and on a DRA-only fleet where device-plugin capacity is zero, the pod would never schedule at all |
| Port | Must not collide with the DCGM exporter's or the eBPF agent's | Both conventionally use the same well-known port, and the eBPF agent's `hostNetwork` makes its container port a host port |

---

## 5. Phase 2 exit criteria

> **Two pods sharing one physical device, granted different compute shares, must be distinguishable by
> `nvml_process_sm_utilization_ratio` in proportion to their shares.**

**Result: attribution passes, proportionality does not — and the exporter is not at fault.** Measured on one
A30 with two HAMi co-tenants granted `cores` 60 and 20 and memory 8000Mi and 4000Mi:

| | Granted ratio | Measured ratio |
|---|---|---|
| `nvml_process_gpu_memory_bytes` | 2.00 | **2.009** |
| `nvml_process_sm_utilization_ratio` | 3.00 | **0.82 - 1.04**, order flips between scrapes |

Memory tracks the grant to three digits, which is what establishes the measurement is sound. The SM split sits
at roughly 50/50 regardless of the 3:1 core grant, so **HAMi is not enforcing `cores` proportionally here.**

The premise this criterion exists to test — that co-tenants on a shared card can be told apart at all — holds.
What fails is the assumption that HAMi's core grant translates into SM share, and finding exactly that kind of
divergence between what a scheduler promises and what the silicon does is why this system was built
([02 § 6](02-metric-catalog.md) records it as an intended comparison). Do not "fix" the exporter against it.

| Check | Expected |
|---|---|
| Idle entitlement | `gpu_alloc_device_pod_info` present, `nvml_process_*` absent |
| Pod deletion | Process series gone within one scrape interval |
| Exporter restart | Series resume, no duplicates or stale labels |
| MIG device | `nvml_process_sm_utilization_ratio` absent; `nvml_process_gpu_memory_bytes` present |
| Unsupported field | Family absent, not zero |
| `hostPID` removed | Per-pod metrics disappear entirely — proves the resolver is doing the work |

Failure of the first criterion means per-pod hardware attribution has failed and the design's central premise
is wrong (A-2). Escalate rather than work around.
