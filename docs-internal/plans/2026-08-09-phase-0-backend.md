# Phase 0: Metrics Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **Commit policy — read before starting.** `CLAUDE.md` states *"Do not automatically commit until I approve."*
> Every "Commit" step below means: **stage the files, show the diff, and ask for approval.** Do not run
> `git commit` unattended. Commit messages must be brief and carry no AI co-author trailer.

**Goal:** Stand up Prometheus and Grafana on the validation cluster and prove the pipeline end to end by
scraping the DCGM exporter that already runs, with the device UUID label normalized.

**Architecture:** Nothing is built from source. Prometheus Operator, Prometheus and Grafana are deployed as
pinned upstream manifests. Scrape configuration is `ServiceMonitor` objects so it ports unchanged to a cluster
already running a Prometheus Operator stack. Metric labels are **copied, never renamed**.

**Tech Stack:** Kubernetes, Prometheus Operator v0.92.0, Prometheus, Grafana, plain numbered YAML applied with
`kubectl`.

**Out of scope:** extending the DCGM field list (Phase 1), the NVML exporter (Phase 2), the eBPF exporter
(Phase 3), image CI (Phase 2, where the first image we build exists), and alerting (out of scope entirely —
[09 § 5](../09-risks-and-open-questions.md)).

---

## Environment variables used throughout

Set these once per shell. The real values are site-specific and live in the gitignored site note, **not** in
this plan:

```bash
export NS=gpu-monitoring                 # namespace this plan creates
export DCGM_NS=gpu-operator              # namespace where the DCGM exporter already runs
export REGISTRY=<registry host:port>     # from the site note
export CLUSTERPOLICY=<name>              # kubectl get clusterpolicies.nvidia.com -o name
```

> **`ClusterPolicy` is an ambiguous kind name.** Both the NVIDIA GPU Operator
> (`clusterpolicies.nvidia.com`) and Kyverno (`clusterpolicies.kyverno.io`) use it. Always type the fully
> qualified resource name; a bare `kubectl get clusterpolicy` may resolve to the wrong CRD.


---

## File structure

| File | Responsibility |
|---|---|
| `scripts/promq.sh` | Run one PromQL instant query against Prometheus through a port-forward. Used by nearly every verification step in every phase |
| `scripts/_promq_fmt.py` | Formats the query response. Separate file to avoid nested shell quoting |
| `scripts/prof-baseline.sh` | Sample every `DCGM_FI_PROF_*` field under load into a diffable table. Used by Phase 1 |
| `scripts/test-helpers.sh` | Smoke test for the helper scripts |
| `deploy/a30-node/00-namespace.yaml` | The namespace |
| `deploy/a30-node/10-rbac-prometheus.yaml` | ServiceAccount, ClusterRole, ClusterRoleBinding for Prometheus discovery |
| `deploy/a30-node/20-prometheus-operator.yaml` | Vendored upstream operator manifests, CRDs stripped, namespace patched |
| `deploy/a30-node/21-prometheus.yaml` | The `Prometheus` custom resource |
| `deploy/a30-node/22-grafana.yaml` | Grafana Deployment, Service, datasource and dashboard provisioning |
| `deploy/a30-node/50-servicemonitor-dcgm.yaml` | ServiceMonitor for the existing DCGM exporter, with label normalization |

Numbering is dependency order: `kubectl apply -f deploy/a30-node/` in lexical order must work from an empty
namespace.

---


Ends with: Prometheus holding `DCGM_FI_*` series carrying a `gpu_uuid` label, visible in Grafana.

---

### Task 1: Verification helper scripts

**Files:**
- Create: `scripts/promq.sh`
- Create: `scripts/_promq_fmt.py`
- Create: `scripts/prof-baseline.sh`
- Create: `scripts/test-helpers.sh`

- [ ] **Step 1: Write the failing test**

`scripts/test-helpers.sh`:

```bash
#!/usr/bin/env bash
# Smoke test for the helper scripts. Checks they exist, are executable and parse.
set -euo pipefail
fail=0
for s in scripts/promq.sh scripts/prof-baseline.sh; do
  [ -x "$s" ]  || { echo "NOT EXECUTABLE: $s"; fail=1; }
  bash -n "$s" || { echo "SYNTAX ERROR: $s";   fail=1; }
done
python3 -c "import ast,sys; ast.parse(open('scripts/_promq_fmt.py').read())" \
  || { echo "SYNTAX ERROR: scripts/_promq_fmt.py"; fail=1; }
[ "$fail" -eq 0 ] && echo "helper scripts OK"
exit "$fail"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `chmod +x scripts/test-helpers.sh && ./scripts/test-helpers.sh`
Expected: FAIL — `NOT EXECUTABLE: scripts/promq.sh`

- [ ] **Step 3: Write `scripts/promq.sh`**

```bash
#!/usr/bin/env bash
# Run one PromQL instant query against the Prometheus deployed by this project.
# Usage: scripts/promq.sh 'up{job="gpu-dcgm"}'
# Prints one line per series: <value> <labels>
set -euo pipefail

NS="${NS:-gpu-monitoring}"
QUERY="${1:?usage: promq.sh '<promql>'}"
PORT="${PROMQ_PORT:-19090}"

kubectl -n "$NS" port-forward svc/prometheus-operated "${PORT}:9090" >/dev/null 2>&1 &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  # Fail fast rather than polling a dead forward for 15s and then crashing
  # confusingly downstream.
  kill -0 "$PF_PID" 2>/dev/null || { echo "port-forward to svc/prometheus-operated in ns $NS failed" >&2; exit 1; }
  curl -sf "http://127.0.0.1:${PORT}/-/ready" >/dev/null 2>&1 && break
  sleep 0.5
done

# NOT -f on this one. curl -f suppresses the response body on any non-2xx, and
# a bad query or an unready Prometheus returns its explanation IN the body —
# which is exactly what _promq_fmt.py's "status != success" branch prints.
# With -f the formatter gets zero bytes and dies with a JSONDecodeError instead.
curl -sG "http://127.0.0.1:${PORT}/api/v1/query" --data-urlencode "query=${QUERY}" \
  | python3 "$(cd "$(dirname "$0")" && pwd)/_promq_fmt.py"
```

- [ ] **Step 4: Write `scripts/_promq_fmt.py`**

Kept as a separate file rather than inlined into the shell script: an inline `python3 -c` here would need
single quotes inside single quotes, which is exactly the kind of quoting that breaks silently.

```python
"""Format a Prometheus instant-query response as one line per series."""
import json
import sys

d = json.load(sys.stdin)

if d.get("status") != "success":
    print("QUERY FAILED:", d.get("error", "unknown"))
    sys.exit(1)

result = d["data"]["result"]
if not result:
    print("(empty result)")
    sys.exit(0)

for r in result:
    metric = r["metric"]
    name = metric.get("__name__", "")
    labels = ",".join(f"{k}={v}" for k, v in sorted(metric.items()) if k != "__name__")
    print(f'{r["value"][1]:>12}  {name}{{{labels}}}')
```

- [ ] **Step 5: Write `scripts/prof-baseline.sh`**

```bash
#!/usr/bin/env bash
# Sample every DCGM_FI_PROF_* field and print a stable, diffable table.
# Run this under an identical GPU load before and after a field-list change,
# then diff the two outputs. See docs-internal/09 A-1.
# Usage: scripts/prof-baseline.sh <output-file> [sample-seconds]
set -euo pipefail

OUT="${1:?usage: prof-baseline.sh <output-file> [sample-seconds]}"
WINDOW="${2:-60}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "sampling for ${WINDOW}s ..." >&2
sleep "$WINDOW"

: > "$OUT"
# promq.sh prints "<value>  <name>{labels}", so the NAME is field 2. Do not
# strip all spaces: that glues the value onto the name and every query built
# from it becomes invalid PromQL.
# Two steps on purpose. promq.sh failing must still abort loudly, but grep
# matching nothing must NOT: under `set -e` with pipefail, grep's exit 1 makes
# the whole assignment fail and the script dies BEFORE the guard below can
# report why. `|| true` on the second assignment only is what keeps both.
RAW=$("$HERE/promq.sh" 'group by (__name__) ({__name__=~"DCGM_FI_PROF_.*"})')
FIELDS=$(printf '%s\n' "$RAW" \
           | awk '{print $2}' | sed 's/{.*//' | grep -E '^DCGM_FI_PROF_' | sort || true)
if [ -z "$FIELDS" ]; then
  echo "no DCGM_FI_PROF_* metrics found — is the exporter scraped?" >&2
  exit 1
fi

for field in $FIELDS; do
  "$HERE/promq.sh" "avg_over_time(${field}[${WINDOW}s])" \
    | sed "s/^/${field} /" >> "$OUT"
done
sort -o "$OUT" "$OUT"
echo "wrote $OUT" >&2
cat "$OUT"
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `chmod +x scripts/promq.sh scripts/prof-baseline.sh scripts/test-helpers.sh && ./scripts/test-helpers.sh`
Expected: PASS — `helper scripts OK`

- [ ] **Step 7: Stage and request commit approval**

```bash
git add scripts/promq.sh scripts/_promq_fmt.py scripts/prof-baseline.sh scripts/test-helpers.sh
git diff --cached --stat
# then ask for approval; suggested message: "add PromQL verification helpers"
```

---

### Task 2: Namespace and Prometheus RBAC

**Files:**
- Create: `deploy/a30-node/00-namespace.yaml`
- Create: `deploy/a30-node/10-rbac-prometheus.yaml`

- [ ] **Step 1: Write the failing test**

```bash
# Expected to fail now, pass after Step 3.
kubectl get ns "$NS" -o name && \
kubectl -n "$NS" get sa prometheus-gpu -o name && \
kubectl get clusterrolebinding prometheus-gpu -o name
```

- [ ] **Step 2: Run the test to verify it fails**

Run the command above.
Expected: FAIL — `Error from server (NotFound): namespaces "gpu-monitoring" not found`

- [ ] **Step 3: Write the manifests**

`deploy/a30-node/00-namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: gpu-monitoring
  labels:
    app.kubernetes.io/part-of: gpu-monitoring
```

`deploy/a30-node/10-rbac-prometheus.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus-gpu
  namespace: gpu-monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-gpu
rules:
  # Least privilege. Every target in this project is Service-based, so the
  # endpoints and endpointslices discovery paths are all that is needed.
  # Deliberately NOT granted: `nodes` / `nodes/metrics` (cluster-wide read of
  # every kubelet's metrics) and `nonResourceURLs: /metrics` (the API server's
  # own metrics). Those are kube-prometheus-stack boilerplate for node-role and
  # apiserver scrape jobs, which no phase of this project defines. Add them back
  # only when such a job is actually introduced.
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list", "watch"]
  # `get` only, and that is sufficient: any ConfigMap reference (a TLS CA
  # bundle, say) is by exact name, never discovered by listing.
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus-gpu
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus-gpu
subjects:
  - kind: ServiceAccount
    name: prometheus-gpu
    namespace: gpu-monitoring
```

- [ ] **Step 4: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/a30-node/00-namespace.yaml
kubectl apply -f deploy/a30-node/10-rbac-prometheus.yaml
kubectl get ns "$NS" -o name && \
kubectl -n "$NS" get sa prometheus-gpu -o name && \
kubectl get clusterrolebinding prometheus-gpu -o name
```

Expected: PASS — three lines: `namespace/gpu-monitoring`, `serviceaccount/prometheus-gpu`,
`clusterrolebinding.rbac.authorization.k8s.io/prometheus-gpu`

- [ ] **Step 5: Stage and request commit approval**

```bash
git add deploy/a30-node/00-namespace.yaml deploy/a30-node/10-rbac-prometheus.yaml
git diff --cached --stat
# suggested message: "add monitoring namespace and Prometheus RBAC"
```

---

### Task 3: Prometheus Operator

The cluster already has the Prometheus Operator CRDs but **no controller** to reconcile them. Without the
controller a `Prometheus` object is created and never instantiated, and a `ServiceMonitor` applies cleanly and
is scraped by nothing.

**Files:**
- Create: `deploy/a30-node/20-prometheus-operator.yaml`

- [ ] **Step 1: Write the failing test**

```bash
# The controller must exist AND be reconciling. A Deployment named
# prometheus-operator with 1 ready replica is the check.
kubectl -n "$NS" get deploy prometheus-operator \
  -o jsonpath='{.status.readyReplicas}{"\n"}' | grep -q '^1$' \
  && echo "operator ready" || { echo "operator NOT ready"; false; }
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `Error from server (NotFound): deployments.apps "prometheus-operator" not found`,
then `operator NOT ready`

- [ ] **Step 3: Confirm the CRD version we vendor against**

```bash
kubectl get crd prometheuses.monitoring.coreos.com \
  -o jsonpath='{.metadata.annotations.operator\.prometheus\.io/version}{"\n"}'
```

Expected: `0.92.0`. **If it prints anything else, change `OPVER` in the next step to match.** Running an
operator older than its CRDs silently ignores newer fields; running one newer can fail to reconcile.

- [ ] **Step 4: Vendor the operator manifests, stripping the CRDs**

The CRDs are already installed, and the upstream bundle's CRDs are large enough that a client-side
`kubectl apply` fails with `metadata.annotations: Too long`. We keep only the operator's own objects and
retarget them at our namespace.

```bash
OPVER=0.92.0
curl -sfL "https://github.com/prometheus-operator/prometheus-operator/releases/download/v${OPVER}/bundle.yaml" \
  -o /tmp/po-bundle.yaml

python3 - "$NS" <<'PY'
import sys, pathlib
ns = sys.argv[1]
docs = pathlib.Path('/tmp/po-bundle.yaml').read_text().split('\n---\n')
kept = [d for d in docs if d.strip() and 'kind: CustomResourceDefinition' not in d]
out = '\n---\n'.join(d.replace('namespace: default', f'namespace: {ns}') for d in kept)
header = (
    "# Vendored from prometheus-operator bundle.yaml, CustomResourceDefinitions removed\n"
    "# (already installed on this cluster) and namespace retargeted.\n"
    "# Regenerate with the command in docs-internal/plans/2026-08-08-phase-0-1-backend-and-dcgm.md Task 3.\n"
)
pathlib.Path('deploy/a30-node/20-prometheus-operator.yaml').write_text(header + out + '\n')
print("kinds kept:", sorted({l.split(': ',1)[1].strip()
      for d in kept for l in d.splitlines() if l.startswith('kind: ')}))
PY
```

Expected output: `kinds kept: ['ClusterRole', 'ClusterRoleBinding', 'Deployment', 'Service', 'ServiceAccount']`

Verify no CRDs and no stray namespace survived:

```bash
grep -c "kind: CustomResourceDefinition" deploy/a30-node/20-prometheus-operator.yaml || true
grep -c "namespace: default" deploy/a30-node/20-prometheus-operator.yaml || true
```

Expected: `0` from both (`grep -c` prints `0` and exits non-zero, which the `|| true` absorbs).

- [ ] **Step 5: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/a30-node/20-prometheus-operator.yaml
kubectl -n "$NS" rollout status deploy/prometheus-operator --timeout=180s
kubectl -n "$NS" get deploy prometheus-operator \
  -o jsonpath='{.status.readyReplicas}{"\n"}' | grep -q '^1$' && echo "operator ready"
```

Expected: PASS — `deployment "prometheus-operator" successfully rolled out`, then `operator ready`

- [ ] **Step 6: Stage and request commit approval**

```bash
git add deploy/a30-node/20-prometheus-operator.yaml
git diff --cached --stat
# suggested message: "add Prometheus Operator manifests (v0.92.0, CRDs excluded)"
```

---

### Task 4: Prometheus instance

**Files:**
- Create: `deploy/a30-node/21-prometheus.yaml`

- [ ] **Step 1: Write the failing test**

```bash
kubectl -n "$NS" get sts prometheus-gpu \
  -o jsonpath='{.status.readyReplicas}{"\n"}' | grep -q '^1$' \
  && ./scripts/promq.sh 'up' \
  || { echo "prometheus NOT ready"; false; }
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `statefulsets.apps "prometheus-gpu" not found`, then `prometheus NOT ready`

- [ ] **Step 3: Write the manifest**

`deploy/a30-node/21-prometheus.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: gpu
  namespace: gpu-monitoring
spec:
  serviceAccountName: prometheus-gpu
  replicas: 1
  scrapeInterval: 15s
  retention: 7d
  retentionSize: 10GB
  # No `storage:` block — the operator falls back to emptyDir. Metrics are
  # stateless; only history is lost on a restart, which is acceptable during
  # build-out. A local PersistentVolume replaces this before Phase 3, and the
  # default network-filesystem StorageClass must never be used for a TSDB.
  serviceMonitorSelector:
    matchLabels:
      app.kubernetes.io/part-of: gpu-monitoring
  # podMonitorSelector, probeSelector and scrapeConfigSelector are deliberately
  # left unset: a nil selector selects nothing, so no unrelated object can join
  # this Prometheus's target set.
  resources:
    requests:
      memory: 1Gi
      cpu: 200m
    limits:
      memory: 2Gi
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    fsGroup: 65534
```

> The operator creates a `prometheus-operated` Service automatically; no Service of our own is needed.

- [ ] **Step 4: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/a30-node/21-prometheus.yaml
kubectl -n "$NS" rollout status sts/prometheus-gpu --timeout=180s
./scripts/promq.sh 'up'
```

Expected: PASS — at least one `up` series (Prometheus scrapes itself).
If the StatefulSet never appears, the operator is not reconciling; re-check Task 3.

- [ ] **Step 5: Stage and request commit approval**

```bash
git add deploy/a30-node/21-prometheus.yaml
git diff --cached --stat
# suggested message: "add Prometheus instance"
```

---

### Task 5: Grafana

**Files:**
- Create: `deploy/a30-node/22-grafana.yaml`

- [ ] **Step 1: Write the failing test**

```bash
kubectl -n "$NS" rollout status deploy/grafana --timeout=10s >/dev/null 2>&1 \
  && kubectl -n "$NS" exec deploy/grafana -- \
       wget -qO- http://127.0.0.1:3000/api/health | grep -q '"database": *"ok"' \
  && echo "grafana healthy" || { echo "grafana NOT healthy"; false; }
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `grafana NOT healthy`

- [ ] **Step 3: Write the manifest**

`deploy/a30-node/22-grafana.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: gpu-monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
      - name: gpu-prometheus
        uid: gpu-prometheus
        type: prometheus
        access: proxy
        url: http://prometheus-operated.gpu-monitoring.svc:9090
        isDefault: true
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-provider
  namespace: gpu-monitoring
data:
  provider.yaml: |
    apiVersion: 1
    providers:
      - name: gpu-monitoring
        orgId: 1
        folder: GPU
        type: file
        disableDeletion: false
        allowUiUpdates: true
        options:
          path: /var/lib/grafana/dashboards
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: gpu-monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 472
        fsGroup: 472
      containers:
        - name: grafana
          image: grafana/grafana:11.6.1
          ports:
            - name: http
              containerPort: 3000
          env:
            - name: GF_AUTH_ANONYMOUS_ENABLED
              value: "true"
            - name: GF_AUTH_ANONYMOUS_ORG_ROLE
              value: "Viewer"
            - name: GF_USERS_DEFAULT_THEME
              value: "light"
          resources:
            requests:
              memory: 256Mi
              cpu: 100m
            limits:
              memory: 512Mi
          volumeMounts:
            - name: datasources
              mountPath: /etc/grafana/provisioning/datasources
            - name: dashboard-provider
              mountPath: /etc/grafana/provisioning/dashboards
            - name: dashboards
              mountPath: /var/lib/grafana/dashboards
            - name: storage
              mountPath: /var/lib/grafana
          readinessProbe:
            httpGet:
              path: /api/health
              port: http
            initialDelaySeconds: 10
      volumes:
        - name: datasources
          configMap:
            name: grafana-datasources
        - name: dashboard-provider
          configMap:
            name: grafana-dashboard-provider
        - name: dashboards
          configMap:
            name: grafana-dashboard-gpu-compute
            optional: true
        - name: storage
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: gpu-monitoring
spec:
  selector:
    app: grafana
  ports:
    - name: http
      port: 3000
      targetPort: http
```

> `dashboards` is mounted `optional: true` so Grafana starts before Task 12 creates that ConfigMap.
> `storage` is an `emptyDir` mounted at `/var/lib/grafana`, which is why the dashboards mount sits at
> `/var/lib/grafana/dashboards` — a subdirectory of it, provided by the ConfigMap volume.

- [ ] **Step 4: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/a30-node/22-grafana.yaml
kubectl -n "$NS" rollout status deploy/grafana --timeout=180s
kubectl -n "$NS" exec deploy/grafana -- \
  wget -qO- http://127.0.0.1:3000/api/health | grep -q '"database": *"ok"' && echo "grafana healthy"
```

Expected: PASS — `grafana healthy`.
If the pod is `ImagePullBackOff`, the pinned tag is unavailable from this cluster; pick a current
`grafana/grafana` 11.x or 12.x tag, update the manifest, and re-apply.

- [ ] **Step 5: Verify the datasource actually resolves**

```bash
kubectl -n "$NS" exec deploy/grafana -- \
  wget -qO- 'http://127.0.0.1:3000/api/datasources/uid/gpu-prometheus' | head -c 200; echo
```

Expected: JSON containing `"type":"prometheus"` and the `prometheus-operated` URL. An empty or 404 response
means provisioning did not load — check the ConfigMap mount path.

- [ ] **Step 6: Stage and request commit approval**

```bash
git add deploy/a30-node/22-grafana.yaml
git diff --cached --stat
# suggested message: "add Grafana with provisioned Prometheus datasource"
```

---

### Task 6: Scrape the existing DCGM exporter

This is the end-to-end proof for Phase 0: a real GPU metric, in Prometheus, carrying the normalized label.

**Files:**
- Create: `deploy/a30-node/50-servicemonitor-dcgm.yaml`

- [ ] **Step 1: Write the failing test**

```bash
# Every DCGM_FI_DEV_GPU_UTIL series must carry BOTH the original UUID label
# and the normalized gpu_uuid label. The count of series with gpu_uuid set
# must equal the count of series overall, and must be non-zero.
./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL) and count(DCGM_FI_DEV_GPU_UTIL{gpu_uuid!="",UUID!=""})'
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — `(empty result)`. Nothing is scraping the DCGM exporter yet.

- [ ] **Step 3: Confirm the target service's identity before selecting it**

```bash
kubectl -n "$DCGM_NS" get svc -l app=nvidia-dcgm-exporter \
  -o jsonpath='{range .items[*]}{.metadata.name}{" ports="}{.spec.ports[*].name}{"\n"}{end}'
```

Expected: one service, with a named port. **Record the port name — the next step must use it verbatim.**
If the label or port name differs on your cluster, adjust the manifest to match rather than renaming
anything on the exporter.

- [ ] **Step 4: Write the manifest**

`deploy/a30-node/50-servicemonitor-dcgm.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gpu-dcgm
  namespace: gpu-monitoring
  labels:
    app.kubernetes.io/part-of: gpu-monitoring   # matched by the Prometheus CR
spec:
  namespaceSelector:
    matchNames: ["gpu-operator"]
  selector:
    matchLabels:
      app: nvidia-dcgm-exporter
  endpoints:
    - port: gpu-metrics
      interval: 15s
      honorLabels: true
      # metricRelabelings, NOT relabelings. `relabelings` act on target labels
      # discovered from Kubernetes; UUID and Hostname are labels on the exposed
      # metrics themselves, so they are only visible at metric-relabel time.
      metricRelabelings:
        # Copy, never rename. `replace` writes the target label and leaves the
        # source label in place — dropping it would break any existing query,
        # dashboard or alert that references it.
        - sourceLabels: [UUID]
          targetLabel: gpu_uuid
          action: replace
        - sourceLabels: [Hostname]
          targetLabel: node
          action: replace
```

- [ ] **Step 5: Apply and run the test to verify it passes**

```bash
kubectl apply -f deploy/a30-node/50-servicemonitor-dcgm.yaml
sleep 30   # allow the operator to regenerate config and Prometheus to scrape
./scripts/promq.sh 'count(DCGM_FI_DEV_GPU_UTIL) and count(DCGM_FI_DEV_GPU_UTIL{gpu_uuid!="",UUID!=""})'
```

Expected: PASS — one line with a value equal to the number of GPUs in the cluster.
If it prints `(empty result)`, check the target is up: `./scripts/promq.sh 'up{job="nvidia-dcgm-exporter"}'`.

- [ ] **Step 6: Verify the original label survived**

```bash
./scripts/promq.sh 'DCGM_FI_DEV_GPU_UTIL' | head -2
```

Expected: each line shows **both** `UUID=GPU-...` and `gpu_uuid=GPU-...` with identical values, plus `node=`.
A missing `UUID` means the relabeling renamed instead of copied — fix before continuing, since this is the
failure mode that silently breaks divisions and alerts that match on the full label set.

- [ ] **Step 7: Stage and request commit approval**

```bash
git add deploy/a30-node/50-servicemonitor-dcgm.yaml
git diff --cached --stat
# suggested message: "scrape existing DCGM exporter, normalize device UUID label"
```



## Phase 0 exit criteria

- [ ] The Prometheus Operator **controller** is running, not merely its CRDs (Task 3)
- [ ] Prometheus answers queries (Task 4)
- [ ] Grafana is healthy and its datasource resolves (Task 5)
- [ ] `DCGM_FI_DEV_GPU_UTIL` carries **both** `UUID` and `gpu_uuid` (Task 6)

Storage is `emptyDir` at this phase — a recorded, temporary choice. A local PersistentVolume replaces it
before Phase 3, and the default network-filesystem StorageClass must never hold a TSDB.

**Next:** [Phase 1 — DCGM field list](2026-08-09-phase-1-dcgm.md)
