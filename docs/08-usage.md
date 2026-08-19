# Using the system

Day-to-day operation: where to look, how to read what you find, and how to tell "nothing happened" from
"something is broken". [04 — Querying](04-querying.md) has the worked PromQL; this is about the surfaces.

---

## 1. The two surfaces

Both read the same Prometheus, so they cannot disagree about a number.

| | Advanced monitoring UI | Grafana |
|---|---|---|
| Reach it | NodePort, `30802` by default | `ClusterIP` — needs a port-forward |
| Use it for | Everyday reading. It distinguishes *unsupported* from *empty* | Editing panels, ad-hoc PromQL, anything the UI does not expose |
| Panels | Generated from the same dashboard JSON | The source of truth for panels |

```bash
# UI — find the port rather than assuming it
kubectl -n gpu-monitoring get svc advanced-monitoring-ui -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'

# Grafana
kubectl -n gpu-monitoring port-forward svc/grafana 3000:3000
```

Grafana has anonymous viewer access; log in as `admin`/`admin` to edit.

**The UI has no authentication and proxies arbitrary PromQL.** Treat its port as privileged.

---

## 2. Choosing a dashboard

Three, split by **what you are asking about**, not by which exporter answered:

| Dashboard / tab | Answers |
|---|---|
| **Device** | What is the whole card doing, who holds it, is it healthy |
| **MIG** | The same, per MIG instance |
| **eBPF** | What each pod is asking CUDA to do, and where it is waiting |

Device and MIG are separate because they describe **different entities**. Once MIG is enabled, DCGM stops
reporting device-scope profiling for that card and reports per-instance rows instead. An instance's
utilization must never be summed into a device total — the numbers are normalised to different denominators.

---

## 3. The controls

| Control | Notes |
|---|---|
| **GPU scope** | Filters to one card, or all. On the MIG tab this is the instance picker |
| **Pod scope** (eBPF tab) | Filters to one pod's CUDA activity |
| **Time range** | `5m` `15m` `1h` `6h` `24h` `7d`, or an absolute custom window |
| **Refresh** | `Off` `10s` `30s` `1m` `5m`, plus a manual **Refresh now** |

Two behaviours worth knowing:

**A wide window over a short workload shows markers, not a line.** The query step scales with the window — a
7d range steps at roughly 50 minutes, so ten minutes of traffic becomes one or two samples. Those are drawn as
points because a one-sample line strokes nothing at all. Seeing isolated dots is the correct rendering of
sparse data, not a glitch. Narrow the window to see the shape.

**The x-axis always spans the window you selected**, so a short burst appears as a narrow spike in its correct
position rather than being zoomed to fill the panel. This matches Grafana.

**Theme.** The UI follows your OS light/dark preference and the toggle in the top-right overrides it,
remembered per browser.

---

## 4. Reading an empty panel

An empty panel is not a fault. There are four distinct reasons, and the system deliberately tells them apart:

| What you see | Means | What to do |
|---|---|---|
| **"Not supported on this GPU"** | `gpu_metric_supported` is `0` for this entity — the hardware or driver cannot produce it | Nothing. Expected; see [05 — Limitations](05-limitations.md) |
| **"No data in this range"** | The metric exists but nothing happened in the window | Widen the window, or run a workload |
| A legend entry marked *not supported* beside live lines | A multi-pipe panel where one pipe is unavailable | Read the other lines; the named one will never fill |
| Genuinely blank, no message | Something is wrong | [06 — Troubleshooting](06-troubleshooting.md) |

The distinction is the reason this UI exists alongside Grafana, which can only draw an empty panel.

`ebpf_*` metrics are **absent until a workload makes the matching CUDA call**. An absent family means "no
workload did this", not "the exporter is broken" — a cluster doing no peer-to-peer copies legitimately has no
`ebpf_cuda_memory_peer_copies_bytes_total`.

---

## 5. Common tasks

### Who is using this GPU?

Device tab → **Per-Pod**. Or:

```bash
scripts/promq.sh 'sum by (namespace, pod, gpu_uuid) (nvml_process_sm_utilization_ratio)'
```

Under MIG, per-process sampling is unavailable — but an instance belongs to exactly one pod, so the
instance's hardware metrics *are* that pod's.

### Is anyone holding a GPU without using it?

The question this system exists for. Allocation and use are different facts:

```bash
scripts/promq.sh 'gpu_alloc_device_pod_info unless on(gpu_uuid, namespace, pod) (sum by (gpu_uuid, namespace, pod) (nvml_process_gpu_memory_bytes) > 0)'
```

Cross-check against the kernel launch rate before acting — one idle signal alone has false positives.

### Is this job using the accelerator it was given?

Device tab → **Performance** → *Tensor Core Utilization*. High FP32 with near-zero tensor activity in a
training job usually means mixed precision is not engaged.

### Is this pod stalled?

eBPF tab → *CUDA Kernel Launch Rate*. A flat rate while holding a GPU is the clearest stall signal there is.
Then check *Synchronization Latency* to tell blocked-waiting from dead.

### Has HAMi over-committed a card?

On a DRA cluster, the monitor reports **entitlement, not use** — a card fully promised and idle is the
over-subscription signal:

```bash
scripts/promq.sh 'GPUDeviceCoreLimit - GPUDeviceCoreAllocated'
```

Zero headroom is why a new ResourceClaim sits `Pending`.

---

## 6. Running a load generator

`test/loadgen/` holds fixtures that prove metrics respond. They hold real GPU resources — apply, observe,
delete:

| Fixture | Produces |
|---|---|
| `gpu-burn.yaml` | Synthetic saturation on a whole card, two co-tenants |
| `mig.yaml` | The same on one MIG instance |
| `dl-training.yaml` | ResNet-50 training, whole-GPU and MIG variants |
| `dl-inference.yaml` | Inference: forward passes, CUDA graph replay, event timing |

```bash
kubectl apply -f test/loadgen/dl-inference.yaml
# ... observe ...
kubectl delete -f test/loadgen/dl-inference.yaml
```

Two things to know before applying any of them:

- **They pin specific GPU and MIG UUIDs**, which differ on every cluster and change after a MIG repartition.
  A pod stuck `Pending` with no obvious reason is usually this. Re-derive with `kubectl get resourceslices`.
- **Their core shares must sum to ≤ 100% per physical card.** `gpu-burn` claims 80%, `dl-training` 65% and
  `dl-inference` 30%, all on the same card. Any two together exceed the cap and leave one pod permanently
  unschedulable — run them one at a time unless you have adjusted the shares.

---

## 7. Changing what is shown

The dashboard JSON is the single source of truth; the UI's panel spec is **generated** from it, never written
twice.

```bash
# 1. edit dashboards/*.json
# 2. check it against the metric catalogue
python3 scripts/check-dashboards.py dashboards/*.json

# 3. regenerate both derived artifacts
python3 scripts/gen-dashboard-configmaps.py dashboards/*.json --into deploy/22-grafana.yaml
python3 scripts/extract-panels.py dashboards/*.json -o services/advanced-monitoring-api/app/panels.json

# 4. apply — Grafana picks the dashboards up within a minute
kubectl apply -f deploy/22-grafana.yaml
```

`panels.json` is **baked into the API image**, so a panel change reaches Grafana immediately but does not
reach the UI until that image is rebuilt and redeployed.

Run the checks before committing:

```bash
python3 -m pytest test/ -q
cd services/advanced-monitoring-ui && npm test && npx tsc --noEmit
```
