# Installing on a new cluster

A start-to-finish install on a cluster that has never run this stack, with a check after each step that
proves it worked. [03 — Deployment](03-deployment.md) is the reference for what each manifest contains; this
is the procedure.

Budget 20–30 minutes, most of it waiting for images to pull.

---

## 0. What must already exist

This system observes GPUs; it does not install GPU support. Four things are assumed:

| Requirement | Check | If it fails |
|---|---|---|
| GPU nodes with a working NVIDIA driver | `kubectl get nodes -l nvidia.com/gpu.present=true` | Install the NVIDIA GPU Operator first. Nothing below will work without it |
| A DCGM exporter already running | `kubectl get pods -A \| grep dcgm` | Comes with the GPU Operator. **This system never deploys one** — see §4 |
| Kernel with BTF and uprobe support | `ls /sys/kernel/btf/vmlinux` on a GPU node | The eBPF exporter cannot attach. Everything else still works; skip it and accept no `ebpf_*` metrics |
| A container runtime using standard pod cgroup paths | — | The NVML exporter resolves processes to pods through `/proc`; a non-standard layout yields device metrics with no per-pod attribution |

The node label above is what both DaemonSets select on. A GPU node missing
`nvidia.com/gpu.present=true` is silently skipped — no error, no pods, no metrics.

**HAMi and MIG are optional.** Without HAMi you lose `GPUDevice*`; without MIG the MIG dashboard stays empty.
Neither blocks the install.

---

## 1. Install the Prometheus Operator CRDs

`deploy/` ships the operator **controller** but not its CRDs, because they cannot be delivered that way — see
§7 for why.

```bash
kubectl apply --server-side -f \
  https://github.com/prometheus-operator/prometheus-operator/releases/download/v0.92.0/stripped-down-crds.yaml
```

Pin the same version as the controller in `deploy/20-prometheus-operator.yaml`; a mismatch is a real source of
confusing reconcile errors. Check that version rather than trusting this page:

```bash
grep 'image: quay.io/prometheus-operator' deploy/20-prometheus-operator.yaml
```

**Verify:**

```bash
kubectl get crd | grep monitoring.coreos.com | wc -l     # expect 10
```

> **Already have kube-prometheus-stack?** Do not install these CRDs a second time, and skip `20-`, `21-` and
> `22-` in the next step. Instead, label this system's ServiceMonitors to match your existing Prometheus's
> `serviceMonitorSelector`, or add a selector that matches `app.kubernetes.io/part-of: gpu-monitoring`. A
> ServiceMonitor that matches no selector applies cleanly and is scraped by nothing.

---

## 2. Apply the stack

```bash
kubectl apply -f deploy/
```

Lexical order is dependency order. `kubectl apply -f <dir>` is **not** recursive, so `deploy/optional/` is
deliberately skipped — see §6.

**Verify** — every pod `Running`, which on a fresh cluster takes a few minutes for image pulls:

```bash
kubectl -n gpu-monitoring get pods -w
```

Expect seven: `prometheus-operator`, `prometheus-gpu-0`, `grafana`, `nvml-exporter` (one per GPU node),
`ebpf-gpu-exporter` (one per GPU node), `advanced-monitoring-api`, `advanced-monitoring-ui`.

If `prometheus-gpu-0` never appears, the operator is not reconciling — almost always the CRD/controller
version mismatch from §1.

---

## 3. Confirm Prometheus is actually scraping

The single most common silent failure. `Prometheus` in `deploy/21-prometheus.yaml` selects ServiceMonitors by
label:

```yaml
serviceMonitorSelector: { matchLabels: { app.kubernetes.io/part-of: gpu-monitoring } }
```

A **nil** selector selects nothing — not everything. If you edited that file, this is where it bites.

```bash
kubectl -n gpu-monitoring port-forward svc/prometheus-operated 9090:9090
# then open http://localhost:9090/targets
```

Expect four jobs `up`: DCGM, NVML, eBPF, HAMi. A job that is missing entirely means its ServiceMonitor was not
selected; a job `down` means the selector matched but the endpoint is unreachable.

---

## 4. Wire the DCGM field list

DCGM ships a short default field list. The extra profiling fields this system's dashboards need are delivered
through the GPU Operator, **not** by editing its DaemonSet — the operator would revert that.

`deploy/30-dcgm-counters.yaml` creates the ConfigMap (41 fields) in the `gpu-operator` namespace. Point the
`ClusterPolicy` at it:

```bash
kubectl get clusterpolicies.nvidia.com -o name        # usually cluster-policy

# record what it was, so this is reversible
kubectl get clusterpolicies.nvidia.com cluster-policy \
  -o jsonpath='{.spec.dcgmExporter.config}' > dcgm-config-before.json

kubectl patch clusterpolicies.nvidia.com cluster-policy --type merge \
  -p '{"spec":{"dcgmExporter":{"config":{"name":"dcgm-custom-counters"}}}}'
```

The operator restarts the DCGM exporter. **This is the only object outside our namespaces that we mutate.**

**Verify** — and take a *before* count first, because the failure mode here is subtractive:

```bash
promq 'count(group by (__name__) ({__name__=~"DCGM_FI_.*"}))'
```

Expect roughly 30+ after the restart. **A drop toward zero is the failure to look for**, not an error message:
one unknown field name makes the exporter serve *nothing at all* while its endpoint still returns HTTP 200.
`DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` is the known-fatal one on Ampere.

---

## 5. Verify end to end

All four sources present:

```bash
promq 'count(group by (__name__) ({__name__=~"DCGM_FI_.*"}))'
promq 'count(group by (__name__) ({__name__=~"nvml_.*"}))'
promq 'count(group by (__name__) ({__name__=~"ebpf_.*"}))'
promq 'count(group by (__name__) ({__name__=~"GPUDevice.*"}))'
```

`ebpf_*` returns **0 until a CUDA workload runs** — the agent reports what workloads ask for, so an idle
cluster produces none. That is correct, not a fault. Prove the path end to end with a load generator:

```bash
kubectl apply -f test/loadgen/gpu-burn.yaml
# wait ~2 minutes, then re-run the ebpf_ query above
kubectl delete -f test/loadgen/gpu-burn.yaml
```

`test/loadgen/*.yaml` pin a specific GPU UUID and, for the DL fixtures, specific MIG instance UUIDs. On a new
cluster **these will not match** — re-derive them before applying:

```bash
kubectl get resourceslices -o json | python3 -c "
import json,sys
for s in json.load(sys.stdin)['items']:
    for d in s['spec'].get('devices',[]):
        a=d.get('attributes') or {}
        print(s['spec'].get('driver'), d['name'], {k:v.get('string') for k,v in a.items() if 'uuid' in k.lower()})"
```

The dashboards:

```bash
kubectl -n gpu-monitoring exec deploy/grafana -- \
  wget -qO- 'http://admin:admin@localhost:3000/api/search?type=dash-db'
```

Expect three. **Zero is a known silent failure** — the dashboard ConfigMaps are mounted `optional: true`, so
Grafana starts healthy with nothing in it. See [06 — Troubleshooting](06-troubleshooting.md).

The advanced monitoring UI, on a NodePort:

```bash
kubectl -n gpu-monitoring get svc advanced-monitoring-ui \
  -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'      # 30802 by default
```

Grafana is `ClusterIP` and has no NodePort; reach it with `kubectl port-forward` as in §3.

---

## 6. Production choices

Two defaults are deliberately set for a build cluster and should be revisited.

**Prometheus storage is `emptyDir`.** Every restart loses history. For anything long-lived, apply the storage
variant *instead of* `21-prometheus.yaml` — never alongside it, since both define `Prometheus/gpu` and the
later apply silently wins:

```bash
sed -i 's/REPLACE_WITH_NODE_NAME/<your-node>/' deploy/optional/prometheus-storage.yaml
kubectl apply -f deploy/optional/prometheus-storage.yaml
```

**Retention is 7 days** and Prometheus is capped at 2Gi. The eBPF exporter produces roughly an order of
magnitude more series than every other source combined, so size against a measurement taken *with it running*,
not before.

**The UI has no authentication and proxies arbitrary PromQL.** Anything that can reach its NodePort can read
every metric in the cluster. Do not expose it on a routable network without putting an authenticating proxy in
front.

---

## 7. Why the CRDs are a separate step

`deploy/` cannot ship them. The bundle is ~1.5 MB and the `Prometheus` CRD alone is ~880 KB, while client-side
`kubectl apply` stores the manifest it applied in an annotation capped at **262144 bytes**:

```
The CustomResourceDefinition "prometheuses.monitoring.coreos.com" is invalid:
metadata.annotations: Too long: may not be more than 262144 bytes
```

`--server-side` has no such limit and is idempotent, so the same command installs and upgrades.

CRDs are also the one part of the stack a teardown must **leave alone**: they are cluster-scoped and shared, so
deleting one deletes every object of that kind — including any `ServiceMonitor` owned by the GPU Operator.

---

## 8. Uninstalling

Deleting the namespace leaves cluster-scoped objects behind:

```bash
kubectl delete ns gpu-monitoring
kubectl delete clusterrole,clusterrolebinding \
  nvml-exporter ebpf-gpu-exporter prometheus-gpu prometheus-operator
kubectl -n gpu-operator delete configmap dcgm-custom-counters
```

Restore the DCGM field list from the file recorded in §4:

```bash
kubectl patch clusterpolicies.nvidia.com cluster-policy --type merge \
  -p "{\"spec\":{\"dcgmExporter\":{\"config\":$(cat dcgm-config-before.json)}}}"
```

Leave the CRDs installed unless you are certain nothing else uses them.
