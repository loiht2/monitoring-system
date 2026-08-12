# Dashboard Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commit policy.** `CLAUDE.md` states *"Do not automatically commit until I approve."* Each "Commit" step
> means stage, show the diff, and ask. Messages carry no AI co-author trailer.

**Goal:** Replace the two current dashboards with three — device-level hardware, MIG-level hardware, and
eBPF software — each panel named for its field and described with NVIDIA's own definition.

**Architecture:** The metric catalog is the single source of truth; dashboards are generated to match it, and
a checker script enforces that they do. Nothing about collection changes: no exporter, ServiceMonitor or
recording rule is touched.

**Tech Stack:** Grafana dashboard JSON, Prometheus, `scripts/promq.sh`, python3 for generation and checks.

**Supersedes:** the dashboard tasks in [phase 1](2026-08-09-phase-1-dcgm.md) Task 6 and
[phase 3](2026-08-09-phase-3-ebpf.md) Task 8. Those plans stay as the record of how the data got collected;
this one owns how it is presented.

---

## Scope

**In:** `docs-internal/02-metric-catalog.md` (already replaced), three dashboard JSON files, the Grafana
mounts, and a checker script.

**Out:** collection. The "Scheduler Accounting (HAMi)" row is deleted as redundant — no `GPUDevice*` metric
appears on any dashboard — but the HAMi ServiceMonitor stays and the metrics keep flowing.

**Decisions already approved, do not revisit:** three dashboards; panel lists exactly as catalog §1 and §2;
descriptions are vendor definitions only; Metric Support Matrix and `gpu_metric_supported` are **kept**;
Entitlement table is **kept**; Scheduler Accounting is **deleted**.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs-internal/02-metric-catalog.md` | Source of truth: panel names, definitions, metric names, availability. **Already written** |
| `scripts/check-dashboards.py` | Enforces the catalog contract against the JSON. The test |
| `dashboards/gpu-hardware-device.json` | Whole-card view, 6 rows |
| `dashboards/gpu-hardware-mig.json` | Per-instance view, 3 rows |
| `dashboards/gpu-software.json` | eBPF view. Exists; only title and uid change |
| `deploy/a30-node/22-grafana.yaml` | One volume mount per dashboard ConfigMap |

Deleted: `dashboards/gpu-hardware.json`.

---

### Task 1: The checker — write the test before any dashboard

The checker is this plan's test suite. Every later task is "make the checker pass".

**Files:**
- Create: `scripts/check-dashboards.py`

- [ ] **Step 1: Write the checker**

```python
#!/usr/bin/env python3
"""Enforce the catalog contract on dashboard JSON. Usage: check-dashboards.py <file>..."""
import json, re, sys, itertools

def leaves(panels):
    for p in panels:
        if p.get("type") == "row":
            yield from leaves(p.get("panels", []))
        else:
            yield p

def metric_names(dash):
    names = set()
    for p in leaves(dash["panels"]):
        for t in p.get("targets", []):
            names |= set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*(?:_total|_bytes|_seconds|_ratio|_active|"
                                    r"_hertz|_watts|_celsius|_info|_supported)\b", t.get("expr", "")))
            names |= set(re.findall(r"\bDCGM_FI_[A-Z0-9_]+\b", t.get("expr", "")))
    return names

def check(paths):
    fail = []
    dashes = {p: json.load(open(p)) for p in paths}
    shared = {}
    for path, d in dashes.items():
        ls = list(leaves(d["panels"]))
        for p in ls:
            if not p.get("title"):
                fail.append(f"{path}: panel id={p.get('id')} has no title")
            if not p.get("description"):
                fail.append(f"{path}: '{p.get('title')}' has no description")
        # (b) no title is a metric name
        for p in ls:
            if p.get("title") in metric_names(d):
                fail.append(f"{path}: title '{p['title']}' is a metric name")
        # (d) no overlapping panels, per layer
        layers = [d["panels"]] + [r.get("panels", []) for r in d["panels"] if r.get("type") == "row"]
        for layer in layers:
            for a, b in itertools.combinations([p for p in layer if p.get("type") != "row"], 2):
                ga, gb = a["gridPos"], b["gridPos"]
                if (ga["x"] < gb["x"] + gb["w"] and gb["x"] < ga["x"] + ga["w"]
                        and ga["y"] < gb["y"] + gb["h"] and gb["y"] < ga["y"] + ga["h"]):
                    fail.append(f"{path}: '{a['title']}' overlaps '{b['title']}'")
        # (c) collect shared descriptions
        for p in ls:
            shared.setdefault(p["title"], {})[path] = p["description"]
        # (e) MIG panels must filter to instances
        if "mig" in path:
            for p in ls:
                exprs = " ".join(t.get("expr", "") for t in p.get("targets", []))
                if exprs and 'GPU_I_ID!=""' not in exprs and 'mig_uuid!=""' not in exprs:
                    fail.append(f"{path}: '{p['title']}' is not filtered to MIG instances")
        # (f) no HAMi metrics anywhere
        for p in ls:
            for t in p.get("targets", []):
                if "GPUDevice" in t.get("expr", ""):
                    fail.append(f"{path}: '{p['title']}' references a GPUDevice* metric")
    # (c) shared titles must have identical descriptions
    for title, byfile in shared.items():
        if len(byfile) > 1 and len(set(byfile.values())) > 1:
            fail.append(f"description for '{title}' differs across dashboards")
    return fail

if __name__ == "__main__":
    problems = check(sys.argv[1:])
    for p in problems:
        print("FAIL:", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)
```

- [ ] **Step 2: Run it against the current dashboards to prove it detects something**

```bash
cd /home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/phase-4-mig
python3 scripts/check-dashboards.py dashboards/gpu-hardware.json dashboards/gpu-software.json
```

Expected: a non-zero problem count and exit 1. The current `gpu-hardware.json` carries a Scheduler Accounting
row referencing `GPUDevice*`, which check (f) must catch. **If it exits 0, the checker is broken — fix it
before continuing**, because every later task depends on it failing honestly.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-dashboards.py
git diff --cached --stat
# suggested message: "add dashboard contract checker"
```

---

### Task 2: Device dashboard

**Files:**
- Create: `dashboards/gpu-hardware-device.json`

- [ ] **Step 1: Run the checker to see it fail**

```bash
python3 scripts/check-dashboards.py dashboards/gpu-hardware-device.json
```

Expected: FAIL — `No such file or directory`.

- [ ] **Step 2: Build it**

uid `gpu-hardware-device`, title `GPU Hardware — Device`. Template variable `$gpu` over
`label_values(gpu_uuid)`, includeAll + multi. Rows in order, first expanded, rest collapsed:

| Row | Panels (catalog § 1) |
|---|---|
| Performance | GPU Utilization, GPU Utilization per Pod, SM Activity, SM Occupancy, Tensor Core Utilization, FP & Integer Utilization, DRAM Activity, L2 Cache Hit Rates, L2 Cache Miss Rates |
| Memory | Memory Used vs Total, Memory Used Over Time, Memory Held by Each Pod |
| Data Transfer | PCIe Throughput, NVLink Throughput, Chip-to-Chip Bandwidth |
| Power & Thermals | GPU Power Usage, GPU Temperature |
| Clocks | Clock Frequencies, Clock Throttle Reasons |
| Allocation & Support | Entitlement, Metric Support Matrix |

Rules:
- **Descriptions are the catalog's definition text verbatim, and nothing else.** The only permitted addition
  is a final short sentence naming a hardware requirement where the catalog's Availability column states one
  (`Requires NVLink-equipped GPUs.`, `Requires a Grace-coupled platform.`).
- **Every nvml_* panel filters `mig_uuid=""`.** A partitioned card reports a parent row and an instance row;
  without the filter, summing by `gpu_uuid` credits it more memory than it has.
- The three Memory panels and GPU Temperature are carried over from `dashboards/gpu-hardware.json`
  unchanged apart from that filter — the user confirmed they are good as they are.
- Panel types follow [11 § 2](../11-dashboards.md): `gauge` for bounded current values, `bargauge` to compare
  across cards, `state-timeline` for throttle reasons, `table` for Entitlement and the Support Matrix,
  `timeseries` for the rest.
- Units: `percentunit` for 0-1 ratios, `bytes`, `Bps` for throughput, `watt`, `celsius`, `hertz`.

- [ ] **Step 3: Run the checker to see it pass**

```bash
python3 scripts/check-dashboards.py dashboards/gpu-hardware-device.json
```

Expected: `0 problem(s)` and exit 0.

- [ ] **Step 4: Verify every query against live Prometheus**

```bash
./../phase-0-backend/scripts/promq.sh '<each distinct expr>'
```

Classify each result: **DATA** (returns series), **IDLE** (exists per
`count_over_time(<metric>[24h])` but nothing running), **UNAVAILABLE** (hardware cannot produce it — L2 cache,
NVLink, C2C, integer pipe, per catalog). A query returning nothing for any *other* reason is wrong and must be
fixed; do not file a broken query under UNAVAILABLE.

- [ ] **Step 5: Commit**

```bash
git add dashboards/gpu-hardware-device.json
# suggested message: "add device-level hardware dashboard"
```

---

### Task 3: MIG dashboard

**Files:**
- Create: `dashboards/gpu-hardware-mig.json`

- [ ] **Step 1: Run the checker to see it fail**

```bash
python3 scripts/check-dashboards.py dashboards/gpu-hardware-mig.json
```

Expected: FAIL — file does not exist.

- [ ] **Step 2: Build it**

uid `gpu-hardware-mig`, title `GPU Hardware — MIG`. Rows, first expanded, rest collapsed:

| Row | Panels (catalog § 2) |
|---|---|
| Performance | GPU Utilization, SM Efficiency, SM Occupancy, Tensor Core Utilization, FP & Integer Utilization |
| Memory | Memory Used vs Total, Memory Used Over Time, Memory Held by Each Pod |
| Support | Metric Support Matrix |

Rules:
- **Every panel filters to instance series**: DCGM panels `{GPU_I_ID!=""}`, NVML panels `{mig_uuid!=""}`.
  Check (e) enforces this.
- Legends identify the instance — `{{GPU_I_PROFILE}}` or `{{mig_uuid}}` — not just the parent card.
- **Descriptions for fields that also appear on the device dashboard must be byte-identical.** Check (c)
  enforces this. Scope is stated once in the dashboard description, not repeated per panel.
- Add to the dashboard description: utilization here is normalized to the instance, not the card
  (catalog § 4), so instance values must never be summed into a device figure.

- [ ] **Step 3: Run the checker across BOTH hardware dashboards**

```bash
python3 scripts/check-dashboards.py dashboards/gpu-hardware-device.json dashboards/gpu-hardware-mig.json
```

Expected: `0 problem(s)`. This is the run that proves shared descriptions match.

- [ ] **Step 4: Verify every query against live Prometheus**

Same three-way classification as Task 2. On this fleet exactly one instance exists (`1g.6gb` on GPU 1), so
each MIG panel should return at most one series.

- [ ] **Step 5: Commit**

```bash
git add dashboards/gpu-hardware-mig.json
# suggested message: "add mig-level hardware dashboard"
```

---

### Task 4: Retire the old dashboard and align the eBPF one

**Files:**
- Delete: `dashboards/gpu-hardware.json`
- Modify: `dashboards/gpu-software.json` (title and uid only)

- [ ] **Step 1: Delete the superseded file**

```bash
git rm dashboards/gpu-hardware.json
```

Its content is now split between the device and MIG dashboards; the Scheduler Accounting row is dropped
deliberately.

- [ ] **Step 2: Align the eBPF dashboard's identity**

Set `"title": "GPU Software — eBPF"` and keep `"uid": "gpu-software"`. **Change nothing else** — its rows,
panels and queries were approved and verified.

- [ ] **Step 3: Run the checker over all three**

```bash
python3 scripts/check-dashboards.py dashboards/*.json
```

Expected: `0 problem(s)`.

- [ ] **Step 4: Commit**

```bash
git add -A dashboards/
# suggested message: "retire the merged hardware dashboard"
```

---

### Task 5: Deploy

**Files:**
- Modify: `deploy/a30-node/22-grafana.yaml`

- [ ] **Step 1: Write the failing test**

```bash
kubectl -n gpu-monitoring exec deploy/grafana -- \
  wget -qO- 'http://127.0.0.1:3000/api/search?type=dash-db' | python3 -c "
import sys,json; got={d['uid'] for d in json.load(sys.stdin)}
want={'gpu-hardware-device','gpu-hardware-mig','gpu-software'}
print('missing:', want-got, '| extra:', got-want)
raise SystemExit(0 if got==want else 1)"
```

Expected: FAIL — `gpu-hardware` still present, the two new uids missing.

- [ ] **Step 2: Create one ConfigMap per dashboard**

```bash
for n in gpu-hardware-device gpu-hardware-mig gpu-software; do
  kubectl -n gpu-monitoring create configmap "grafana-dashboard-$n" \
    --from-file="$n.json=dashboards/$n.json" --dry-run=client -o yaml | kubectl apply -f -
done
kubectl -n gpu-monitoring delete configmap grafana-dashboard-gpu-hardware
```

- [ ] **Step 3: Give each ConfigMap its own mount**

In `deploy/a30-node/22-grafana.yaml`, replace the `dash-gpu-hardware` mount and volume with
`dash-gpu-hardware-device` and `dash-gpu-hardware-mig`, keeping `dash-gpu-software`. Each mounts at
`/var/lib/grafana/dashboards/<name>`.

**A configMap volume replaces its whole mount path rather than merging**, so two dashboards sharing one mount
means the second hides the first. One mount per ConfigMap is not optional.

```bash
kubectl apply -f deploy/a30-node/22-grafana.yaml
kubectl -n gpu-monitoring rollout restart deploy/grafana
kubectl -n gpu-monitoring rollout status deploy/grafana --timeout=150s
```

- [ ] **Step 4: Run the test to verify it passes**

Re-run the Step 1 command. Expected: `missing: set() | extra: set()` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add deploy/a30-node/22-grafana.yaml
# suggested message: "mount the three dashboards"
```

---

### Task 6: Verify against a live workload

Panels are only proven by data flowing through them.

- [ ] **Step 1: Start a GPU workload**

```bash
kubectl apply -f deploy/a30-node/90-loadgen-gpu-burn.yaml
kubectl -n gpu-burn wait --for=condition=Ready pod/gpu-burn-a --timeout=300s
```

- [ ] **Step 2: Confirm each dashboard renders real data through Grafana's own proxy**

For one representative panel per row, query through Grafana rather than Prometheus directly, so the datasource
wiring is exercised too:

```bash
kubectl -n gpu-monitoring exec deploy/grafana -- wget -qO- \
  'http://127.0.0.1:3000/api/datasources/proxy/uid/gpu-prometheus/api/v1/query?query=DCGM_FI_PROF_SM_ACTIVE'
```

Expected: a non-empty `result` array for Performance, Memory, Power and Clocks on the device dashboard, and
for Performance and Memory on the MIG dashboard.

- [ ] **Step 3: Confirm the device dashboard does not double-count the partitioned card**

```bash
./../phase-0-backend/scripts/promq.sh 'count(count by (gpu_uuid) (nvml_gpu_memory_total_bytes{mig_uuid=""}))'
```

Expected: `2` — the node has two physical cards. A `3` means a `mig_uuid=""` filter is missing somewhere and
the MIG instance is being counted as a third GPU.

- [ ] **Step 4: Tear down**

```bash
kubectl delete -f deploy/a30-node/90-loadgen-gpu-burn.yaml --wait=false
```

- [ ] **Step 5: Commit**

```bash
git add -A
# suggested message: "reorganize dashboards into device, mig and software"
```

---

### Task 7: DCGM support verdicts per MIG instance

The DCGM recording rule groups by `gpu_uuid` alone, so it emits one verdict per card and none per instance. On
a partitioned card a blank DCGM panel cannot be told from an unsupported one.

**Files:** `deploy/a30-node/60-prometheusrule-metric-support.yaml`, `deploy/production/60-…`

- [ ] **Step 1: Write the failing test**

```bash
../phase-0-backend/scripts/promq.sh 'count(gpu_metric_supported{source="dcgm", GPU_I_ID!=""})'
```

Expected: `(empty result)`.

- [ ] **Step 2: Group by entity in all 13 rules**

```promql
(
  group by (gpu_uuid, GPU_I_ID) (<FIELD>)
  or
  group by (gpu_uuid, GPU_I_ID) (DCGM_FI_DEV_FB_USED) * 0
)
and on() (max(up{job="nvidia-dcgm-exporter"}) == 1)
```

`DCGM_FI_DEV_FB_USED` already emits one row per entity, so evidence and field line up.

- [ ] **Step 3: Apply, wait one 30s evaluation, re-run the test**

Expected: non-zero.

- [ ] **Step 4: Commit** — `derive dcgm support verdicts per mig instance`

---

### Task 8: Device dashboard rebuilt to the new catalog

**Files:** `dashboards/gpu-hardware-device.json`

- [ ] **Step 1: Extend the checker, and watch the new check fail**

Add to `scripts/check-dashboards.py`: the device dashboard may reference `nvml_*` **only** for the three
panels catalog § 0 keeps on NVML — GPU Utilization per Pod, Memory Held by Each Pod, Clocks Throttle Reasons.
Any other `nvml_` reference is a failure.

```bash
python3 scripts/check-dashboards.py dashboards/gpu-hardware-device.json
```

Expected: FAIL — today's device dashboard plots `nvml_gpu_utilization_ratio`, memory, power, temperature and
clocks.

- [ ] **Step 2: Rebuild the rows** per catalog § 1

| Row | Panels |
|---|---|
| Performance | GPU Utilization, GPU Utilization per Pod, SM Activity, SM Occupancy, Tensor Core Utilization, FP & Integer Utilization, Cache Hit Rates, Cache Miss Rates |
| Memory | Memory Used vs Total, Memory Used Over Time, Memory Held by Each Pod, **Memory Bandwidth Utilization** |
| Interconnect | PCIe Transmission Throughput, NVLink Transmission Throughput, Chip to Chip Bandwidth |
| Power & Thermals | GPU Power Usage, GPU Temperature |
| Clocks | Clock Frequencies, Clocks Throttle Reasons |
| Allocation & Support | Entitlement, Metric Support Matrix |

`FB_USED`/`FB_FREE` are **MiB** — multiply by 1048576 for any bytes-unit panel. Device panels exclude MIG
instance rows.

- [ ] **Step 3: Checker passes, then verify every query live** — classify DATA / IDLE / UNAVAILABLE.

- [ ] **Step 4: Commit** — `rebuild the device dashboard on dcgm`

---

### Task 9: MIG dashboard rebuilt

**Files:** `dashboards/gpu-hardware-mig.json`

- [ ] **Step 1: Run the checker, see the same NVML violation**
- [ ] **Step 2: Rebuild** per catalog § 2

| Row | Panels |
|---|---|
| Performance | GPU Utilization, SM Efficiency, SM Occupancy, Tensor Core Utilization, FP & Integer Utilization |
| Memory | Memory Used vs Total, Memory Used Over Time, Memory Held by Each Pod, Memory Bandwidth Utilization |
| Support | Metric Support Matrix |

Every panel filters to instances. Shared descriptions stay byte-identical to the device dashboard — the
checker compares only panels backed by the same metric, so `GPU Utilization` may legitimately differ
(`GR_ENGINE_ACTIVE` here, `DEV_GPU_UTIL` there).

- [ ] **Step 3: Checker passes over both dashboards together**
- [ ] **Step 4: Commit** — `rebuild the mig dashboard on dcgm`

---

### Task 10: Deploy and verify under load

- [ ] **Step 1:** re-create the two ConfigMaps and restart Grafana
- [ ] **Step 2:** `kubectl apply -f deploy/a30-node/90-loadgen-gpu-burn.yaml`
- [ ] **Step 3:** one representative panel per row returns data through Grafana's proxy
- [ ] **Step 4:** the device matrix and device memory panels correctly reflect DCGM's own scoping.

  This check changed shape from the NVML-era draft. NVML enumerates the MIG parent handle regardless of MIG
  mode, so an NVML-sourced device count needed a `mig_uuid=""` filter to avoid double-counting a partitioned
  card as two GPUs. **DCGM does not enumerate a device-scope row for a partitioned card at all** — it reports
  only the instance entity. So for the DCGM-sourced panels built in Task 8, the correct device-scope count on
  this fleet (one whole card, one partitioned card) is **1, not 2** — the partitioned card is correctly
  absent from device scope, which is exactly what the support matrix's skip rule (§0, doc 10 §4.1) describes.
  Verify:

  ```bash
  ../phase-0-backend/scripts/promq.sh 'count(count by (gpu_uuid) (DCGM_FI_DEV_FB_USED{GPU_I_ID=""}))'
  ```

  Expected: `1` — the whole card only. The MIG dashboard is where the partitioned card's memory appears
  (`DCGM_FI_DEV_FB_USED{GPU_I_ID!=""}`).
- [ ] **Step 5:** MIG matrix now shows **both** `nvml` and `dcgm` sources
- [ ] **Step 6:** tear down, commit

**No ConfigMap change is required.** Every field the new catalog plots is already collected; the only
uncollected names are the nine hardware-gated ones, which stay out deliberately.

---

## Self-review

**Spec coverage.** Catalog §1 → Task 2. §2 → Task 3. §3 (eBPF) → Task 4 Step 2, identity only, since that
dashboard was already built and verified. §1.6 Entitlement and Support Matrix → Task 2's last row. §4
instance normalization → Task 3's dashboard description. §5 absent-never-zero needs no panel; it is a
collection property.

**Deletions.** Scheduler Accounting is removed by Task 4 Step 1 deleting the file that holds it, and check (f)
prevents it being reintroduced.

**Consistency.** Shared definitions are enforced mechanically by check (c) rather than by review, because that
is the requirement most likely to rot as panels get edited.
