# Production rollout

Everything here is validated on the build cluster and parameterised for a production one. It is **not** a copy
of `deploy/a30-node/`: that directory installs a Prometheus, this one assumes production already has
kube-prometheus-stack and Grafana and adds to them.

## Before you start

Three things differ from the build cluster and each changes what you will see.

| | Build cluster | Production |
|---|---|---|
| Prometheus | Installed by us | **Already exists** — do not install a second |
| GPU sharing | DRA only | HAMi classic device-plugin, so entitlement arrives as a **pod annotation**, not a ResourceClaim |
| vGPUmonitor | Absent | **Present** — the fourth source |
| GPUs | A30 (Ampere), MIG capable | TITAN RTX (Turing) — **MIG impossible**, and several profiling fields do not exist |

Turing matters: the `1g.6gb`-style MIG panels will stay empty, and DCGM profiling fields gated on Ampere are
unavailable. That is what the support matrix reports, and it is not a fault.

## Substitutions

Every one of these appears literally in the manifests and must be replaced:

| Token | Replace with |
|---|---|
| `REPLACE_WITH_PULL_SECRET` | An image-pull secret in `gpu-monitoring` for the registry holding the images |
| `REPLACE_WITH_HAMI_NAMESPACE` | The namespace HAMi's device-plugin runs in |
| `REPLACE_WITH_NODE_NAME` (storage manifest) | The node the Prometheus PV is pinned to |
| `ghcr.io/loiht2/...` | Your registry, if not GHCR |

Images are built by CI from the repository root. **CI cannot build the eBPF image until the two
`rename-gpu-metrics-to-ebpf` submodule branches are pushed** — a fresh `checkout --recurse-submodules` cannot
resolve pointers that exist only on a laptop.

## Order

Numbered by dependency. Apply in order and verify each before the next.

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f 10-rbac-nvml-exporter.yaml
kubectl apply -f 30-dcgm-counters.yaml        # then patch the ClusterPolicy, see below
kubectl apply -f 40-nvml-exporter.yaml        # after substituting the image and pull secret
kubectl apply -f 40-ebpf-exporter.yaml
kubectl apply -f 50-servicemonitor-*.yaml 55-servicemonitor-vgpumonitor.yaml
kubectl apply -f 60-prometheusrule-metric-support.yaml
```

The DCGM field list is delivered through the GPU Operator, not by editing its DaemonSet:

```bash
kubectl patch clusterpolicies.nvidia.com <name> --type merge \
  -p '{"spec":{"dcgmExporter":{"config":{"name":"dcgm-custom-counters"}}}}'
```

## The five things that bite

Each of these was hit for real on the build cluster.

1. **An unknown DCGM field is fatal, not skipped.** One bad line and the exporter serves **nothing** — losing
   every field that worked a minute earlier, while the scrape still returns 200. Diff `# HELP` names before
   and after, and treat a drop to zero as the failure to look for. `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` is
   the known-fatal one.
2. **`ruleSelector` and `serviceMonitorSelector` must match our label.** A nil selector selects *nothing*, so
   objects apply cleanly and are silently never evaluated. Production's existing Prometheus has its own
   selectors — check what they match and label ours to suit, or add a second selector.
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

Per-pod eBPF queries must aggregate by **`k8s_namespace_name`** and **`k8s_pod_name`**. Using `namespace`/`pod`
does not error — it returns a plausible number attributed to the agent's own pod.

## Rollback

Nothing here mutates an existing object except the `ClusterPolicy` patch, so rollback is deletion plus
restoring the previous `dcgmExporter.config`. Record it first:

```bash
kubectl get clusterpolicies.nvidia.com <name> -o jsonpath='{.spec.dcgmExporter.config}' > dcgm-config-before.json
```
