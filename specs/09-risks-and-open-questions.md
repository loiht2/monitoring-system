# 09 — Risks, open questions and non-goals

The honest register: what is unproven, how this work can damage behaviour that already exists, and what it
deliberately does not do.

**Evidence convention.** Every claim in this specification is one of:

| Tag | Meaning |
|---|---|
| **Verified** | Read directly in source, or observed on a live cluster during design |
| **Documented** | Stated by an upstream project's own documentation or chart |
| **Assumed** | Believed true, no evidence either way — listed in §2 with the test that settles it |

---

## 1. Ways this can damage existing behaviour

These concern the production environment, where a monitoring stack and its consumers already exist. Each is a
silent failure — none produces an error.

### R-HAMI-MIG — HAMi schedules onto a MIG-partitioned card and the workload silently runs on CPU

Observed on HAMi 2.9.0 with GPU 1 partitioned into one `1g.6gb` instance.

HAMi still advertises the partitioned card as a whole GPU (`hami-gpu-1`) and happily allocated it to a
resnet50 training pod. The container saw the parent device, CUDA was unusable on it, and **PyTorch fell back
to CPU rather than failing**. The pod stayed `Running`, printed plausible loss values, and reported ~2.3s per
step — roughly fifty times slower than the same work on a GPU, which is the only visible symptom.

What each source reported, all correctly:

| Source | Reading | Why |
|---|---|---|
| HAMi | 50 cores committed on `hami-gpu-1` | It believes it granted a whole card |
| DCGM | no device-level series at all | A MIG card reports only instance entities |
| DCGM `GPU_I` | `SM_ACTIVE` 0 | The instance really is idle; the work never reached it |
| NVML per-pod | nothing | Per-process collection is deliberately skipped on a MIG parent to avoid double-counting |
| `nvidia-smi` | no compute process, 36 MiB used | The card is genuinely doing nothing |

**The monitoring was right and everything else was wrong.** Four independent sources agreeing on "no GPU
work" while the pod looks healthy is precisely the case this system exists to surface, and none of the usual
signals — pod status, restart count, application logs — would have caught it.

Two consequences:

- **Do not enable MIG on a card HAMi manages** unless HAMi is configured to know about it. Its device
  inventory is built from whole-card discovery.
- A per-pod GPU metric that is *absent* while a pod is `Running` and claims a GPU deserves an alert. It means
  either this, or the resolver is broken; both need a human.

### R-DCGM-FIELDS — one unknown field silently drops every other field

Observed live. `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` is not a known field in the DCGM build shipped by this
GPU Operator. The exporter logs `could not find DCGM field` and then serves **nothing at all** — not the bad
field, not the 23 fields that were working a minute earlier. `/metrics` returns an empty body, the scrape
succeeds, and every dashboard and alert built on DCGM goes quiet without a single error surfacing in
Prometheus.

Two consequences for anyone editing the counters ConfigMap:

- An unknown field is **fatal**, not skipped. An unsupported-but-known field (`DCGM_FI_PROF_PIPE_INT_ACTIVE`
  here) only logs `metric not enabled` and is skipped, which is why the two cases must not be conflated.
- Reconciling the new list against the old one on paper is not enough — that check passed. Only counting the
  fields the exporter actually serves afterwards catches this.

Always diff `# HELP` names before and after, and treat a drop to zero as the expected failure to look for.


### R-1 — Renaming a label breaks alert rules permanently

Alert rules that divide one metric by another **without an explicit `on()` clause** match on the complete label
set. If a relabeling rule renames a label on one metric and not on its divisor, the vector match produces no
result. Prometheus does not error; the expression simply evaluates to empty, and the alert never fires again.

**Mitigation, and it is not negotiable:** every normalization in this system **copies** a label and retains the
original ([01 § 3.2](01-architecture.md), [03 § 3](03-exporter-dcgm.md)). We add labels; we never rename or
remove one.

### R-2 — Idle-GPU reclamation fails silently and permanently

The platform's reclamation queries a specific DCGM metric name filtered by namespace and pod, and reads **only
the first returned series**. Three ways this project could break it:

| Cause | Effect |
|---|---|
| A second exporter emitting the same metric name | The first series is non-deterministic — reclamation can read an idle series for a **busy** pod and terminate it |
| The metric name disappearing from the field list | Reclamation returns nothing and quietly stops reclaiming, forever |
| Pod attribution lost from that metric | The selector matches nothing; same outcome |

**Mitigations:** the hard invariant forbids the first. The field-list rule "never remove a field"
([03 § 1](03-exporter-dcgm.md)) forbids the second. The third has **no detection in this project's scope** —
a metric present but unattributed is indistinguishable from a cluster where nothing is idle, so Phase 5 must
verify pod attribution on that metric explicitly (A-7) rather than rely on noticing it later.

### R-3 — Aggregating consumers double-count on duplicate names

The platform's admin overview **sums** a DCGM framebuffer metric across every returned series. A duplicate
metric name doubles reported cluster VRAM usage with no error anywhere. Same root cause as R-2, same
mitigation: the hard invariant.

### R-4 — Dashboard and datasource collisions

Where an environment already runs Grafana: several components may write dashboard ConfigMaps, and a name or
UID collision means one silently overwrites another on every reconcile. Provisioning scripts may also delete
datasources they do not recognize. **Mitigation:** distinct ConfigMap names, never reuse an existing dashboard
UID, and inspect existing provisioning before adding ours.

### R-5 — Replacing the legacy eBPF agent destroys unrecorded configuration

A hand-built image at a tag with no reproducible source pin is a configuration artifact that exists nowhere
else. **Mitigation:** snapshot release values, rendered manifest, DaemonSet and referenced ConfigMaps *before*
removal, and store the snapshot outside the repository ([05 § 3](05-exporter-ebpf.md)).

### R-6 — The monitoring stack destabilizes the node it monitors

Where the scheduler's memory-request accounting sits far below actual node usage, a Prometheus with a modest
request is admitted and then contends for memory that was never free. **Mitigation:** request expected usage
rather than the schedulable minimum; measure real consumption after Phase 1 and revise before the eBPF agent's
histogram families land ([07 § 3.3](07-backend-and-deployment.md)).

### R-7 — The eBPF agent's `cudaMemcpy` probe does not fire, so copy volume reads as zero

**Verified** by the evaluation suite ([14 § 7](14-metric-evaluation.md)).
`ebpf_cuda_memory_copies_bytes_total_sum` produced no sample during the `gpu0/memcpy-h2d` phase, whose
exerciser logged `OK iterations=21142` and exited `0` — 21142 successful `cudaMemcpy` calls in a 90s window.

This is an **agent gap, not a workload gap**. Other eBPF families from that same pod and window — memset,
alloc, free, kernel launch, sync — all appeared, so the agent was attached and instrumenting the process. The
memcpy probe specifically did not fire for this binary.

Consequences: any panel or alert reading host↔device copy volume from the eBPF agent silently reports zero
traffic for workloads that are copying. The metric stays UNVERIFIED — no sample, and no support verdict to
explain it — which is the exact state the evaluation exists to surface.

**Mitigation:** treat eBPF copy volume as unproven until the probe is fixed; use `DCGM_FI_PROF_PCIE_TX/RX_BYTES`
(OBSERVED, device scope) for copy bandwidth in the meantime. Re-run the `memcpy-h2d` phase after any agent
change and require the metric to move out of UNVERIFIED.

### R-8 — The eBPF agent barely labels its series with a device, so the UI must join to get one

**Verified** against the live cluster. Over 24h on `ebpf_cuda_kernel_launch_calls_total`, **43 pods produce
series and the agent labels 3 of them with a `gpu_uuid`**. It emits no MIG discriminator at all — no
`GPU_I_ID`, no `mig_uuid`. Filtering the eBPF panels on the agent's own label would therefore hide ~93% of
the data whenever a specific GPU is selected, silently; `All` appears to work only because `.*` also matches
an absent label.

The identity exists elsewhere: the NVML exporter's `gpu_alloc_device_pod_info` maps every workload pod to the
device it was granted and carries `mig_uuid` as well as `gpu_uuid` — 43/43 resolved, 17 on an instance. The
UI therefore resolves a device selection to the pods that held that device and substitutes them into `$pod`
([13 § 11.1](13-ui-visual-design.md)). The lookup is windowed (`last_over_time(...[range])`), because an
instant query returns 0 series once the pods have finished.

Same class as R-7: both are eBPF-Lens gaps found by the evaluation rather than by the agent's own reporting.

**Mitigation:** the join is a workaround, not a design. If the agent starts labelling its series with
`gpu_uuid` and a MIG identifier, **remove** the join rather than duplicate it — two sources of device
attribution that can disagree is worse than one that is missing.

---

## 2. Assumptions to be tested, not trusted

| # | Assumption | Test that settles it | If false |
|---|---|---|---|
| **A-1** | Adding profiling fields does not degrade fields already collected | Phase 1's before/after value comparison under identical load | Split the field list across collection intervals; do not drop catalog metrics |
| **A-2** | Per-process utilization sampling is available and accurate on the fleet's architecture | Phase 2's co-tenant discrimination test | **The design's central premise fails.** Escalate rather than work around |
| **A-3** | The cgroup layout is parseable for the fleet's container runtime | Phase 2, with a deliberate `hostPID`-removed control | Extend the parser; the resolver already degrades to unattributed rather than failing |
| **A-4** | The DRA claim schema matches what the inherited parser expects | Phase 2, with a real claim-holding pod | The parser's tolerant failure yields no entitlement rows — visible immediately |
| **A-5** | eBPF cardinality is within an order of magnitude of the estimate | Phase 3 measurement | Reduce label dimensions, not families ([05 § 6](05-exporter-ebpf.md)) |
| **A-6** | Enabling MIG on one device leaves other devices untouched | Phase 4, with whole-device workloads running throughout | Schedule MIG validation in a window where the fleet can be drained |
| **A-7** | Existing consumers of DCGM metrics are unaffected by added fields and added labels | Phase 5, explicitly exercised — not inferred | Revert the relabeling; added fields are safe, added labels may not be |
| **A-8** | Per-instance `GR_ENGINE_ACTIVE` is normalized to the **instance**, not to the whole GPU | Phase 4: saturate one small instance and read the value. 1.0 means instance-normalized; a small fraction means device-normalized | Normalize in the query using the SM count derived from `GPU_I_PROFILE` (MIG catalog row 2). Sources disagree, so this must be measured, not assumed |
| **A-9** | dcgm-exporter emits `GPU_I_ID` and `GPU_I_PROFILE` labels on this deployment | Phase 4, first MIG-enabled scrape | MIG attribution has no join key; escalate — every MIG exit criterion depends on it |

---

## 3. Open questions

### OQ-1 — Where does the pod-to-user mapping come from?

Attributing GPU usage to a *platform user* rather than a pod requires pod metadata that GPU metrics do not
carry. It exists as pod labels, and the conventional source for joining it is a cluster-state metrics exporter
that this design excludes from the validation environment (nothing there produces such pods).

**Recommendation:** treat it as a production-environment feature. Decide it now so no panel is designed around
it. Two rules follow:

1. No phase exit criterion may depend on a user or workload-identity label.
2. Any panel intended to carry the join must be written to degrade to **correct-but-anonymous**, not to
   "No data" ([07 § 4.1](07-backend-and-deployment.md)).

### OQ-2 — Retention target once history matters

Early phases need hours to days. The first thing that makes long-window aggregation worth keeping is the eBPF
histogram set. **Recommendation:** defer the decision to Phase 3, when real cardinality is known; do not block
Phase 1 on it, and do not put the TSDB on a network filesystem at any point.

### OQ-3 — Does anything depend on the legacy eBPF agent's non-GPU metrics?

Must be answered by the owner of the running deployment before Phase 3 removes it. Where nothing scrapes it,
the answer is free.

---

## 4. Permanent limits

Not risks — properties. Listed so no dashboard promises them.

| Limit | Why |
|---|---|
| Occupancy and pipe activity cannot be attributed to a pod on a shared device | Hardware performance counters are sampled per device, not per context. Exclusive assignment (whole device, or a MIG instance) is the only exception |
| Per-process utilization is unavailable under MIG | The NVML sampling call does not support MIG devices. Per-process **memory** survives; attribution shifts to entitlement, which is exact under exclusive assignment |
| The eBPF agent cannot report anything GPU-side | Uprobes observe the API call, not its execution |
| Metrics gated by architecture tier cannot be enabled by configuration | [02 § 1](02-metric-catalog.md) |
| Device health metrics are not workload properties | Attributing an ECC error to a pod would be meaningless |
| In-container hardware-counter profiling requires elevated privileges | Not a path this system takes; DCGM collects at the node level |

---

## 5. Non-goals

- **No changes to the platform's reclamation, quota logic or admin UI.** This project adds metric names and
  adds labels. It removes nothing and redefines nothing.
- **No downstream collector.** Prometheus is the boundary; what consumes it is a separate project.
- **No alerting.** No Alertmanager, no `PrometheusRule` objects. The deliverable is metrics in Prometheus and
  dashboards in Grafana; routing and alert policy are a separate concern.
- **No node-exporter, cluster-state metrics or log aggregation** in the validation environment.
- **No custom DCGM exporter build.** Configuration only, forever.
- **No runtime dependency on the platform's control plane.** Allocation parsers are vendored, never called
  over the network — monitoring must not depend on the thing it monitors.
- **No per-PID series.**
- **No multi-node behaviour claims** validated on a single-node cluster.

### R-9 — A MIG repartition leaves the container toolkit stale, so exporters see only some instances

**Verified** by repartitioning a card from one `1g.6gb` instance to `2g.12gb` + 2 × `1g.6gb`.

The host saw all three instances immediately — `nvidia-smi -L` listed them and DCGM reported three entities
with the right profiles. **The NVML exporter saw two.** It logged

```
WARN nvml: skipping MIG instance handle index=1 instance=2 error="Not Found"
```

and emitted `mig_uuid` for the two `1g.6gb` instances while the `2g.12gb` was simply absent. Restarting the
exporter did not help; it reproduced exactly.

The enumeration code is not at fault — it follows the documented NVML pattern (`GetMaxMigDeviceCount`, then
iterate and skip `NOT_FOUND`). Access to a MIG instance is gated by a `/dev/nvidia-caps/nvidia-capN` node
per instance, and those are injected into the container by the NVIDIA container toolkit. The injected set
was generated under the **previous** topology, so two of the three new instances happened to be reachable
and one was not.

**Restarting `ds/nvidia-container-toolkit-daemonset`, then the exporter, produced all three.**

Why this matters beyond the inconvenience: the failure is **silent and partial**. Nothing errors, the
dashboards render, and one instance is quietly missing from the MIG dashboard and from the eBPF↔device
correlation that depends on `mig_uuid` ([13 § 11.2](13-ui-visual-design.md)). It would be easy to read the
resulting gap as "that instance was idle".

**After any MIG repartition, restart in this order and verify the count**, rather than assuming:

```bash
kubectl -n gpu-operator rollout restart ds/nvidia-container-toolkit-daemonset
kubectl -n gpu-monitoring rollout restart ds/nvml-exporter
kubectl -n gpu-operator  rollout restart ds/nvidia-dcgm-exporter
# then confirm one bridge row per instance:
curl -s -G .../api/query --data-urlencode 'q=nvml_gpu_memory_total_bytes{mig_uuid!=""}'
```

A residual `instance=3 error="Not Found"` in the log is expected and harmless: the loop runs to
`GetMaxMigDeviceCount()` and the last slots are genuinely empty.

#### R-9.1 — The DRA driver is stale in the same way, and is a separate restart

The container toolkit is not the only layer that enumerates once. `nvidia-dra-driver-gpu`'s **ResourceSlice
is written at plugin startup and never resynced.** Two hours after the repartition it still advertised the
*destroyed* instance and nothing else:

```
gpu-1-mig-1g6gb-14-0   uuid=MIG-<old-instance>   ← destroyed by the repartition
gpu-0                  uuid=GPU-<card-0>
```

A `ResourceClaim` pinned to a **new** instance therefore sat `Pending` forever with no allocation events —
**no MIG workload could be scheduled at all**, while every dashboard looked healthy because DCGM and NVML
were by then reporting all three instances correctly. Falling back to `NVIDIA_VISIBLE_DEVICES` failed too:
CDI's `management.nvidia.com-gpu.yaml` contains only the device `all`, so pinning by MIG UUID gives
`unresolvable CDI devices`.

**The plugin lives in its own namespace, `nvidia-dra-driver-gpu`, not `gpu-operator`.** A restart aimed at
`gpu-operator` matches nothing and reports nothing — it looks like it worked. Restarting it in the correct
namespace re-advertised all four devices with the right UUIDs and profiles.

So the post-repartition sequence is **three** restarts in different namespaces, and the last one is the
easiest to miss:

```bash
kubectl -n gpu-operator          rollout restart ds/nvidia-container-toolkit-daemonset
kubectl -n nvidia-dra-driver-gpu rollout restart ds/nvidia-dra-driver-gpu-kubelet-plugin
kubectl -n gpu-monitoring        rollout restart ds/nvml-exporter
kubectl -n gpu-operator          rollout restart ds/nvidia-dcgm-exporter
# then verify, do not assume:
kubectl get resourceslice -o json | grep -c uuid          # one entry per current device
curl -s -G .../api/query --data-urlencode 'q=nvml_gpu_memory_total_bytes{mig_uuid!=""}'
```

**Verify the ResourceSlice explicitly.** Observability recovering is not evidence that scheduling has: the
two failures are in different layers and one heals without the other.
