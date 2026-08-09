# 03 — DCGM exporter

**Deliverable: configuration and a ServiceMonitor. No image, no fork, no second deployment.**

A second DCGM exporter would emit duplicate series for every `DCGM_FI_*` name, violating the hard invariant
with a plausible path to terminating a busy workload ([00 § 2](00-decisions.md); [09 — R-2](09-risks-and-open-questions.md)).
The existing exporter is therefore extended in place.

| Deployment shape | Where the field list lives | How to extend |
|---|---|---|
| Managed by the NVIDIA GPU Operator | Baked into the image | Create a counters ConfigMap; set `ClusterPolicy.spec.dcgmExporter.config.name` |
| Standalone DaemonSet | A mounted ConfigMap | Edit that ConfigMap |
| Not deployed at all | — | Deploy the vendor chart unmodified, then configure. **Never build a custom image** |

---

## 1. The field list

CSV, three columns — field name, Prometheus type, help string:

```csv
DCGM_FI_DEV_GPU_UTIL,      gauge, GPU utilization (%).
DCGM_FI_PROF_SM_ACTIVE,    gauge, Ratio of cycles an SM has at least one warp assigned.
DCGM_FI_PROF_SM_OCCUPANCY, gauge, Ratio of resident warps to the theoretical maximum.
```

The target list is the union of:

1. **Everything already collected — never remove a field.** Existing dashboards, alert rules and the
   platform's reclamation depend on names already present.
2. Every field in [02 § 2](02-metric-catalog.md) whose architecture tier the fleet satisfies.

Fields whose tier is not satisfied are **omitted**, not included and left blank: an included unsupported field
costs a collection attempt per interval and produces an empty metric family, which reads as a broken exporter
rather than as unsupported hardware.

### 1.1 Profiling multiplexing

DCGM's profiling engine has finite concurrent counter groups. Requesting more `PROF_*` fields than fit makes
DCGM **time-multiplex** them — each is sampled for a fraction of the interval and scaled. There is no error;
fields that were previously accurate simply get noisier.

**Field presence is therefore not a valid test.** The phase exit criterion is a *value* comparison: identical
repeatable load before and after the change, confirming every previously collected field reports
indistinguishable values ([08 § Phase 1](08-validation.md)).

If multiplexing degrades accuracy unacceptably, split the field list across collection intervals — collect
occupancy and pipe activity less often than the always-on health group. Do not drop catalog metrics.

Related: DCGM's profiling context can conflict with another profiler attached to the same device. Whichever
attaches second fails. Do not run interactive profiling on a node during validation.

---

## 2. Applying the configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-custom-counters
  namespace: <gpu-operator namespace>
data:
  counters.csv: |
    <field list>
---
# patch clusterpolicies.nvidia.com/<name>
spec:
  dcgmExporter:
    config:
      name: dcgm-custom-counters
```

- **Use the fully qualified CRD name.** `ClusterPolicy` is a kind used by both the NVIDIA GPU Operator
  (`clusterpolicies.nvidia.com`) and Kyverno (`clusterpolicies.kyverno.io`); a bare `kubectl get clusterpolicy`
  may resolve to the wrong one.
- The operator restarts the exporter on this change — expect a metrics gap during rollout.

---

## 3. Scrape configuration

We ship **our own ServiceMonitor** rather than enabling the vendor's, so the relabeling rules are versioned and
reviewed with the rest of this project instead of living in a CR the operator may rewrite.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gpu-dcgm
  namespace: <monitoring namespace>
spec:
  namespaceSelector:
    matchNames: [<dcgm-exporter service namespace>]
  selector:
    matchLabels: {<exporter service labels>}
  endpoints:
    - port: <metrics port name>
      interval: 15s
      honorLabels: true
      metricRelabelings:
        - sourceLabels: [UUID]
          targetLabel: gpu_uuid
          action: replace          # copy — source label is retained
```

**`metricRelabelings`, not `relabelings`.** Target relabeling acts on labels discovered from Kubernetes
(`__meta_*` and target labels). `UUID`, `Hostname` and the MIG entity labels are labels on the *exposed
metrics*, so they exist only at metric-relabel time. A rule placed under `relabelings` matches nothing and
silently produces no `gpu_uuid` label at all.

| Rule | Action |
|---|---|
| `UUID` → `gpu_uuid` | Copy |
| `Hostname` → `node` | Copy |
| MIG instance identifier → `mig_uuid` | Copy, where MIG entity labels are present |

All three follow the add-never-rename rule in [01 § 3.2](01-architecture.md). `honorLabels: true` prevents
Prometheus overwriting identity labels the exporter set deliberately.

---

## 4. Delivered / not delivered

**Delivered:** the complete hardware-truth surface at device or MIG-instance granularity, joined to pods
through `gpu_alloc_device_pod_info`.

**Not delivered:** any per-process number. On a shared device every value here is the whole device's, and the
join reports every co-tenant against it. Separating them is [04](04-exporter-nvml.md)'s job; no amount of DCGM
configuration substitutes for it.

**Never deliverable:** occupancy or pipe activity attributed to a pod on a shared device — hardware counters
are sampled per device, not per context. Exclusive assignment (whole device, or a MIG instance) is the only
exception, and there entitlement makes it exact.
