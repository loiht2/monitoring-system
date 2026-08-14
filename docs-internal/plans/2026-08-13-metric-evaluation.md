# Metric Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every one of the 53 dashboard metrics a recorded verdict — Observed, Unsupported, or Unverified — and eliminate the Unverified class.

**Architecture:** Two small CUDA exerciser images drive one hardware pipe or one CUDA API family at a time. A shell driver runs each as a Kubernetes Job, records the exact time window, and a Python classifier asks Prometheus what appeared inside it. Three UI/config defects that hide missing metrics are fixed first, so the evaluation's results are visible.

**Tech Stack:** CUDA 12 + cuBLAS, Kubernetes Jobs, HAMi resources, bash, Python 3 + httpx, TypeScript/React for the UI fixes, vitest and pytest.

**Spec:** [14 — Metric evaluation and coverage](../14-metric-evaluation.md). Section references point there.

---

## Working directory

`/home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/feature-monitoring-ui`.

UI commands from `services/advanced-monitoring-ui/`: `npm test`, `npx tsc --noEmit`, `npx next build`.
Python from the repo root with `source .venv/bin/activate` (note: `python3` on PATH has no pytest; the venv does).

**Do not modify `/home/ubuntu/loiht2/test/deep-learning-workloads`.** It is a separate HAMi fairness harness
with its own experiment provenance (§4.1).

---

## File structure

**New:**

| File | Responsibility |
|---|---|
| `evaluation/run.sh` | Phase driver: apply Job, wait, record `[t0,t1]`, delete |
| `evaluation/report.py` | Classify every (metric, entity) per window; Markdown + JSON out |
| `evaluation/test_report.py` | Unit tests for the classifier (pure) |
| `evaluation/metrics.json` | The 53 metrics, generated from `panels.json` |
| `evaluation/workloads/pipe-exerciser/{Dockerfile,main.cu}` | One compute pipe at a time |
| `evaluation/workloads/api-exerciser/{Dockerfile,main.cu}` | One CUDA API family at a time |
| `evaluation/manifests/job-template.yaml` | Job template, `envsubst`-filled |
| `services/advanced-monitoring-ui/lib/panelSupport.ts` | Per-series support + partitioned resolution (pure) |
| `services/advanced-monitoring-ui/lib/panelSupport.test.ts` | Its tests |

**Modified:** `deploy/a30-node/30-dcgm-counters.yaml`, `deploy/production/30-dcgm-counters.yaml`,
`deploy/a30-node/60-prometheusrule-metric-support.yaml`, `deploy/production/60-prometheusrule-metric-support.yaml`,
`components/PanelFrame.tsx`, `components/Legend.tsx`, `components/panels/TimeSeriesPanel.tsx`,
`components/PanelGrid.tsx`, `app/page.tsx`, `docs-internal/10-metric-support-signal.md`.

---

## Task 1: Collect the DFMA tensor pipe

**Files:**
- Modify: `deploy/a30-node/30-dcgm-counters.yaml`, `deploy/production/30-dcgm-counters.yaml`
- Modify: `deploy/a30-node/60-prometheusrule-metric-support.yaml`, `deploy/production/60-prometheusrule-metric-support.yaml`

**Read [14 §2.2](../14-metric-evaluation.md) before touching this file.** An *unknown* DCGM field is fatal —
the exporter then serves nothing at all, silently dropping every other metric. `DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE`
is field **1015** in DCGM 4.5.0 and is safe; `DCGM_FI_PROF_DMMA_CYCLES_ACTIVE_TOTAL` does not exist and must
never be added. They are different identifiers.

- [ ] **Step 1: Record the current field count — this is the rollback tripwire**

```bash
kubectl -n gpu-operator get pod -l app=nvidia-dcgm-exporter -o name | head -1
# then, against Prometheus:
# Counts ACTIVELY SCRAPED series. Do NOT use /api/label/__name__/values for this: it
# answers from the retention window, so it keeps listing names long after the exporter
# has gone silent — showing a healthy count during exactly the outage this check exists
# to catch.
curl -s -G 'http://192.168.6.123:30802/api/query' \
  --data-urlencode 'q=count(count by (__name__) ({__name__=~"DCGM_.+"}))'
```
Write the number down. Expected today: the count of DCGM metrics currently served.

- [ ] **Step 2: Add the field, next to the other tensor pipes**

In **both** `30-dcgm-counters.yaml` files, after the `IMMA` line:

```
DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE,    gauge, Ratio of cycles the DFMA (FP64) tensor pipe is active.
```

Leave the `DMMA_CYCLES_ACTIVE_TOTAL` warning comment exactly as it is — it documents a different, genuinely
fatal identifier, and deleting it invites the mistake back.

- [ ] **Step 3: Add its support rule**

In **both** `60-prometheusrule-metric-support.yaml` files, copy the `PIPE_INT_ACTIVE` rule and change only
the metric name. The real shape is a `group by` + `or` fallback **with an exporter-up guard**:

```yaml
        - record: gpu_metric_supported
          expr: |
            (
              group by (gpu_uuid, GPU_I_ID) (DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE)
              or
              group by (gpu_uuid, GPU_I_ID) (DCGM_FI_DEV_FB_USED) * 0
            )
            and on() (max(up{job="nvidia-dcgm-exporter"}) == 1)
          labels:
            metric: DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE
            source: dcgm
```

**The `and on() (max(up…) == 1)` guard is load-bearing and must not be dropped.** Without it, a DCGM outage
is reported to operators as a hardware limitation — which is exactly what
[10 §3.2](../10-metric-support-signal.md)'s conditions 1 and 2 exist to prevent. An earlier draft of this
step omitted it.

- [ ] **Step 4: Apply and verify DCGM did not break — this is the load-bearing check**

```bash
kubectl apply -f deploy/a30-node/30-dcgm-counters.yaml
kubectl apply -f deploy/a30-node/60-prometheusrule-metric-support.yaml
kubectl -n gpu-operator rollout restart ds/nvidia-dcgm-exporter
kubectl -n gpu-operator rollout status ds/nvidia-dcgm-exporter --timeout=180s
sleep 60   # let a scrape land
# Counts ACTIVELY SCRAPED series. Do NOT use /api/label/__name__/values for this: it
# answers from the retention window, so it keeps listing names long after the exporter
# has gone silent — showing a healthy count during exactly the outage this check exists
# to catch.
curl -s -G 'http://192.168.6.123:30802/api/query' \
  --data-urlencode 'q=count(count by (__name__) ({__name__=~"DCGM_.+"}))'
```

The count must be **≥ Step 1's number**. If it collapsed to near zero, the field was rejected: revert
`30-dcgm-counters.yaml`, re-apply, restart, and stop — do not proceed.

- [ ] **Step 5: Check whether the A30 actually implements it**

```bash
curl -s -G 'http://192.168.6.123:30802/api/query' \
  --data-urlencode 'q=count(DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE)'
curl -s -G 'http://192.168.6.123:30802/api/query' \
  --data-urlencode 'q=gpu_metric_supported{metric="DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE"}'
```
Either result is a valid outcome — data means Observed, `0` means Unsupported. Both beat Unverified. Record
which one happened; Task 8's workload will exercise it properly.

---

## Task 2: Per-series support in the UI

Fixes [14 §2.1](../14-metric-evaluation.md): correct data rendered as a lie by omission.

**Files:**
- Create: `services/advanced-monitoring-ui/lib/panelSupport.ts`, `lib/panelSupport.test.ts`
- Modify: `components/Legend.tsx`, `components/panels/TimeSeriesPanel.tsx`

- [ ] **Step 1: Write the failing test**

`lib/panelSupport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { unsupportedTargets } from './panelSupport';

const TARGETS = [
  { expr: 'DCGM_FI_PROF_PIPE_FP64_ACTIVE{gpu_uuid=~"$gpu"}', legendFormat: '{{node}} · FP64' },
  { expr: 'DCGM_FI_PROF_PIPE_INT_ACTIVE{gpu_uuid=~"$gpu"}', legendFormat: '{{node}} · integer' },
];

describe('unsupportedTargets', () => {
  it('names a target whose metric is known unsupported', () => {
    const r = unsupportedTargets(TARGETS, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false });
    expect(r).toEqual(['integer']);
  });

  it('says nothing when support is merely unknown', () => {
    // Absent is Unverified, not Unsupported. Claiming "not supported" without a verdict
    // is the fabrication 10 §1 forbids.
    expect(unsupportedTargets(TARGETS, {})).toEqual([]);
  });

  it('says nothing when the metric is supported', () => {
    expect(unsupportedTargets(TARGETS, { DCGM_FI_PROF_PIPE_INT_ACTIVE: true })).toEqual([]);
  });

  it('uses the legend suffix after the separator, not the whole format string', () => {
    // "{{node}} gpu{{gpu}} · integer" -> "integer": the template vars cannot be resolved
    // without a series, and the suffix is the part that names the pipe.
    const t = [{ expr: 'DCGM_FI_PROF_PIPE_INT_ACTIVE', legendFormat: '{{node}} gpu{{gpu}} · integer' }];
    expect(unsupportedTargets(t, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false })).toEqual(['integer']);
  });

  it('falls back to the metric name when there is no legend format', () => {
    const t = [{ expr: 'DCGM_FI_PROF_PIPE_INT_ACTIVE', legendFormat: '' }];
    expect(unsupportedTargets(t, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false }))
      .toEqual(['DCGM_FI_PROF_PIPE_INT_ACTIVE']);
  });

  it('reports each unsupported target once even if it appears twice', () => {
    const t = [...TARGETS, TARGETS[1]];
    expect(unsupportedTargets(t, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false })).toEqual(['integer']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/advanced-monitoring-ui && npx vitest run lib/panelSupport.test.ts
```
Expected: FAIL — cannot resolve `./panelSupport`.

- [ ] **Step 3: Implement**

`lib/panelSupport.ts`:

```ts
import { extractMetricNames } from './support';

export interface TargetLike { expr: string; legendFormat: string }

/** Labels for the targets this panel plots that are KNOWN unsupported on the selected
 *  entities. A panel renders normally when any metric is supported, and names the ones
 *  that are not — otherwise a reader sees three of four pipes and concludes the fourth
 *  was idle. See 14 §3.1.
 *
 *  Only an explicit `false` qualifies. An absent verdict is Unverified, and asserting
 *  "not supported" without evidence is exactly what 10 §1 forbids. */
export function unsupportedTargets(
  targets: TargetLike[],
  supported: Record<string, boolean>,
): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const metrics = extractMetricNames(t.expr);
    if (!metrics.length || !metrics.every((m) => supported[m] === false)) continue;
    const label = labelFor(t, metrics[0]);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** The legend format's trailing role — "{{node}} gpu{{gpu}} · integer" -> "integer".
 *  The template variables cannot be resolved without a series, and the suffix is the
 *  part that names what is missing. */
function labelFor(t: TargetLike, metric: string): string {
  const fmt = (t.legendFormat || '').trim();
  if (!fmt) return metric;
  const tail = fmt.split('·').pop()!.trim();
  return tail && !tail.includes('{{') ? tail : metric;
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run lib/panelSupport.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Render the rows in the legend**

`components/Legend.tsx` gains an optional prop. Keep the existing `items` behaviour untouched:

```tsx
export function Legend({ items, unsupported = [] }: {
  items: { label: string; color: string }[];
  unsupported?: string[];
}) {
  if (items.length < 2 && unsupported.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.8rem',
                  marginBottom: '0.5rem', fontSize: '0.75rem', color: INK.secondary }}>
      {items.map((s) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2,
                                     background: s.color, flex: '0 0 auto' }} />
          {s.label}
        </span>
      ))}
      {unsupported.map((label) => (
        // No colour chip: there is no series. The ring says "a slot that stays empty".
        <span key={`u-${label}`} style={{ display: 'inline-flex', alignItems: 'center',
                                          gap: '0.3rem', color: INK.muted }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, flex: '0 0 auto',
                                     border: `1px solid ${INK.muted}` }} />
          {label} — not supported on this GPU
        </span>
      ))}
    </div>
  );
}
```

In `TimeSeriesPanel.tsx`, compute `unsupportedTargets(spec.targets, supported)` and pass it to `<Legend/>`.
A panel must still render its supported series — do **not** gate this on the panel being empty.

- [ ] **Step 6: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: 55 tests pass, tsc silent, build succeeds.

---

## Task 3: The partitioned state

Fixes [14 §2.3](../14-metric-evaluation.md).

**Files:**
- Modify: `lib/panelSupport.ts`, `lib/panelSupport.test.ts`, `components/PanelFrame.tsx`,
  `components/PanelGrid.tsx`, `app/page.tsx`, and the seven renderers' empty-state branch

- [ ] **Step 1: Write the failing test**

Append to `lib/panelSupport.test.ts`:

```ts
import { emptyState } from './panelSupport';

describe('emptyState', () => {
  const partitioned = new Set(['GPU-mig-card']);

  it('reports a device-scope panel on a partitioned card as partitioned', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-mig-card'], partitioned,
                        allUnsupported: false })).toBe('partitioned');
  });

  it('does not claim partitioned when any selected card is whole', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-mig-card', 'GPU-whole'],
                        partitioned, allUnsupported: false })).toBe('nodata');
  });

  it('does not claim partitioned for a MIG-scope panel', () => {
    // The MIG tab's panels are exactly the ones that DO report on a partitioned card.
    expect(emptyState({ deviceScope: false, selected: ['GPU-mig-card'], partitioned,
                        allUnsupported: false })).toBe('nodata');
  });

  it('prefers partitioned over unsupported, being the more precise statement', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-mig-card'], partitioned,
                        allUnsupported: true })).toBe('partitioned');
  });

  it('falls back to unsupported, then nodata', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-whole'], partitioned,
                        allUnsupported: true })).toBe('unsupported');
    expect(emptyState({ deviceScope: true, selected: ['GPU-whole'], partitioned,
                        allUnsupported: false })).toBe('nodata');
  });

  it('treats an empty selection as not-all-partitioned', () => {
    // "All GPUs" includes whole cards; claiming partitioned would be wrong.
    expect(emptyState({ deviceScope: true, selected: [], partitioned,
                        allUnsupported: false })).toBe('nodata');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run lib/panelSupport.test.ts
```
Expected: FAIL — `emptyState is not a function`.

- [ ] **Step 3: Implement**

Append to `lib/panelSupport.ts`:

```ts
export type EmptyState = 'partitioned' | 'unsupported' | 'nodata';

/** Which empty state an empty-but-successful panel deserves, most specific first.
 *
 *  `partitioned` outranks `unsupported` because it is the more precise statement: once
 *  MIG is on, DCGM stops reporting device-scope profiling fields and reports instance
 *  entities instead (02 §4), so the support rule can legitimately report 0 for a
 *  device-scope field on a partitioned card. Saying "not supported" there would be true
 *  but useless — the reading exists, at another scope. See 14 §3.2. */
export function emptyState(o: {
  deviceScope: boolean;
  selected: string[];
  partitioned: Set<string>;
  allUnsupported: boolean;
}): EmptyState {
  const everySelectedIsPartitioned =
    o.selected.length > 0 && o.selected.every((g) => o.partitioned.has(g));
  if (o.deviceScope && everySelectedIsPartitioned) return 'partitioned';
  if (o.allUnsupported) return 'unsupported';
  return 'nodata';
}
```

- [ ] **Step 4: Add the state to `PanelFrame`**

```ts
export type PanelState =
  'ok' | 'loading' | 'nodata' | 'unsupported' | 'partitioned' | 'rejected' | 'down';
```
with message `'Partitioned into MIG instances — this reading is per instance. See the MIG tab.'` and
`MESSAGE_COLOR.partitioned = STATUS.warning`.

- [ ] **Step 5: Feed the partitioned set from the page**

In `app/page.tsx`, alongside the existing `gpu_metric_supported` fetch:

```ts
const [partitioned, setPartitioned] = useState<Set<string>>(new Set());
useEffect(() => {
  // Any gpu_uuid that reports an instance entity is a partitioned card. Same evidence
  // DCGM already provides — no new exporter, no new metric. See 14 §3.2.
  api.query('count by (gpu_uuid) (DCGM_FI_DEV_FB_USED{GPU_I_ID!=""})')
     .then((r) => setPartitioned(new Set(r.result.map((s: any) => s.metric.gpu_uuid))))
     .catch(() => {});
}, [tick]);
```

Thread `partitioned` and the active dashboard's `deviceScope` (true for uid `gpu-hardware-device`) through
`PanelGrid` to the renderers, and replace each renderer's
`setState(allUnsupported ? 'unsupported' : 'nodata')` with
`setState(emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported }))`.

- [ ] **Step 6: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: 61 tests pass, tsc silent, build succeeds.

---

## Task 4: Generate the metric inventory

**Files:**
- Create: `evaluation/metrics.json`, and the generator step inside `evaluation/report.py`

- [ ] **Step 1: Write the generator as a function in `report.py`**

```python
"""Metric inventory, derived from panels.json so it cannot drift from the dashboards."""
import json, re

METRIC_RE = re.compile(r'\b(ebpf_[a-z0-9_]+|DCGM_FI_[A-Z0-9_]+|nvml_[a-z0-9_]+|gpu_alloc_[a-z0-9_]+)\b')


def metrics_from_panels(panels: dict) -> dict:
    """{metric_name: [dashboard_uid, ...]} for every metric any panel plots."""
    out: dict = {}
    for dash in panels["dashboards"]:
        for row in dash["rows"]:
            for panel in row["panels"]:
                for target in panel["targets"]:
                    for name in METRIC_RE.findall(target["expr"]):
                        out.setdefault(name, set()).add(dash["uid"])
    return {k: sorted(v) for k, v in sorted(out.items())}
```

- [ ] **Step 2: Write its test**

`evaluation/test_report.py`:

```python
from report import metrics_from_panels


def test_extracts_metrics_per_dashboard():
    panels = {"dashboards": [{"uid": "d1", "rows": [{"panels": [
        {"targets": [{"expr": 'DCGM_FI_PROF_PIPE_FP64_ACTIVE{gpu_uuid=~"$gpu"}'}]}]}]}]}
    assert metrics_from_panels(panels) == {"DCGM_FI_PROF_PIPE_FP64_ACTIVE": ["d1"]}


def test_same_metric_on_two_dashboards_lists_both():
    t = [{"expr": "DCGM_FI_PROF_PIPE_INT_ACTIVE"}]
    panels = {"dashboards": [
        {"uid": "a", "rows": [{"panels": [{"targets": t}]}]},
        {"uid": "b", "rows": [{"panels": [{"targets": t}]}]}]}
    assert metrics_from_panels(panels)["DCGM_FI_PROF_PIPE_INT_ACTIVE"] == ["a", "b"]


def test_ignores_promql_functions_and_template_vars():
    panels = {"dashboards": [{"uid": "d", "rows": [{"panels": [
        {"targets": [{"expr": 'sum(rate(ebpf_cuda_kernel_launch_calls_total[$__rate_interval]))'}]}]}]}]}
    assert list(metrics_from_panels(panels)) == ["ebpf_cuda_kernel_launch_calls_total"]
```

- [ ] **Step 3: Run**

```bash
source .venv/bin/activate && python -m pytest evaluation/test_report.py -q
```
Expected: 3 passed.

- [ ] **Step 4: Generate and eyeball**

```bash
python evaluation/report.py --emit-inventory > evaluation/metrics.json
python -c "import json;d=json.load(open('evaluation/metrics.json'));print(len(d),'metrics')"
```
Expected: 53.

---

## Task 5: The classifier

**Files:**
- Modify: `evaluation/report.py`, `evaluation/test_report.py`

- [ ] **Step 1: Write the failing test**

```python
from report import classify


def test_a_sample_in_the_window_is_observed():
    assert classify(samples=[(100.0, "0.42")], support=None)[0] == "OBSERVED"


def test_no_sample_with_a_zero_verdict_is_unsupported():
    # A pass, not a failure: the system correctly knows it cannot produce this.
    assert classify(samples=[], support=0.0)[0] == "UNSUPPORTED"


def test_no_sample_and_no_verdict_is_unverified():
    # The defect class. A blank panel with nothing explaining it.
    assert classify(samples=[], support=None)[0] == "UNVERIFIED"


def test_no_sample_but_supported_is_unverified_not_unsupported():
    # support==1 means it CAN produce data, so silence is unexplained.
    assert classify(samples=[], support=1.0)[0] == "UNVERIFIED"


def test_observed_reports_the_peak():
    assert classify(samples=[(1.0, "0.2"), (2.0, "0.9")], support=None)[1] == 0.9
```

- [ ] **Step 2: Run and watch it fail**

```bash
python -m pytest evaluation/test_report.py -q
```
Expected: FAIL — `cannot import name 'classify'`.

- [ ] **Step 3: Implement**

```python
def classify(samples: list, support: float | None) -> tuple[str, float | None]:
    """One (metric, entity) verdict. See 14 §1.

    UNSUPPORTED requires an explicit 0 verdict. A missing verdict is UNVERIFIED, never
    UNSUPPORTED — the whole point is to separate "cannot" from "did not", and guessing
    re-creates the ambiguity. support==1 with no sample is also UNVERIFIED: the metric
    can produce data and did not, which is unexplained.
    """
    if samples:
        return "OBSERVED", max(float(v) for _, v in samples)
    if support == 0.0:
        return "UNSUPPORTED", None
    return "UNVERIFIED", None
```

- [ ] **Step 4: Run**

```bash
python -m pytest evaluation/test_report.py -q
```
Expected: 8 passed.

---

## Task 6: The pipe exerciser image

**Files:**
- Create: `evaluation/workloads/pipe-exerciser/{Dockerfile,main.cu}`

- [ ] **Step 1: Write `main.cu`**

One mode per invocation, so a metric's rise is attributable to exactly one pipe. Common scaffolding:
parse `--mode`, `--duration` (seconds, default 90), `--device`; allocate square matrices of `N=8192`; loop
the mode's call until the duration elapses; `cudaDeviceSynchronize()` each iteration.

The per-mode call is the whole decision content:

| `--mode` | Call |
|---|---|
| `fp64` | `cublasDgemm` with `cublasSetMathMode(h, CUBLAS_PEDANTIC_MATH)` — keeps it off the tensor cores |
| `fp32` | `cublasSgemm`, `CUBLAS_PEDANTIC_MATH` |
| `fp16` | `cublasHgemm`, `CUBLAS_PEDANTIC_MATH` |
| `tensor-hmma` | `cublasGemmEx(..., CUDA_R_16F, ..., CUBLAS_COMPUTE_16F, CUBLAS_GEMM_DEFAULT_TENSOR_OP)` |
| `tensor-imma` | `cublasGemmEx(..., CUDA_R_8I, ..., CUBLAS_COMPUTE_32I, CUBLAS_GEMM_DEFAULT_TENSOR_OP)` |
| `tensor-dfma` | `cublasDgemm` with `cublasSetMathMode(h, CUBLAS_DEFAULT_MATH)` — lets DMMA engage on the FP64 tensor cores |
| `int` | Custom kernel: a long dependent chain of `int` multiply-add over a device array |
| `dram-bandwidth` | Custom kernel: strided `float4` read-modify-write over a buffer ≥ 2× L2 |
| `pcie-h2d` / `pcie-d2h` | `cudaMemcpy` of a 512 MiB pinned buffer in the named direction, in a loop |
| `peer-copy` | `cudaMemcpyPeer` GPU0→GPU1 after `cudaDeviceEnablePeerAccess` |
| `hostmem` | Kernel reading a `cudaHostAlloc(..., cudaHostAllocMapped)` buffer via its device pointer |
| `peermem` | Kernel on GPU0 reading a buffer resident on GPU1 over peer access |
| `sustained` | `fp32` for the full duration, to ramp power, temperature and clocks |

Every CUDA and cuBLAS call is checked; on failure print `mode=<mode> FAILED <api> <error>` and exit non-zero,
so a phase that could not run is never mistaken for a metric that did not appear.

`peer-copy` and `peermem` must exit non-zero with a clear message when `cudaDeviceCanAccessPeer` is false,
rather than silently doing nothing — on this cluster peer access may be unavailable, and that is a finding.

- [ ] **Step 2: Write the Dockerfile**

```dockerfile
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build
WORKDIR /src
COPY main.cu .
RUN nvcc -O3 -arch=sm_80 -o /pipe-exerciser main.cu -lcublas

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
COPY --from=build /pipe-exerciser /usr/local/bin/pipe-exerciser
ENTRYPOINT ["/usr/local/bin/pipe-exerciser"]
```
`sm_80` is the A30's compute capability.

- [ ] **Step 3: Build, push, and smoke-test one mode on the whole card**

```bash
REG=192.168.6.123:30080/library
docker build -t $REG/pipe-exerciser:v1 evaluation/workloads/pipe-exerciser
docker push $REG/pipe-exerciser:v1
```
Then run `--mode fp64 --duration 60` as a Job on GPU 0 and confirm `DCGM_FI_PROF_PIPE_FP64_ACTIVE` rises
above 0 during the window. If it does not, the harness is not measuring what it thinks — fix before going on.

---

## Task 7: The API exerciser image

**Files:**
- Create: `evaluation/workloads/api-exerciser/{Dockerfile,main.cu}`

- [ ] **Step 1: Write `main.cu`**

Same scaffolding. **Raw CUDA only — no framework, and no allocator caching of any kind.** The reason 12 of
20 eBPF families have never fired is that PyTorch's caching allocator stops calling `cudaMalloc` after
warm-up ([14 §4.1](../14-metric-evaluation.md)); an exerciser that caches would reproduce the same blind spot.

| `--mode` | Calls, in a loop for the duration |
|---|---|
| `malloc-free` | `cudaMalloc` then `cudaFree`, varying sizes 1 MiB–256 MiB |
| `memcpy-h2d` / `memcpy-d2h` / `memcpy-d2d` | `cudaMemcpy` in the named direction |
| `memcpy-peer` | `cudaMemcpyPeer` between devices |
| `memset-sync` | `cudaMemset` |
| `memset-async` | `cudaMemsetAsync` on a non-default stream |
| `stream-sync` | Launch a kernel, then `cudaStreamSynchronize` |
| `device-sync` | Launch a kernel, then `cudaDeviceSynchronize` |
| `event-sync` | `cudaEventRecord` then `cudaEventSynchronize` |
| `event-elapsed` | Two events around a kernel, then `cudaEventElapsedTime` |
| `graph-launch` | Capture a stream into a `cudaGraph_t`, instantiate, `cudaGraphLaunch` repeatedly |
| `kernel-dims` | Launch with grid/block/shared-memory sizes cycling across a wide range, to fill the histogram buckets |
| `errors` | Alternate a deliberately invalid launch (block size > 1024) and an allocation far larger than VRAM, clearing the error each time with `cudaGetLastError` |

`errors` mode is the only one that intentionally fails calls; it must still exit **0**, because producing
errors is its job. Every other mode exits non-zero on any unexpected CUDA error.

- [ ] **Step 2: Dockerfile** — identical to Task 6's but without `-lcublas` and producing `api-exerciser`.

- [ ] **Step 3: Build, push, smoke-test**

Run `--mode malloc-free --duration 60` on GPU 0 and confirm `ebpf_cuda_memory_allocations_calls_total`
appears — a metric never before seen. If it does not appear, check the pod carries the eBPF agent's
instrumentation labels (`ebpf.instrument_cuda: 'on'`, and note that `discovery.instrument` is a **glob**,
not a regex) before concluding the exporter is at fault.

---

## Task 8: Job manifests and the phase driver

**Files:**
- Create: `evaluation/manifests/job-template.yaml`, `evaluation/run.sh`

- [ ] **Step 1: The Job template**

`envsubst`-filled, one file for all phases. Must carry the eBPF agent's instrumentation labels, a
`nodeSelector` for the GPU node, `runtimeClassName: nvidia`, and `restartPolicy: Never`. Resource requests
differ per target class and come from `$RESOURCES`:

| Target | `$RESOURCES` |
|---|---|
| Whole card | `nvidia.com/gpu: 1` |
| MIG instance | the instance profile resource advertised by the node |
| HAMi-limited | `nvidia.com/gpumem: 2048` and `nvidia.com/gpucores: 20` |

- [ ] **Step 2: `run.sh`**

For each phase: record `t0=$(date +%s)`, apply the Job, `kubectl wait --for=condition=complete
--timeout=…`, record `t1`, capture logs, delete the Job, and append
`{"phase":…,"mode":…,"target":…,"t0":…,"t1":…,"status":…}` to `evaluation/phases.jsonl`.

**A Job that never reached `Running` is `status: "ERROR"`, not a completed phase.** The classifier must be
able to tell "the workload did not run" from "the metric did not appear" — conflating them is how a broken
harness reports a clean bill of health.

`--repartition` is a separate, explicitly-invoked subcommand, never part of a normal run: it destroys the
existing `1g.6gb` instance and changes cluster state ([14 §4.4](../14-metric-evaluation.md)). Without it the
suite runs against whatever instances exist and reports the rest as a coverage gap.

- [ ] **Step 3: Dry-run one phase end to end**

```bash
bash evaluation/run.sh --phase fp64 --target gpu0
cat evaluation/phases.jsonl
```
Expected: one line, `status: "COMPLETE"`, with a window of roughly the requested duration.

---

## Task 9: The full run and the report

**Files:**
- Modify: `evaluation/report.py`

- [ ] **Step 1: Wire the query side**

For each phase window and each metric in `metrics.json`, issue
`query_range(metric, t0, t1, step)` and `query(gpu_metric_supported{metric="<name>"}, at t1)`, then
`classify(...)` per entity `(gpu_uuid, GPU_I_ID)`. Attribute each verdict to the phase that best exercised
that metric; a metric Observed in **any** phase is Observed overall.

- [ ] **Step 2: Emit both formats**

Markdown for reading, JSON for diffing between runs, in the shape shown in [14 §5](../14-metric-evaluation.md).
The exit code is non-zero if any metric is UNVERIFIED.

- [ ] **Step 3: Run the whole suite**

```bash
bash evaluation/run.sh --all
source .venv/bin/activate && python evaluation/report.py > evaluation/report.md
```

- [ ] **Step 4: Prove the harness is honest, not just green**

Stop the eBPF agent, re-run one eBPF phase, and confirm those metrics come back **UNVERIFIED** rather than
OBSERVED. A harness that reports success when the thing it measures is switched off is measuring nothing.

```bash
kubectl -n gpu-monitoring scale ds/ebpf-agent --replicas=0   # adapt to the real workload name
bash evaluation/run.sh --phase malloc-free --target gpu0
python evaluation/report.py --phase malloc-free   # expect UNVERIFIED
kubectl -n gpu-monitoring scale ds/ebpf-agent --replicas=1
```

- [ ] **Step 5: Re-measure the top-level gap**

Re-run the query from [14 §6](../14-metric-evaluation.md) and record how many of the 18 unseen metrics now
carry a verdict, and what each verdict is.

- [ ] **Step 6: Update the docs with what was actually found**

[10 §3.2](../10-metric-support-signal.md) lists which DCGM fields are requested and why. Add
`PIPE_TENSOR_DFMA_ACTIVE` with its real measured outcome. Record any metric that turned out Unsupported in
[09 — risks and open questions](../09-risks-and-open-questions.md).

**Write down what happened, not what was predicted.** [14 §4.2](../14-metric-evaluation.md) predicts four
Unsupported results; if the run disagrees, the run is right.

---

## Verification summary

| Check | Command | Expected |
|---|---|---|
| DCGM survived the new field | DCGM metric-name count before vs after | not lower |
| UI tests | `npm test` | 61 pass |
| Types | `npx tsc --noEmit` | silent |
| Build | `npx next build` | succeeds |
| Classifier tests | `python -m pytest evaluation/ -q` | all pass |
| Dashboard contract | `python scripts/check-dashboards.py dashboards/*.json` | 0 problems |
| Integer pipe is explained | Device tab, GPU 0 | legend reads "integer — not supported on this GPU" |
| Partitioned card is explained | Device tab, GPU 1 | panels read "Partitioned into MIG instances" |
| Harness is honest | eBPF agent stopped | UNVERIFIED, not OBSERVED |
| Coverage | `evaluation/report.md` | zero UNVERIFIED |

---

## Notes for the implementer

- **An unknown DCGM field is fatal.** Task 1 Step 4's count check is not optional; one bad line makes the
  exporter serve nothing and every dashboard goes blank at once.
- **UNSUPPORTED is a pass.** Do not "fix" it by removing the metric from a dashboard — the panel saying
  "not supported on this GPU" is the feature.
- **Never assert an expected utilisation value.** The claim is that a metric responds to a workload built to
  drive it, not that it reaches a number.
- **Do not modify `/home/ubuntu/loiht2/test/deep-learning-workloads`.** Separate harness, separate provenance.
- **Do not commit** without approval, per the project's CLAUDE.md.
