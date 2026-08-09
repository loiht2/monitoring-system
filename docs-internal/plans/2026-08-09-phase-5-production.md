# Phase 5: Production Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **Commit policy — read before starting.** `CLAUDE.md` states *"Do not automatically commit until I approve."*
> Every "Commit" step below means: **stage the files, show the diff, and ask for approval.** Do not run
> `git commit` unattended. Commit messages must be brief and carry no AI co-author trailer.

**Goal:** Run the whole stack on the production cluster — adding HAMi's vGPUmonitor as the fourth source —
**without changing the behaviour of anything already consuming GPU metrics there.**

**Architecture:** Same manifests, a second environment directory. Three things genuinely differ: the DCGM
exporter is a standalone DaemonSet extended through a mounted ConfigMap rather than a `ClusterPolicy`;
Prometheus already exists and is owned by someone else; and vGPUmonitor exists, which it does not on the
validation cluster.

**Tech Stack:** Existing kube-prometheus-stack, existing standalone DCGM exporter, HAMi classic device-plugin,
the three exporters from Phases 1-3.

**Prerequisites:** [Phase 4](2026-08-09-phase-4-mig.md) complete, or explicitly waived — MIG is not present on
every fleet and is not a blocker for this port.

---

## This phase is different: you are a guest

Every other phase built on an empty namespace. Here, a monitoring stack and its consumers already exist, and
three of them fail **silently** if this port is done carelessly:

| Consumer | What it does | How this port could break it |
|---|---|---|
| Idle-GPU reclamation | Queries `DCGM_FI_DEV_GPU_UTIL` filtered by namespace and pod, and reads **only the first returned series** | A duplicate metric name makes "first" non-deterministic — a **busy** pod can be reclaimed. Losing the pod label makes the selector match nothing and reclamation stops forever, with no error |
| Admin overview | **Sums** a DCGM framebuffer metric across every returned series | A duplicate name doubles reported cluster VRAM |
| Alert rules | Divide one DCGM metric by another **without an explicit `on()`** | Any label-set divergence yields an empty vector; the alert stops firing, permanently and silently |

Hence: **one DCGM exporter, never two. Labels are added, never renamed. No field is ever removed from the
field list.** ([09 § 1](../09-risks-and-open-questions.md))

---

## Environment variables used throughout

```bash
export PROD_MON_NS=<namespace of the existing monitoring stack>
export PROD_DCGM_NS=<namespace of the existing DCGM exporter>
export PROD_HAMI_NS=<namespace where HAMi's device-plugin runs>
export PROD_NS=gpu-monitoring          # namespace this plan creates for our exporters
export IMAGE_NVML=ghcr.io/<owner>/nvml-exporter:<sha>
export IMAGE_EBPF=ghcr.io/<owner>/ebpf-gpu-exporter:<sha>
```

---

## File structure

| File | Responsibility |
|---|---|
| `deploy/ml-platform/00-namespace.yaml` | Namespace for our exporters |
| `deploy/ml-platform/10-rbac-*.yaml` | RBAC for the NVML and eBPF exporters |
| `deploy/ml-platform/30-dcgm-counters.yaml` | Field list for the **standalone** exporter's ConfigMap |
| `deploy/ml-platform/40-*.yaml` | The two exporter DaemonSets |
| `deploy/ml-platform/50-servicemonitor-*.yaml` | ServiceMonitors, including vGPUmonitor's |
| `deploy/ml-platform/60-dashboards.yaml` | Dashboards |
| `baselines/prod-*.txt` | Gitignored before/after evidence |

Environment directories are duplicated deliberately: the files are short, the differences are load-bearing,
and a reader sees the whole environment without resolving an overlay ([07 § 1](../07-backend-and-deployment.md)).

---

### Task 1: Record what the existing consumers do today

Without a before-picture, "nothing broke" is an assertion rather than a measurement. This is **A-7**.

**Files:**
- Create: `baselines/prod-before.txt` (gitignored)

- [ ] **Step 1: Write the failing test**

```bash
test -s baselines/prod-before.txt && echo "baseline recorded" || { echo "NOT recorded"; false; }
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `NOT recorded`

- [ ] **Step 3: Point the query helper at the existing Prometheus**

```bash
export NS="$PROD_MON_NS"
export PROMQ_SVC=<the existing Prometheus service name>
```

`scripts/promq.sh` port-forwards `svc/prometheus-operated`. If the existing stack names its service
differently, pass the right one — do not create a second Prometheus.

- [ ] **Step 4: Record every existing consumer's inputs**

```bash
mkdir -p baselines
{
  echo "== DCGM metric names currently exposed =="
  ./scripts/promq.sh 'group by (__name__) ({__name__=~"DCGM_FI_.*"})'
  echo "== label set on the metric reclamation queries =="
  ./scripts/promq.sh 'DCGM_FI_DEV_GPU_UTIL'
  echo "== does that metric carry pod attribution today? =="
  ./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL{pod!=""})'
  echo "== the sum the admin overview computes =="
  ./scripts/promq.sh 'sum(DCGM_FI_DEV_FB_USED)'
  echo "== the ratio the memory alert computes =="
  ./scripts/promq.sh 'DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL'
  echo "== how many DCGM exporters are running =="
  ./scripts/promq.sh 'count(count by (instance) (DCGM_FI_DEV_GPU_UTIL))'
} > baselines/prod-before.txt
cat baselines/prod-before.txt
```

Two readings matter more than the rest:

- **The pod-attribution count.** If it is already `0`, reclamation is *already* inert on this cluster and this
  port is not what broke it. Record that, because it will otherwise look like a regression later.
- **The memory-alert ratio.** If it is already `(empty result)`, the alert is already never firing. Same
  reasoning.

- [ ] **Step 5: Run the test to verify it passes**

Run the Step 1 command.
Expected: PASS — `baseline recorded`

- [ ] **Step 6: Confirm exactly one DCGM exporter exists**

```bash
kubectl get ds -A | grep -i dcgm
```

Expected: exactly one. **If there are two, stop** — the hazards in the table above are already live, and that
is a pre-existing defect to report before adding anything.

---

### Task 2: Extend the DCGM field list — ConfigMap route

The production exporter is a standalone DaemonSet whose field list is a **mounted ConfigMap**, not a
`ClusterPolicy` reference. Same field list, different extension point.

**Files:**
- Create: `deploy/ml-platform/30-dcgm-counters.yaml`

- [ ] **Step 1: Write the failing test**

```bash
./scripts/promq.sh 'count by (__name__) ({__name__=~"DCGM_FI_PROF_SM_ACTIVE|DCGM_FI_PROF_SM_OCCUPANCY|DCGM_FI_PROF_PIPE_TENSOR_HMMA_ACTIVE|DCGM_FI_PROF_PIPE_INT_ACTIVE|DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL"})'
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: fewer families than requested, or `(empty result)`.

- [ ] **Step 3: Read the exporter's current mount before editing anything**

```bash
kubectl -n "$PROD_DCGM_NS" get ds -l app=dcgm-exporter -o json | python3 -c '
import json, sys
c = json.load(sys.stdin)["items"][0]["spec"]["template"]["spec"]["containers"][0]
print("collectors env:", [e.get("value") for e in c.get("env", []) if "COLLECTORS" in e["name"]])
print("mounts:", [(m["name"], m["mountPath"], m.get("subPath")) for m in c.get("volumeMounts", [])])'
kubectl -n "$PROD_DCGM_NS" get cm -o name
```

**Record the ConfigMap name, its data key and the subPath.** The new manifest must match all three exactly —
a mismatch means the exporter keeps reading its old file and nothing appears to change.

- [ ] **Step 4: Write the field list**

Take the field list from `deploy/a30-node/30-dcgm-counters.yaml` and re-target it at the ConfigMap name and
key discovered in Step 3. Then reconcile against what production collects today:

```bash
./scripts/promq.sh 'group by (__name__) ({__name__=~"DCGM_FI_.*"})' \
  | sed 's/{.*//' | tr -d ' ' | grep . | sort > /tmp/prod-fields-before.txt
grep -oE '^ *DCGM_FI_[A-Z0-9_]+' deploy/ml-platform/30-dcgm-counters.yaml \
  | tr -d ' ' | sort > /tmp/prod-fields-after.txt
comm -23 /tmp/prod-fields-before.txt /tmp/prod-fields-after.txt
```

Expected: **no output.** Any line is a field production collects today that the new list drops — add it back.
Production's existing list will differ from the validation cluster's; the union is what ships.

- [ ] **Step 5: Apply and restart**

```bash
kubectl apply -f deploy/ml-platform/30-dcgm-counters.yaml
kubectl -n "$PROD_DCGM_NS" rollout restart ds -l app=dcgm-exporter
kubectl -n "$PROD_DCGM_NS" rollout status  ds -l app=dcgm-exporter --timeout=300s
sleep 30
```

- [ ] **Step 6: Run the test to verify it passes**

Run the Step 1 command.
Expected: PASS — every added family present.

- [ ] **Step 7: Immediately re-check the existing consumers**

```bash
./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL{pod!=""})'
./scripts/promq.sh 'sum(DCGM_FI_DEV_FB_USED)'
./scripts/promq.sh 'DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL'
```

Expected: **identical to `baselines/prod-before.txt`.** Any change here is a regression caused by this step,
before any exporter of ours is deployed — revert the ConfigMap and investigate.

- [ ] **Step 8: Stage and request commit approval**

```bash
git add deploy/ml-platform/30-dcgm-counters.yaml
git diff --cached --stat
# suggested message: "extend production dcgm field list"
```

---

### Task 3: ServiceMonitors that add labels without renaming any

- [ ] **Step 1: Write the failing test**

```bash
./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL{gpu_uuid!="",UUID!=""})'
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: `(empty result)` — `gpu_uuid` does not exist yet.

- [ ] **Step 3: Check how the existing Prometheus selects ServiceMonitors**

```bash
kubectl -n "$PROD_MON_NS" get prometheus -o json | python3 -c '
import json, sys
for p in json.load(sys.stdin)["items"]:
    s = p["spec"]
    print(p["metadata"]["name"],
          "smSelector:", json.dumps(s.get("serviceMonitorSelector")),
          "smNsSelector:", json.dumps(s.get("serviceMonitorNamespaceSelector")))'
```

- If the selector is `{}` or null-with-everything-selected, our ServiceMonitors are picked up as-is.
- If it requires a release label, **add that label to our ServiceMonitors**. Do not widen the existing
  Prometheus's selector: that changes behaviour for every other tenant of this cluster.

- [ ] **Step 4: Copy the ServiceMonitors and add the required labels**

Copy `deploy/a30-node/50-servicemonitor-*.yaml` to `deploy/ml-platform/`, adding whatever label Step 3
requires. **Do not change the relabeling.** It copies `UUID` → `gpu_uuid` and retains the original; renaming
would break the alert rules described at the top of this plan.

- [ ] **Step 5: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/ml-platform/50-servicemonitor-dcgm.yaml
sleep 30
./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL{gpu_uuid!="",UUID!=""})'
./scripts/promq.sh 'DCGM_FI_DEV_GPU_UTIL'
```

Expected: PASS — the count is non-zero, and **every original label from the baseline is still present** on the
sample output. Compare against `baselines/prod-before.txt` label by label.

- [ ] **Step 6: Stage and request commit approval**

```bash
git add deploy/ml-platform/50-servicemonitor-dcgm.yaml
git diff --cached --stat
# suggested message: "add production dcgm servicemonitor"
```

---

### Task 4: Deploy the NVML and eBPF exporters

- [ ] **Step 1: Write the failing test**

```bash
./scripts/promq.sh 'count(nvml_process_gpu_memory_bytes)'
./scripts/promq.sh 'count(count by (__name__) ({__name__=~"ebpf_cuda_.*"}))'
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: `(empty result)` from both.

- [ ] **Step 3: Copy the manifests and adjust only what must differ**

```bash
mkdir -p deploy/ml-platform
cp deploy/a30-node/00-namespace.yaml            deploy/ml-platform/
cp deploy/a30-node/10-rbac-nvml-exporter.yaml   deploy/ml-platform/
cp deploy/a30-node/40-nvml-exporter.yaml        deploy/ml-platform/
cp deploy/a30-node/40-ebpf-exporter.yaml        deploy/ml-platform/
cp deploy/a30-node/50-servicemonitor-nvml.yaml  deploy/ml-platform/
cp deploy/a30-node/50-servicemonitor-ebpf.yaml  deploy/ml-platform/
```

Only four things should differ from the validation copies:

| Difference | Why |
|---|---|
| Image references | Digest-pinned per environment |
| ServiceMonitor labels | Whatever Task 3 Step 3 requires |
| Node selector | Production's GPU-node label may differ — check `kubectl get nodes --show-labels` |
| Host port for the eBPF agent | Must not collide with anything already bound on production's GPU nodes |

**Check the eBPF host port before applying**, since a collision on a production node is disruptive:

```bash
kubectl get pods -A -o json | python3 -c '
import json, sys
for pod in json.load(sys.stdin)["items"]:
    if not pod["spec"].get("hostNetwork"):
        continue
    for c in pod["spec"]["containers"]:
        for p in c.get("ports") or []:
            print(pod["metadata"]["namespace"], pod["metadata"]["name"], p.get("containerPort"))'
```

- [ ] **Step 4: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/ml-platform/00-namespace.yaml
kubectl apply -f deploy/ml-platform/10-rbac-nvml-exporter.yaml
sed "s|REPLACE_ME|${IMAGE_NVML}|" deploy/ml-platform/40-nvml-exporter.yaml | kubectl apply -f -
sed "s|REPLACE_ME|${IMAGE_EBPF}|" deploy/ml-platform/40-ebpf-exporter.yaml | kubectl apply -f -
kubectl apply -f deploy/ml-platform/50-servicemonitor-nvml.yaml
kubectl apply -f deploy/ml-platform/50-servicemonitor-ebpf.yaml
kubectl -n "$PROD_NS" rollout status ds/nvml-exporter      --timeout=300s
kubectl -n "$PROD_NS" rollout status ds/ebpf-gpu-exporter  --timeout=300s
sleep 60
./scripts/promq.sh 'count(nvml_process_gpu_memory_bytes)'
./scripts/promq.sh 'count(count by (__name__) ({__name__=~"ebpf_cuda_.*"}))'
```

Expected: PASS — both non-zero, assuming GPU workloads are running. On a production cluster there usually are;
if not, the counts are legitimately empty and this must be re-checked when work arrives.

- [ ] **Step 5: Verify the fractional-sharing case, which the validation cluster could not exercise**

Production shares each physical GPU between several pods. This is the situation the whole design exists for:

```bash
./scripts/promq.sh 'count by (gpu_uuid) (gpu_alloc_device_pod_info) > 1'
./scripts/promq.sh 'sort_desc(sum by (gpu_uuid, namespace, pod) (nvml_process_sm_utilization_ratio))'
```

Expected: several pods per `gpu_uuid`, each with its **own** utilization figure. Identical figures across
co-tenants on one device would mean per-pod attribution is not working here even though it worked on the
validation cluster — record it against A-2 and escalate.

- [ ] **Step 6: Stage and request commit approval**

```bash
git add deploy/ml-platform/
git diff --cached --stat
# suggested message: "deploy exporters to production"
```

---

### Task 5: Integrate vGPUmonitor as the fourth source

It is a container inside HAMi's device-plugin DaemonSet, exposed through its own Service. It is already
running and **cannot be switched off** — the sidecar is unconditional in the chart. We scrape it and drop the
two families that duplicate NVML exactly.

**Files:**
- Create: `deploy/ml-platform/50-servicemonitor-vgpumonitor.yaml`

- [ ] **Step 1: Write the failing test**

```bash
# Container-level HAMi metrics present, device-level ones dropped.
./scripts/promq.sh 'count(hami_vgpu_memory_used_bytes)'
./scripts/promq.sh 'count({__name__=~"hami_host_gpu_.*"})'
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: `(empty result)` from the first — nothing scrapes it yet.

- [ ] **Step 3: Find the monitor Service and confirm the legacy-names flag is off**

```bash
kubectl -n "$PROD_HAMI_NS" get svc -o wide | grep -i monitor
kubectl -n "$PROD_HAMI_NS" get ds -o json | python3 -c '
import json, sys
for ds in json.load(sys.stdin)["items"]:
    for c in ds["spec"]["template"]["spec"]["containers"]:
        if "monitor" in c["name"]:
            print(ds["metadata"]["name"], "/", c["name"], "args:", c.get("command"), c.get("args"))'
```

**The `--legacy-metrics` flag must not be set.** With it, vGPUmonitor emits a second copy of everything under
an older naming style — duplication *inside* HAMi, independent of anything we do
([06 § 3](../06-hami-vgpumonitor.md)). If it is set, that is a HAMi values change to agree with its owner
before continuing.

- [ ] **Step 4: Write the ServiceMonitor with the deduplication**

`deploy/ml-platform/50-servicemonitor-vgpumonitor.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gpu-hami-vgpumonitor
  namespace: gpu-monitoring
  labels:
    app.kubernetes.io/part-of: gpu-monitoring
spec:
  namespaceSelector:
    matchNames: ["REPLACE_HAMI_NS"]
  selector:
    matchLabels:
      app.kubernetes.io/component: hami-device-plugin
  endpoints:
    - port: monitorport
      interval: 15s
      honorLabels: true
      metricRelabelings:
        # These two are the SAME NVML calls the NVML exporter already makes.
        # They can differ only by scrape skew, so keeping both stores two
        # series for one fact and forces a choice during an incident.
        - sourceLabels: [__name__]
          regex: 'hami_host_gpu_(memory_used_bytes|utilization_ratio)'
          action: drop
        # Copy, never rename — same rule as everywhere else.
        - sourceLabels: [device_uuid]
          targetLabel: gpu_uuid
          action: replace
```

Replace `REPLACE_HAMI_NS`, and correct the port name and selector labels to whatever Step 3 reported.

- [ ] **Step 5: Apply and run the test to verify it passes**

```bash
sed "s|REPLACE_HAMI_NS|${PROD_HAMI_NS}|" deploy/ml-platform/50-servicemonitor-vgpumonitor.yaml | kubectl apply -f -
sleep 30
./scripts/promq.sh 'count(hami_vgpu_memory_used_bytes)'
./scripts/promq.sh 'count({__name__=~"hami_host_gpu_.*"})'
./scripts/promq.sh 'count({__name__=~"HostGPUMemoryUsage|vGPU_device_memory_usage_in_bytes|Device_utilization_desc_of_container"})'
```

Expected: the first is non-zero; the second and third are `(empty result)`.

- [ ] **Step 6: Verify the overlap that is kept on purpose**

`hami_vgpu_memory_used_bytes` and `nvml_process_gpu_memory_bytes` measure the same concept from different
places. The difference is a real diagnostic, which is why it is not deduplicated
([06 § 4](../06-hami-vgpumonitor.md)):

```bash
./scripts/promq.sh 'DCGM_FI_DEV_FB_USED * 1024 * 1024 - on(gpu_uuid) sum by (gpu_uuid) (hami_vgpu_memory_used_bytes)'
./scripts/promq.sh 'hami_container_device_utilization_ratio - on(namespace, pod) sum by (namespace, pod) (nvml_process_sm_utilization_ratio)'
```

Expected: small non-zero values. A **large** divergence means HAMi is enforcing against a number that does not
match the hardware — a finding worth reporting, not a broken query.

- [ ] **Step 7: Stage and request commit approval**

```bash
git add deploy/ml-platform/50-servicemonitor-vgpumonitor.yaml
git diff --cached --stat
# suggested message: "scrape hami vgpumonitor with device-level dedup"
```

---

### Task 6: A-7 — prove nothing that already existed changed

**The most important task in this plan.** Everything else adds capability; this one proves the addition cost
nothing.

- [ ] **Step 1: Write the failing test**

```bash
test -s baselines/prod-after.txt && echo "after recorded" || { echo "NOT recorded"; false; }
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `NOT recorded`

- [ ] **Step 3: Re-record every reading from Task 1**

```bash
{
  echo "== DCGM metric names currently exposed =="
  ./scripts/promq.sh 'group by (__name__) ({__name__=~"DCGM_FI_.*"})'
  echo "== label set on the metric reclamation queries =="
  ./scripts/promq.sh 'DCGM_FI_DEV_GPU_UTIL'
  echo "== does that metric carry pod attribution today? =="
  ./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL{pod!=""})'
  echo "== the sum the admin overview computes =="
  ./scripts/promq.sh 'sum(DCGM_FI_DEV_FB_USED)'
  echo "== the ratio the memory alert computes =="
  ./scripts/promq.sh 'DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL'
  echo "== how many DCGM exporters are running =="
  ./scripts/promq.sh 'count(count by (instance) (DCGM_FI_DEV_GPU_UTIL))'
} > baselines/prod-after.txt
diff baselines/prod-before.txt baselines/prod-after.txt
```

Expected differences, and **only** these:

| Acceptable | Not acceptable |
|---|---|
| New `DCGM_FI_*` names appear in the name list | An existing name disappears |
| `gpu_uuid` and `node` appear **in addition to** existing labels | An existing label is missing or renamed |
| Values move because the cluster's workload moved | The exporter count changes from 1 to 2 |
| | The framebuffer sum roughly doubles |
| | The memory-alert ratio becomes empty when it previously returned rows |

- [ ] **Step 4: Exercise the reclamation query exactly as its consumer does**

Do not infer this from the metric's presence — run the query the consumer actually runs, against a pod that
really exists:

```bash
POD=<a running GPU pod>; NSP=<its namespace>
./scripts/promq.sh "avg_over_time(DCGM_FI_DEV_GPU_UTIL{namespace=\"$NSP\",pod=\"$POD\"}[30m])"
```

Expected: **exactly one series.** Two series means a duplicate metric name exists and the consumer's
"first result" is now non-deterministic — the failure mode that can terminate a busy pod. Stop and find the
second producer.

- [ ] **Step 5: Confirm the exporter count is still one**

```bash
kubectl get ds -A | grep -i dcgm
./scripts/promq.sh 'count(count by (instance) (DCGM_FI_DEV_GPU_UTIL))'
```

Expected: one DaemonSet, and a count matching the number of GPU nodes.

- [ ] **Step 6: Record the outcome against A-7**

Update [09 § 2](../09-risks-and-open-questions.md) with the measured result. If anything regressed, the
revert is: remove our ServiceMonitors first (that undoes the relabeling), then revert the counters ConfigMap.
Our exporters can stay — they share no metric name with anything.

---

### Task 7: The pod-to-user join, degrading to anonymous

Attributing GPU usage to a *platform user* needs pod metadata that GPU metrics do not carry. It exists as pod
labels, and the conventional join source is a cluster-state metrics exporter — which the validation cluster
deliberately excluded, because nothing there produced such pods (OQ-1).

- [ ] **Step 1: Write the failing test**

```bash
./scripts/promq.sh 'count(kube_pod_labels)'
```

- [ ] **Step 2: Run the test to verify it fails, or discover it already passes**

If the metric exists, the join source is already present and no new component is needed. If it is
`(empty result)`, **do not deploy one as part of this project** — that is a change to someone else's
monitoring stack. Record it and ship the panels degrading to anonymous.

- [ ] **Step 3: Confirm the pod labels carry the identity**

```bash
./scripts/promq.sh 'group by (__name__) ({__name__=~"kube_pod_labels"})'
kubectl get pods -A --show-labels | head -5
```

Identify the label carrying the platform username and the one carrying the workload identity. Their exact
names are a property of the platform, not of this system.

- [ ] **Step 4: Write the join so un-joined series survive**

A naive `group_left` against an absent metric drops **every** series, turning a partial answer into "No data".
Write it so unmatched series survive:

```promql
(
    sum by (namespace, pod) (nvml_process_sm_utilization_ratio)
  * on(namespace, pod) group_left(label_<username_label>)
    kube_pod_labels
)
or
  sum by (namespace, pod) (nvml_process_sm_utilization_ratio)
```

- [ ] **Step 5: Run the test to verify it passes both ways**

```bash
./scripts/promq.sh '(sum by (namespace, pod) (nvml_process_sm_utilization_ratio) * on(namespace, pod) group_left(label_<username_label>) kube_pod_labels) or sum by (namespace, pod) (nvml_process_sm_utilization_ratio)'
```

Expected: every GPU pod appears — those with the label enriched, those without still present and anonymous.
**Confirm the count equals the un-joined query's count**, which is the property that makes the panel portable
back to a cluster with no metadata source.

- [ ] **Step 6: No commit unless a panel changed**

If a dashboard panel was updated to carry the join, stage it and request approval.

---

### Task 8: Dashboards render with no panel edits

The portability claim from the start of the project: panels built on `nvml_*`, `DCGM_FI_*`, `ebpf_*` and
`gpu_alloc_*` port unchanged, because those surfaces are identical in both environments.

**Files:**
- Create: `deploy/ml-platform/60-dashboards.yaml`

- [ ] **Step 1: Write the failing test**

```bash
kubectl -n "$PROD_MON_NS" get cm -o name | grep -c 'grafana-dashboard-gpu-\(compute\|cuda\)' || echo 0
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: `0`.

- [ ] **Step 3: Check for dashboard and datasource collisions first**

```bash
kubectl -n "$PROD_MON_NS" get cm -o json | python3 -c '
import json, sys
for cm in json.load(sys.stdin)["items"]:
    for key, body in (cm.get("data") or {}).items():
        if key.endswith(".json") and "\"uid\"" in body:
            try:
                print(cm["metadata"]["name"], key, json.loads(body).get("uid"))
            except Exception:
                print(cm["metadata"]["name"], key, "(unparseable)")'
```

Expected: **no existing dashboard uses `gpu-compute` or `gpu-cuda` as its UID.** Where several components
write dashboard ConfigMaps, a name or UID collision means one silently overwrites the other on every reconcile
([09 — R-4](../09-risks-and-open-questions.md)). Also check whether a provisioning script manages
datasources here — some delete datasources they do not recognize.

- [ ] **Step 4: Ship the dashboards unchanged**

```bash
kubectl create configmap grafana-dashboard-gpu-compute \
  --namespace "$PROD_MON_NS" --from-file=gpu-compute.json=dashboards/gpu-compute.json \
  --dry-run=client -o yaml  > deploy/ml-platform/60-dashboards.yaml
echo "---" >> deploy/ml-platform/60-dashboards.yaml
kubectl create configmap grafana-dashboard-gpu-cuda \
  --namespace "$PROD_MON_NS" --from-file=gpu-cuda.json=dashboards/gpu-cuda.json \
  --dry-run=client -o yaml >> deploy/ml-platform/60-dashboards.yaml
kubectl apply -f deploy/ml-platform/60-dashboards.yaml
```

Add the label the existing Grafana's dashboard sidecar watches for — read it from that Grafana's deployment
rather than assuming.

- [ ] **Step 5: Run the test to verify it passes, then look at them**

```bash
kubectl -n "$PROD_MON_NS" get cm -o name | grep 'grafana-dashboard-gpu-'
kubectl -n "$PROD_MON_NS" port-forward svc/<existing grafana service> 3000:80
# open http://127.0.0.1:3000 and find the GPU folder
```

Expected: **every panel draws data with no edit to any panel.** A panel that needs changing here is a
portability defect worth recording — the whole point of the label contract was that it would not.

- [ ] **Step 6: Stage and request commit approval**

```bash
git add deploy/ml-platform/60-dashboards.yaml
git diff --cached --stat
# suggested message: "ship dashboards to production"
```

---

## Phase 5 exit criteria

- [ ] Every reading in `baselines/prod-after.txt` matches `baselines/prod-before.txt` except added names and
      added labels (Task 6 Step 3) — **A-7 answered**
- [ ] The reclamation query returns **exactly one series** for a real pod (Task 6 Step 4)
- [ ] Exactly one DCGM exporter runs, and the framebuffer sum did not double (Task 6 Step 5)
- [ ] Co-tenants on one physical GPU have **distinct** per-pod utilization (Task 4 Step 5) — the fractional
      case the validation cluster could not exercise
- [ ] vGPUmonitor is scraped, its two device-level families dropped, legacy names confirmed off (Task 5)
- [ ] Dashboards render with **no panel edits** (Task 8 Step 5)
- [ ] The pod-to-user join either works or degrades to anonymous without losing series (Task 7)

---

## The project is complete at this point

All five phases delivered. Open items that outlive the project:

| Item | Status |
|---|---|
| **OQ-2** — retention target once history matters | Decide with real cardinality from Phase 3 measured |
| Storage | Prometheus must be on durable storage, never a network filesystem |
| A-8 normalization result | Feeds any future MIG dashboard |
| Downstream consumers | Prometheus is the boundary; a collector reading these metrics is a separate project ([09 § 5](../09-risks-and-open-questions.md)) |
