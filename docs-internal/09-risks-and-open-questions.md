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

#### R-DCGM-FIELDS — one unknown field silently drops every other field

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

## R-1 — Renaming a label breaks alert rules permanently

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
