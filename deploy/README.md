# Deploying the stack

Installs the Prometheus Operator controller, a Prometheus, Grafana with the three dashboards, the NVML and
eBPF exporters, the DCGM field configuration, the ServiceMonitors, the support-signal rules, and the
advanced monitoring UI.

## Prerequisite: the Prometheus Operator CRDs

`deploy/` ships the operator **controller** but not its CRDs, so install them first — pinned to the same
version as the controller image (`v0.92.0`):

```bash
kubectl apply --server-side -f \
  https://github.com/prometheus-operator/prometheus-operator/releases/download/v0.92.0/stripped-down-crds.yaml
```

`--server-side` is required, not a preference. The bundle is ~1.5 MB and the `Prometheus` CRD alone is
~880 KB, while client-side `kubectl apply` stores the manifest in an annotation capped at 262144 bytes —
it fails with `metadata.annotations: Too long`. Server-side apply has no such limit and is idempotent, so
the same command installs and upgrades.

Without the CRDs, `Prometheus`, `ServiceMonitor` and `PrometheusRule` are unknown kinds and those manifests
are rejected.

> **CRDs alone are not enough.** They are often present without the controller that reconciles them. In that
> state a `ServiceMonitor` applies successfully and is scraped by nothing. `deploy/20-prometheus-operator.yaml`
> supplies the controller; confirm its pod is running before treating any scrape configuration as effective.

## Applying

```bash
kubectl apply -f deploy/
```

Lexical order is dependency order, and `kubectl apply -f <dir>` is **not** recursive, so
`deploy/optional/` is deliberately skipped.

### `optional/prometheus-storage.yaml`

Applied **instead of** `21-prometheus.yaml`, never alongside it: both define `Prometheus/gpu`, and
the operator reconciles one object of that name. Applying the directory and then this file gives
Prometheus a persistent volume; applying this file as part of the directory would silently replace
the working Prometheus with one bound to a local PV that may not exist.

Use it where history must survive a pod restart. Without it the operator falls back to `emptyDir`,
which is acceptable while building out and is not acceptable in production. Substitute
`REPLACE_WITH_NODE_NAME` with the node the PV is pinned to.

## DCGM field configuration

`30-dcgm-counters.yaml` writes the field list as a ConfigMap in the GPU Operator's namespace. Delivering it
is a `ClusterPolicy` change, not an edit to the DCGM DaemonSet:

```bash
kubectl patch clusterpolicies.nvidia.com <name> --type merge \
  -p '{"spec":{"dcgmExporter":{"config":{"name":"dcgm-custom-counters"}}}}'
```

The GPU Operator then restarts the exporter. This is the one object outside our namespaces that we mutate.

## Deploying to a different cluster

What you see depends on the hardware and on how GPUs are shared. On a cluster that already runs
kube-prometheus-stack, skip `20-`/`21-`/`22-` and label our ServiceMonitors to match the existing
Prometheus's selectors instead.

| | Ampere, MIG capable, DRA | Turing, HAMi classic device-plugin |
|---|---|---|
| MIG panels | Populated | **Empty — MIG is impossible on Turing** |
| DCGM profiling fields gated on Ampere | Present | Unavailable |
| Entitlement arrives as | A ResourceClaim | A **pod annotation** |
| vGPUmonitor | Absent | **Present** — the fourth source |

Empty MIG panels on Turing are what the support matrix reports, not a fault.

## The five things that bite

Each of these was hit for real on the build cluster.

1. **An unknown DCGM field is fatal, not skipped.** One bad line and the exporter serves **nothing** — losing
   every field that worked a minute earlier, while the scrape still returns 200. Diff `# HELP` names before
   and after, and treat a drop to zero as the failure to look for. `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` is
   the known-fatal one.
2. **`ruleSelector` and `serviceMonitorSelector` must match our label.** A nil selector selects *nothing*, so
   objects apply cleanly and are silently never evaluated. A pre-existing Prometheus has its own selectors —
   check what they match and label ours to suit, or add a second selector.
3. **The eBPF agent needs `ebpf.instrument_cuda: 'on'`.** Without it the agent starts, serves a healthy
   endpoint, and produces no CUDA metric at all. Quoted, because YAML reads bare `on` as boolean.
4. **`discovery.instrument` is a glob, not a regex.** `.` matches one-character namespaces and instruments
   nothing.
5. **512Mi OOM-kills the eBPF agent in under 20 seconds** when it instruments every namespace. It dies before
   attaching a uprobe, so the symptom is silence, not a crash. 2Gi is what worked.

## Verification

```bash
# every source present
promq 'count(group by (__name__) ({__name__=~"DCGM_FI_.*"}))'
promq 'count(group by (__name__) ({__name__=~"nvml_.*"}))'
promq 'count(group by (__name__) ({__name__=~"ebpf_cuda_.*"}))'
promq 'count(group by (__name__) ({__name__=~"hami_.*"}))'

# the hard invariant: no metric name from two exporters
promq 'count by (__name__) (group by (__name__, job) ({__name__=~"nvml_.*|ebpf_.*|hami_.*"})) > 1'

# nothing that already worked changed (A-7) — run BEFORE and compare
promq 'count(group by (__name__) ({__name__=~"DCGM_FI_.*"}))'
```

`gpu_alloc_*` is absent when no pod holds a GPU. That is correct — the metric describes an allocation, so
nothing to report means no series, never a zero.

Per-pod eBPF queries must aggregate by **`k8s_namespace_name`** and **`k8s_pod_name`**. Using `namespace`/`pod`
does not error — it returns a plausible number attributed to the agent's own pod.

## Rollback

Nothing here mutates an existing object except the `ClusterPolicy` patch, so rollback is deletion plus
restoring the previous `dcgmExporter.config`. Record it first:

```bash
kubectl get clusterpolicies.nvidia.com <name> -o jsonpath='{.spec.dcgmExporter.config}' > dcgm-config-before.json
```

Deleting the namespace leaves the cluster-scoped RBAC behind; remove it explicitly:

```bash
kubectl delete ns gpu-monitoring
kubectl delete clusterrole,clusterrolebinding \
  nvml-exporter ebpf-gpu-exporter prometheus-gpu prometheus-operator
kubectl -n gpu-operator delete configmap dcgm-custom-counters
```

Leave the CRDs installed. They are cluster-scoped and shared — deleting a CRD deletes every object of that
kind, including any `ServiceMonitor` owned by the GPU Operator.
