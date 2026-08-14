# Scope, Legend and Time Range Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every panel show its chart, let the operator pick an arbitrary time window, and give each tab a scope control that offers only entities that tab can actually plot.

**Architecture:** Scope options stop coming from a bare `label_values(gpu_uuid)` — which unions two exporters' incompatible meanings of that label — and are derived per tab from DCGM, the one source that describes both scopes coherently. The MIG dashboard gains a second template variable so an instance can be selected. The legend folds past eight series to match what the plot already does, and the time control gains an absolute custom range.

**Tech Stack:** TypeScript/React (Next.js 15), Chart.js, vitest; Python for the extractor and the evaluation harness; Grafana dashboard JSON.

**Spec:** [12 §2.2–2.4](../12-monitoring-ui.md), [13 §9–11](../13-ui-visual-design.md), [14 §4.5–4.6](../14-metric-evaluation.md).

---

## Working directory

`/home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/feature-monitoring-ui`.

UI from `services/advanced-monitoring-ui/`: `npm test`, `npx tsc --noEmit`, `npx next build`.
Python from the repo root with `source .venv/bin/activate`.

**Measured facts this plan depends on — do not re-derive, but do not contradict:**

| Fact | Value |
|---|---|
| `label_values(gpu_uuid)` at 6h | 3 values: 2 `GPU-…` cards **plus** `MIG-7e63a3a6…` from HAMi's dra-monitor |
| DCGM device-scope entities | **1** — only GPU 0. GPU 1 is fully partitioned and has no device row |
| DCGM instance entities | 1 — `gpu=1, GPU_I_ID=3, GPU_I_PROFILE=1g.6gb`, `gpu_uuid` = parent card |
| DCGM MIG instance UUID | **none published**; an instance is `(gpu_uuid, GPU_I_ID)` |
| Worst-case series on one panel | **46** (`ebpf_cuda_kernel_launch_calls_total`) |
| eBPF's own device labels | **no `GPU_I_ID`, no `mig_uuid`**; only **3 of 43** pods carry a `gpu_uuid` |
| `gpu_alloc_device_pod_info` | maps pod → `gpu_uuid` **and** `mig_uuid`; resolves **43 of 43** pods, 17 on an instance |
| MIG identifier bridge | `nvml_gpu_memory_*` and `gpu_metric_supported` carry both `mig_uuid` and `GPU_I_ID` — the only place the two naming schemes meet |

---

## File structure

**New:**

| File | Responsibility |
|---|---|
| `lib/scope.ts` | Per-tab scope option derivation and labelling (pure) |
| `lib/scope.test.ts` | Its tests |
| `lib/timeRange.ts` | Preset and absolute-range model, validation (pure) |
| `lib/timeRange.test.ts` | Its tests |
| `components/TimeRangeControl.tsx` | Segmented presets + Custom with two datetime inputs |

**Modified:** `components/Legend.tsx`, `components/panels/TimeSeriesPanel.tsx`, `components/ControlBar.tsx`,
`app/page.tsx`, `lib/api.ts`, `dashboards/gpu-hardware-mig.json`, `scripts/check-dashboards.py`,
`evaluation/run.sh`.

---

## Task 1: Fold the legend past eight series

Fixes [13 §9](../13-ui-visual-design.md). A 46-series panel currently renders 46 chips and no visible chart.

**Files:**
- Modify: `services/advanced-monitoring-ui/components/Legend.tsx`
- Modify: `services/advanced-monitoring-ui/components/panels/TimeSeriesPanel.tsx`

- [ ] **Step 1: Write the failing test**

Create `lib/legend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { legendItems } from './legend';
import { SERIES, OTHER } from './theme';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
  label: `pod-${String(i).padStart(2, '0')}`, color: i < SERIES.length ? SERIES[i] : OTHER,
}));

describe('legendItems', () => {
  it('lists every series when there are eight or fewer', () => {
    expect(legendItems(mk(8))).toHaveLength(8);
  });

  it('caps at eight chips plus one summary row when there are more', () => {
    const r = legendItems(mk(46));
    expect(r).toHaveLength(9);
    expect(r[8]).toEqual({ label: 'Other — 38 more series', color: OTHER, summary: true });
  });

  it('counts the folded series correctly at the boundary', () => {
    expect(legendItems(mk(9))[8].label).toBe('Other — 1 more series');
  });

  it('leaves a single series unlisted — the panel title names it', () => {
    expect(legendItems(mk(1))).toEqual([]);
  });

  it('does not mark a normal row as a summary', () => {
    expect(legendItems(mk(3)).every((r) => !r.summary)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/advanced-monitoring-ui && npx vitest run lib/legend.test.ts
```
Expected: FAIL — cannot resolve `./legend`.

- [ ] **Step 3: Implement `lib/legend.ts`**

```ts
import { SERIES, OTHER } from './theme';

export interface LegendRow { label: string; color: string; summary?: boolean }

/** What the legend shows, matching what the plot draws. §1.3 folds everything past the
 *  eighth series into one muted Other because there is no ninth hue; the legend has to
 *  say the same thing, or a 46-series panel renders 46 chips and no chart.
 *
 *  This is a DISPLAY cap only. The query is unchanged and the folded series are still
 *  plotted — nothing is dropped from the data, only from the list of names. */
export function legendItems(items: { label: string; color: string }[]): LegendRow[] {
  if (items.length < 2) return [];            // one series is named by the panel title
  if (items.length <= SERIES.length) return items.map((i) => ({ ...i }));
  const folded = items.length - SERIES.length;
  return [
    ...items.slice(0, SERIES.length).map((i) => ({ ...i })),
    { label: `Other — ${folded} more series`, color: OTHER, summary: true },
  ];
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run lib/legend.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it, and stop the legend squeezing the plot**

`Legend.tsx` maps over `legendItems(items)` instead of `items`, and the container gains
`maxHeight: '3.4rem', overflowY: 'auto'` so even eight long pod names cannot take more than two rows.
In `TimeSeriesPanel.tsx`, give the canvas wrapper `minHeight: 80` so the plot can never be squeezed to
nothing. Keep passing `unsupported` through — that list is separate and is never folded.

- [ ] **Step 6: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: 66 tests pass, tsc silent, build succeeds.

---

## Task 2: An absolute custom time range

Fixes [13 §10](../13-ui-visual-design.md).

**Files:**
- Create: `lib/timeRange.ts`, `lib/timeRange.test.ts`, `components/TimeRangeControl.tsx`
- Modify: `components/ControlBar.tsx`, `app/page.tsx`

- [ ] **Step 1: Write the failing test**

`lib/timeRange.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveRange, validateCustom, PRESETS } from './timeRange';

describe('resolveRange', () => {
  it('resolves a preset relative to now', () => {
    const r = resolveRange({ kind: 'preset', seconds: 3600 }, 1_000_000);
    expect(r).toEqual({ start: 996_400, end: 1_000_000 });
  });

  it('returns a custom range verbatim, not relative to now', () => {
    // Absolute on purpose: re-rendering hours later must show the same window.
    const r = resolveRange({ kind: 'custom', start: 100, end: 700 }, 9_999_999);
    expect(r).toEqual({ start: 100, end: 700 });
  });

  it('reports the span so step derivation is identical for both kinds', () => {
    expect(resolveRange({ kind: 'custom', start: 100, end: 700 }, 0).end
         - resolveRange({ kind: 'custom', start: 100, end: 700 }, 0).start).toBe(600);
  });
});

describe('validateCustom', () => {
  it('accepts a well-formed past window', () => {
    expect(validateCustom(100, 700, 1000)).toBeNull();
  });

  it('rejects a start at or after the end', () => {
    expect(validateCustom(700, 700, 1000)).toBe('Start must be before end');
    expect(validateCustom(800, 700, 1000)).toBe('Start must be before end');
  });

  it('rejects an end in the future', () => {
    // Prometheus has nothing there; a silently-empty panel would look like a bug.
    expect(validateCustom(100, 2000, 1000)).toBe('End cannot be in the future');
  });

  it('rejects a zero-length or unparseable input', () => {
    expect(validateCustom(NaN, 700, 1000)).toBe('Enter both a start and an end');
    expect(validateCustom(100, NaN, 1000)).toBe('Enter both a start and an end');
  });
});

describe('PRESETS', () => {
  it('keeps the six one-click ranges', () => {
    expect(PRESETS.map((p) => p.label)).toEqual(['5m', '15m', '1h', '6h', '24h', '7d']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run lib/timeRange.test.ts
```
Expected: FAIL — cannot resolve `./timeRange`.

- [ ] **Step 3: Implement `lib/timeRange.ts`**

```ts
export const PRESETS = [
  { label: '5m', seconds: 300 },   { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },{ label: '7d', seconds: 604800 },
] as const;

export type RangeSelection =
  | { kind: 'preset'; seconds: number }
  | { kind: 'custom'; start: number; end: number };

/** Absolute [start, end] in epoch seconds. A preset follows "now"; a custom range does
 *  not — re-rendering hours later must show the same window, not a sliding one. */
export function resolveRange(sel: RangeSelection, nowSeconds: number):
    { start: number; end: number } {
  return sel.kind === 'preset'
    ? { start: nowSeconds - sel.seconds, end: nowSeconds }
    : { start: sel.start, end: sel.end };
}

/** The reason a custom range cannot be applied, or null when it can. Apply stays
 *  disabled while this is non-null: a silently-ignored Apply is worse than a disabled
 *  one, because an unchanged chart reads as "no data" rather than "bad input". */
export function validateCustom(start: number, end: number, nowSeconds: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter both a start and an end';
  if (start >= end) return 'Start must be before end';
  if (end > nowSeconds) return 'End cannot be in the future';
  return null;
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run lib/timeRange.test.ts
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Build `TimeRangeControl.tsx`**

The six presets as the existing segmented control, plus a seventh segment **Custom**. Selecting Custom
reveals two `<input type="datetime-local">` fields and an Apply button. Apply is `disabled` whenever
`validateCustom(...)` returns a string, and that string is shown beside it in `STATUS.warning`. When a
custom range is active the segment shows the chosen span, e.g. `14:05 → 14:20`.

Convert between the input's local-time string and epoch seconds with `new Date(value).getTime() / 1000`;
render back with `toISOString().slice(0, 16)` adjusted for the local offset. Colour from tokens only.

- [ ] **Step 6: Thread it through**

`app/page.tsx` holds `RangeSelection` instead of a bare `number`. Everywhere that previously used
`range` now uses `resolveRange(sel, Math.floor(Date.now() / 1000))` and passes `start`/`end` to panels and
label lookups. `deriveStep` takes `end - start`, so a custom span costs the same as a preset of that length.

- [ ] **Step 7: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: 74 tests pass, tsc silent, build succeeds.

---

## Task 3: Per-tab scope options

Fixes [12 §2.3](../12-monitoring-ui.md) and [13 §11](../13-ui-visual-design.md). The Device tab currently
offers a MIG instance because two exporters use `gpu_uuid` to mean different things.

**Files:**
- Create: `lib/scope.ts`, `lib/scope.test.ts`
- Modify: `lib/api.ts`, `components/ControlBar.tsx`, `app/page.tsx`

- [ ] **Step 1: Write the failing test**

`lib/scope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deviceOptions, migOptions } from './scope';

// Shape returned by /query for DCGM_FI_DEV_FB_USED.
const series = (m: Record<string, string>) => ({ metric: m, value: [0, '1'] as [number, string] });

describe('deviceOptions', () => {
  it('lists each physical card once, partitioned or not', () => {
    // gpu_uuid on a DCGM series is always the PARENT card, so instance rows collapse
    // onto their card rather than adding an entry.
    const r = deviceOptions([
      series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '4' }),
    ]);
    expect(r.map((o) => o.value)).toEqual(['GPU-a', 'GPU-b']);
  });

  it('never offers a MIG instance uuid', () => {
    // HAMi's dra-monitor puts MIG-… in gpu_uuid; DCGM never does. Sourcing from DCGM
    // is what keeps it out — see 12 §2.3.
    const r = deviceOptions([series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' })]);
    expect(r.some((o) => o.value.startsWith('MIG-'))).toBe(false);
  });

  it('labels a card by its index and short uuid', () => {
    expect(deviceOptions([series({ gpu_uuid: 'GPU-abcdefgh', gpu: '0', GPU_I_ID: '' })])[0].label)
      .toBe('GPU 0 · GPU-abcd');
  });
});

describe('migOptions', () => {
  it('lists one entry per instance with its profile', () => {
    const r = migOptions([
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3', GPU_I_PROFILE: '1g.6gb' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '4', GPU_I_PROFILE: '2g.12gb' }),
    ]);
    expect(r.map((o) => o.label)).toEqual(['GPU 1 · 1g.6gb · id 3', 'GPU 1 · 2g.12gb · id 4']);
  });

  it('carries both identifiers, since DCGM publishes no instance uuid', () => {
    const r = migOptions([series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3', GPU_I_PROFILE: '1g.6gb' })]);
    expect(r[0]).toMatchObject({ gpuUuid: 'GPU-b', migId: '3' });
  });

  it('never offers a whole card', () => {
    const r = migOptions([series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' })]);
    expect(r).toEqual([]);
  });

  it('sorts by card then instance id, not by arrival order', () => {
    const r = migOptions([
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '11', GPU_I_PROFILE: '1g.6gb' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3', GPU_I_PROFILE: '1g.6gb' }),
    ]);
    expect(r.map((o) => o.migId)).toEqual(['3', '11']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run lib/scope.test.ts
```
Expected: FAIL — cannot resolve `./scope`.

- [ ] **Step 3: Implement `lib/scope.ts`**

```ts
interface Series { metric: Record<string, string> }
export interface DeviceOption { value: string; label: string }
export interface MigOption { value: string; label: string; gpuUuid: string; migId: string }

/** The physical cards. Derived from DCGM rather than a bare label_values(gpu_uuid),
 *  because HAMi's dra-monitor also writes gpu_uuid and sets it to a MIG *instance* uuid
 *  for a MIG-backed claim — so the union of the two offers an entity the Device tab
 *  cannot plot. See 12 §2.3. On any DCGM series gpu_uuid is the parent card, so instance
 *  rows collapse onto their card. */
export function deviceOptions(series: Series[]): DeviceOption[] {
  const byUuid = new Map<string, string>();
  for (const s of series) {
    const uuid = s.metric.gpu_uuid;
    if (!uuid) continue;
    if (!byUuid.has(uuid)) byUuid.set(uuid, s.metric.gpu ?? '?');
  }
  return [...byUuid.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
    .map(([uuid, gpu]) => ({ value: uuid, label: `GPU ${gpu} · ${uuid.slice(0, 8)}` }));
}

/** The MIG instances. DCGM publishes no instance uuid, so an instance is
 *  (gpu_uuid, GPU_I_ID) and the option carries both — one operator-facing choice, two
 *  template variables. See 12 §2.4. */
export function migOptions(series: Series[]): MigOption[] {
  const seen = new Map<string, MigOption>();
  for (const s of series) {
    const { gpu_uuid: gpuUuid, GPU_I_ID: migId, GPU_I_PROFILE: profile, gpu } = s.metric;
    if (!gpuUuid || !migId) continue;
    const key = `${gpuUuid}/${migId}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      value: key, gpuUuid, migId,
      label: `GPU ${gpu ?? '?'} · ${profile ?? 'unknown'} · id ${migId}`,
    });
  }
  return [...seen.values()].sort((a, b) =>
    a.gpuUuid.localeCompare(b.gpuUuid) ||
    Number(a.migId) - Number(b.migId));
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run lib/scope.test.ts
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Fetch the entities and wire the controls**

`app/page.tsx` replaces the `labelValues('gpu_uuid', …)` call with one instant query scoped to the selected
window, whose result feeds both derivations:

```ts
// One query, both scopes. DCGM_FI_DEV_FB_USED reports one row per entity — device rows
// carry GPU_I_ID="", instance rows carry an id — so it describes both scopes coherently.
api.query('DCGM_FI_DEV_FB_USED')
   .then((r) => { setDevices(deviceOptions(r.result)); setMigs(migOptions(r.result)); })
   .catch(() => {});
```

Then, per tab: Device shows `deviceOptions` in the existing `ScopeSelect`; MIG shows `migOptions` and sets
both `$gpu` and `$migid`; eBPF shows **cards and instances together**, resolved to pods through
`gpu_alloc_device_pod_info` rather than filtering on eBPF's own labels (Task 5), alongside Pod scope.

- [ ] **Step 6: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: 82 tests pass, tsc silent, build succeeds.

---

## Task 4: The `$migid` variable

Fixes [12 §2.4](../12-monitoring-ui.md). Selecting one instance is currently inexpressible.

**Files:**
- Modify: `dashboards/gpu-hardware-mig.json`, `scripts/check-dashboards.py`, then regenerate `panels.json`

- [ ] **Step 1: Add the variable to the dashboard**

In `dashboards/gpu-hardware-mig.json`, add to `templating.list`, beside the existing `gpu`:

```json
{
  "name": "migid",
  "label": "MIG instance",
  "query": "label_values(DCGM_FI_DEV_FB_USED{GPU_I_ID!=\"\"}, GPU_I_ID)",
  "includeAll": true,
  "multi": true,
  "type": "query"
}
```

- [ ] **Step 2: Narrow every MIG panel's filter**

Every target in that dashboard currently filters `GPU_I_ID!=""`, which means "any instance". Change each to
`GPU_I_ID=~"$migid"`. Keep `gpu_uuid=~"$gpu"` exactly as it is.

`$migid` resolving to `.*` selects every instance, which is the same set `GPU_I_ID!=""` selected — **except
that `.*` also matches the empty string**, so a device-scope row would leak into the MIG dashboard. Use
`GPU_I_ID=~"$migid", GPU_I_ID!=""` on every target so "All" still means "all instances" and never "the whole
card".

- [ ] **Step 3: Teach the checker about it**

`scripts/check-dashboards.py` has a check that MIG panels are instance-filtered. Update it to accept
`GPU_I_ID=~"$migid"` **only when accompanied by `GPU_I_ID!=""`**, and to fail if a MIG target has neither.
Add a test asserting a target with only `GPU_I_ID=~"$migid"` is rejected.

- [ ] **Step 4: Regenerate and check**

```bash
source .venv/bin/activate
python scripts/extract-panels.py dashboards/*.json -o services/advanced-monitoring-api/app/panels.json
python scripts/check-dashboards.py dashboards/*.json
python -m pytest scripts/test_extract_panels.py -q
```
Expected: 0 problems; extractor tests pass; the MIG dashboard now reports `['gpu', 'migid']`.

- [ ] **Step 5: Substitute it**

`substituteVars` already handles arbitrary named variables, so passing `{ gpu: [...], migid: [...] }` works
with no change to `lib/promql.ts`. In `app/page.tsx`, selecting a `MigOption` sets
`vars = { gpu: [o.gpuUuid], migid: [o.migId] }`. Confirm with a unit test that a MIG expression containing
both variables resolves with no literal `$` left.

- [ ] **Step 6: Verify**

```bash
cd services/advanced-monitoring-ui && npm test && npx tsc --noEmit && npx next build
```
Expected: all pass.

---

## Task 5: Correlate eBPF workloads with GPU/MIG identity

Fixes [13 §11.1](../13-ui-visual-design.md). The eBPF tab keeps its GPU scope; it is answered by the
exporter that actually knows which device a pod got.

**Files:**
- Create: `services/advanced-monitoring-ui/lib/correlate.ts`, `lib/correlate.test.ts`
- Modify: `app/page.tsx`, `components/ControlBar.tsx`
- Modify: `docs-internal/09-risks-and-open-questions.md`

- [ ] **Step 1: Confirm the measurement still holds**

```bash
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode \
  'q=count by (gpu_uuid) (last_over_time(ebpf_cuda_kernel_launch_calls_total[24h]))'
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode \
  'q=count(last_over_time(gpu_alloc_device_pod_info[24h]))'
```
Expected: eBPF labels almost no series with `gpu_uuid`, while `gpu_alloc_device_pod_info` covers every
workload pod. If eBPF has started labelling its own series, **stop and re-evaluate** — the join would then
be redundant.

- [ ] **Step 2: Write the failing test**

`lib/correlate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { podsForScope, unattributed, ambiguousNames, exceedsCap } from './correlate';

const alloc = (pod: string, gpu: string, mig = '') => ({
  metric: { pod, namespace: 'default', gpu_uuid: gpu, ...(mig ? { mig_uuid: mig } : {}) },
});

const ROWS = [
  alloc('train-a', 'GPU-a'),
  alloc('train-b', 'GPU-b'),
  alloc('mig-x', 'GPU-b', 'MIG-1'),
  alloc('mig-y', 'GPU-b', 'MIG-2'),
];

describe('podsForScope', () => {
  it('resolves a whole-card selection to its pods', () => {
    expect(podsForScope(ROWS, { kind: 'device', gpuUuid: 'GPU-a' })).toEqual(['train-a']);
  });

  it('includes a card\'s MIG pods when the card itself is selected', () => {
    // A pod on an instance is still running on that physical card.
    expect(podsForScope(ROWS, { kind: 'device', gpuUuid: 'GPU-b' }).sort())
      .toEqual(['mig-x', 'mig-y', 'train-b']);
  });

  it('resolves an instance selection to only that instance\'s pods', () => {
    expect(podsForScope(ROWS, { kind: 'mig', migUuid: 'MIG-1' })).toEqual(['mig-x']);
  });

  it('returns empty rather than everything when nothing matches', () => {
    // Degrading to "all pods" would silently show another GPU's workload as this one\'s.
    expect(podsForScope(ROWS, { kind: 'mig', migUuid: 'MIG-absent' })).toEqual([]);
  });

  it('returns empty when an instance selection carries no mig_uuid bridge', () => {
    expect(podsForScope(ROWS, { kind: 'mig', migUuid: '' })).toEqual([]);
  });

  it('de-duplicates a pod that appears on several rows', () => {
    expect(podsForScope([alloc('p', 'GPU-a'), alloc('p', 'GPU-a')],
                        { kind: 'device', gpuUuid: 'GPU-a' })).toEqual(['p']);
  });

  it('resolves the union for a multi-select', () => {
    expect(podsForScope(ROWS, { kind: 'device', gpuUuid: ['GPU-a', 'GPU-b'] }).length).toBe(4);
  });
});

describe('unattributed', () => {
  it('names the eBPF pods with no allocation record', () => {
    // Measured: coverage moved from 43/43 to 41/43 within hours, because the two
    // exporters' series have different lifetimes inside the same window. The UI states
    // the gap rather than quietly narrowing.
    expect(unattributed(['train-a', 'gpu-burn-a'], ROWS)).toEqual(['gpu-burn-a']);
  });

  it('is empty when every pod is attributable', () => {
    expect(unattributed(['train-a', 'train-b'], ROWS)).toEqual([]);
  });
});

describe('ambiguousNames', () => {
  it('flags a pod name present in more than one namespace', () => {
    // Substitution filters on k8s_pod_name alone, so a cross-namespace collision would
    // over-match into a namespace that is not on the selected device.
    const rows = [
      { metric: { pod: 'web-0', namespace: 'a', gpu_uuid: 'GPU-a' } },
      { metric: { pod: 'web-0', namespace: 'b', gpu_uuid: 'GPU-b' } },
    ];
    expect(ambiguousNames(rows)).toEqual(['web-0']);
  });

  it('is empty for the current cluster shape', () => {
    expect(ambiguousNames(ROWS)).toEqual([]);
  });
});

describe('podsForScope size cap', () => {
  it('returns a capped flag rather than a truncated regex', () => {
    // A truncated alternation plots a subset while looking complete.
    const many = Array.from({ length: 250 }, (_, i) => alloc(`p-${i}`, 'GPU-a'));
    expect(podsForScope(many, { kind: 'device', gpuUuid: 'GPU-a' }).length).toBe(250);
    expect(exceedsCap(podsForScope(many, { kind: 'device', gpuUuid: 'GPU-a' }))).toBe(true);
    expect(exceedsCap(podsForScope(ROWS, { kind: 'device', gpuUuid: 'GPU-a' }))).toBe(false);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

```bash
cd services/advanced-monitoring-ui && npx vitest run lib/correlate.test.ts
```
Expected: FAIL — cannot resolve `./correlate`.

- [ ] **Step 4: Implement `lib/correlate.ts`**

```ts
interface AllocRow { metric: Record<string, string> }
export type Scope =
  | { kind: 'device'; gpuUuid: string | string[] }
  | { kind: 'mig'; migUuid: string | string[] };

/** The workload pods that held a given device in this window.
 *
 *  The eBPF exporter labels only ~3 of 43 pods with a gpu_uuid and emits no MIG
 *  identifier at all, so filtering its own series on device would hide most of the data.
 *  `gpu_alloc_device_pod_info` knows what every pod was actually granted, including
 *  mig_uuid, and resolves 43/43. See 13 §11.1.
 *
 *  Selecting a whole card includes pods on its MIG instances: an instance is part of the
 *  card. Selecting an instance does not include the card's other pods.
 *
 *  An unmatched selection yields an EMPTY list, never every pod — degrading to "all"
 *  would present one GPU's workload as another's. */
export function podsForScope(rows: AllocRow[], scope: Scope): string[] {
  const wanted = new Set(
    (Array.isArray(scope.kind === 'device' ? (scope as any).gpuUuid : (scope as any).migUuid)
      ? (scope.kind === 'device' ? (scope as any).gpuUuid : (scope as any).migUuid)
      : [scope.kind === 'device' ? (scope as any).gpuUuid : (scope as any).migUuid]
    ).filter(Boolean),
  );
  if (wanted.size === 0) return [];

  const out = new Set<string>();
  for (const r of rows) {
    const key = scope.kind === 'device' ? r.metric.gpu_uuid : r.metric.mig_uuid;
    if (key && wanted.has(key) && r.metric.pod) out.add(r.metric.pod);
  }
  return [...out].sort();
}

/** eBPF pods that no allocation record covers in this window. Coverage is high but not
 *  guaranteed — measured 41/43 a few hours after measuring 43/43, because the two
 *  exporters' series have different lifetimes. The UI reports this count next to the
 *  control instead of silently narrowing. See 13 §11.1.2. */
export function unattributed(ebpfPods: string[], rows: AllocRow[]): string[] {
  const known = new Set(rows.map((r) => r.metric.pod).filter(Boolean));
  return ebpfPods.filter((p) => !known.has(p)).sort();
}

/** Pod names that occur in more than one namespace in this window. Substitution filters
 *  on k8s_pod_name alone, so such a name would over-match into a namespace that is not on
 *  the selected device. None exist on this cluster today (67 pairs / 67 names); this
 *  detects the case rather than assuming it away. See 13 §11.1.3. */
export function ambiguousNames(rows: AllocRow[]): string[] {
  const ns = new Map<string, Set<string>>();
  for (const r of rows) {
    const { pod, namespace } = r.metric;
    if (!pod) continue;
    (ns.get(pod) ?? ns.set(pod, new Set()).get(pod)!).add(namespace ?? '');
  }
  return [...ns.entries()].filter(([, s]) => s.size > 1).map(([p]) => p).sort();
}

/** Above this many pods the alternation approaches practical URL limits (measured: 40
 *  pods = 1030 chars). The caller then applies NO device filter and says so — a
 *  truncated regex would plot a subset while looking complete. See 13 §11.1.4. */
export const POD_FILTER_CAP = 200;
export function exceedsCap(pods: string[]): boolean {
  return pods.length > POD_FILTER_CAP;
}
```

- [ ] **Step 5: Run and watch it pass**

```bash
npx vitest run lib/correlate.test.ts
```
Expected: PASS, 13 tests.

- [ ] **Step 6: Wire it into the eBPF tab**

`app/page.tsx` fetches the allocation map **over the selected window**, alongside the other scope queries:

```ts
// MUST be windowed, never instant. gpu_alloc_device_pod_info describes CURRENT
// allocations: an instant query returns 0 series once the pods have finished (measured:
// 0 instant vs 67 over 24h), which would blank the whole tab for any historical range.
const span = Math.max(60, end - start);
api.query(`last_over_time(gpu_alloc_device_pod_info[${span}s])`)
   .then((r) => setAlloc(r.result)).catch(() => setAlloc([]));
```

On the eBPF tab, render **both** a GPU scope (cards *and* instances, since a pod runs on either) and the
existing Pod scope. The effective pod filter is the intersection:

```ts
// Device selection narrows to the pods that held it; Pod scope narrows further.
// Empty device selection means "no device filter", not "no pods".
const scoped = deviceSelection.length ? podsForScope(alloc, scopeFor(deviceSelection)) : null;
const effectivePods = scoped === null ? selPods
  : selPods.length ? selPods.filter((p) => scoped.includes(p)) : scoped;
vars = { gpu: [], pod: effectivePods };
```

Leave `$gpu` unsubstituted-to-`.*` on this tab — the device filter is expressed entirely through `$pod`, and
also constraining `gpu_uuid` would re-introduce the 3/43 problem.

**If a device selection resolves to zero pods, the panels must say so** rather than silently showing
everything: pass an empty pod list through, which yields an empty result and the existing
"No data in this range" state.

Three reports sit next to the control, each stating a limit rather than hiding it:
- `unattributed(...)` non-empty → "N pods not attributed to a device"
- `ambiguousNames(...)` non-empty → "N pod names exist in more than one namespace; attribution may
  over-match"
- `exceedsCap(...)` true → apply **no** device filter and say "too many pods to filter; showing all"

- [ ] **Step 6b: Prove the windowing fix against the live cluster**

```bash
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode 'q=count(gpu_alloc_device_pod_info)'
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode 'q=count(last_over_time(gpu_alloc_device_pod_info[24h]))'
```
Expected: the instant form returns an empty result or 0 while the windowed form returns dozens. If the
instant form is non-empty, a workload is running — stop it or wait, because this check only means something
when the pods have finished.

- [ ] **Step 7: Record the exporter gap**

Add to `docs-internal/09-risks-and-open-questions.md`, matching the file's existing entry format: the eBPF
exporter labels only 3 of 43 pods with `gpu_uuid` and emits no `GPU_I_ID`/`mig_uuid`, so device attribution
depends on joining `gpu_alloc_device_pod_info` by pod. Note that a future exporter fix should *remove* this
join rather than duplicate it. Link it to the existing R-7 memcpy-probe entry — both are eBPF-Lens gaps
found by the evaluation.

- [ ] **Step 8: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: 95 tests pass, tsc silent, build succeeds.

---

## Task 6: Partition GPU 1 into three instances

Fixes [14 §4.5](../14-metric-evaluation.md). One instance cannot reveal a cross-instance aggregation bug.

**This is the only destructive step in the plan. It destroys the existing `1g.6gb` instance.**

**Files:**
- Modify: `evaluation/run.sh` (the `--repartition` subcommand)

- [ ] **Step 1: Record the current layout so it can be restored**

```bash
nvidia-smi -L
sudo nvidia-smi mig -lgi
sudo nvidia-smi mig -lgip          # profiles this card supports
```
Write the output into `evaluation/mig-layout-before.txt`.

- [ ] **Step 2: Check nothing is using the instance**

```bash
kubectl get pods -A -o wide | grep -i a30-node
```
Any pod holding the MIG instance must be gone first. Destroying an instance out from under a running pod
is how you get a confusing failure two steps later.

- [ ] **Step 3: Repartition to a mixed layout**

`2g.12gb` + 2 × `1g.6gb`. **Mixed on purpose**: [02 A-8](../02-metric-catalog.md) says utilisation is
normalised *to the instance*, so the same workload must read differently on a `2g.12gb` than on a `1g.6gb`.
Four identical slices would hide a normalisation bug.

```bash
sudo nvidia-smi mig -dci && sudo nvidia-smi mig -dgi      # destroy compute instances, then GPU instances
sudo nvidia-smi mig -cgi 2g.12gb,1g.6gb,1g.6gb -C          # -C also creates the compute instances
sudo nvidia-smi mig -lgi
```
If the profile combination is rejected, fall back to `1g.6gb`×4 and **record that the size-mixing check
could not be performed** rather than silently accepting uniform slices.

- [ ] **Step 4: Confirm the stack sees all three**

```bash
kubectl -n gpu-operator rollout restart ds/nvidia-dcgm-exporter
kubectl -n gpu-operator rollout status ds/nvidia-dcgm-exporter --timeout=180s
sleep 60
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode 'q=DCGM_FI_DEV_FB_USED{GPU_I_ID!=""}'
```
Expected: three instance rows with distinct `GPU_I_ID` and the expected `GPU_I_PROFILE` values.

Also re-run the DCGM tripwire — a restart is a restart:
```bash
curl -s -G 'http://192.168.6.123:30802/api/query' \
  --data-urlencode 'q=count(count by (__name__) ({__name__=~"DCGM_.+"}))'
```
Expected: 33, unchanged.

- [ ] **Step 5: Check the node advertises them**

```bash
kubectl get node a30-node -o jsonpath='{.status.capacity}' | tr ',' '\n' | grep -i -E "nvidia|mig"
kubectl get resourceslice -o yaml 2>/dev/null | grep -iE "1g.6gb|2g.12gb" | head
```
GPUs are scheduled here through **DRA**, not `nvidia.com/gpu` — that resource is `0` on this node.

---

## Task 7: Re-run the evaluation across all instances

**Files:**
- Modify: `evaluation/run.sh`

- [ ] **Step 1: Add a per-instance target**

`--target mig` currently means "the one instance". Make it enumerate every instance from
`DCGM_FI_DEV_FB_USED{GPU_I_ID!=""}` and run one phase per instance, tagging each phase row with its
`GPU_I_ID` so the report can attribute per instance.

- [ ] **Step 2: Run the pipe suite on every instance**

```bash
bash evaluation/run.sh --all
```

- [ ] **Step 3: Re-report**

```bash
source .venv/bin/activate && python evaluation/report.py > evaluation/report.md
```
Expected: the MIG entities in the report are now three, not one.

- [ ] **Step 4: The check that needed three instances**

Run `pipe-exerciser --mode fp32` on the `2g.12gb` instance **only**, and confirm:
- the other two instances report near-zero for the same metric in that window — proving per-instance
  isolation rather than a value aggregated across the card,
- and that the busy instance's utilisation is normalised to itself ([02 A-8](../02-metric-catalog.md)),
  not to the whole card.

Record both readings. **If every instance moves together, that is a real defect** — either in the
dashboard's expressions or in the exporter — and it is exactly what a single instance could never show.

- [ ] **Step 5: Verify the UI against three instances**

Open the MIG tab. The instance picker must list three entries with their profiles, and selecting one must
change what the panels plot. This is the first time that control has been testable.

- [ ] **Step 6: Re-verify the MIG identifier bridge, which only ever had one row**

Task 5's eBPF MIG correlation depends on `mig_uuid` ↔ `GPU_I_ID`, and that mapping has only ever been
observed for a single instance. Three instances is the first real test of it:

```bash
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode \
  'q=last_over_time(nvml_gpu_memory_total_bytes{mig_uuid!=""}[1h])'
```
Expected: **three** rows, each with a distinct `mig_uuid` **and** a distinct `GPU_I_ID`, and `gpu_uuid` the
parent card. If any row is missing `GPU_I_ID`, or two instances share one, the bridge is broken and the eBPF
MIG selector cannot resolve — fix that before trusting Step 7.

- [ ] **Step 7: Prove eBPF correlation discriminates between instances**

The check that one instance could never support, and the reason the eBPF GPU selector exists:

1. Run `api-exerciser --mode malloc-free` on **instance A only**.
2. On the eBPF tab, select instance A → its panels show the run.
3. Select instance B → the same panels are empty for that window.

If both instances show the same data, the correlation is resolving to the parent card rather than the
instance, and `podsForScope` is matching on `gpu_uuid` where it should match `mig_uuid`.

---

## Verification summary

| Check | Command | Expected |
|---|---|---|
| UI tests | `npm test` | all pass |
| Types | `npx tsc --noEmit` | silent |
| Build | `npx next build` | succeeds |
| Extractor tests | `python -m pytest scripts/test_extract_panels.py -q` | pass |
| Dashboard contract | `python scripts/check-dashboards.py dashboards/*.json` | 0 problems |
| DCGM survived the MIG restart | tripwire query | 33, unchanged |
| 46-series panel shows its chart | eBPF tab in a browser | 8 chips + `Other — N more series`, plot visible |
| Custom range | pick a past 15-min window | panels redraw; invalid input disables Apply with a reason |
| Device tab | GPU scope at every range | exactly the physical cards, never a `MIG-…` |
| MIG tab | instance picker | three instances, each with its profile |
| eBPF GPU scope | select a card on the eBPF tab | panels redraw to that card's pods; 43/43 resolvable, vs 3/43 by eBPF's own label |
| eBPF MIG scope | select an instance on the eBPF tab | narrows to that instance's pods, not the whole card's |
| No over-matching | select a device with no pods | panels show "No data in this range", never every pod |
| Per-instance isolation | load one instance only | the other two stay near zero |
| Allocation lookup is windowed | instant vs `last_over_time` counts | instant ~0, windowed dozens; the UI uses the windowed form |
| Unattributed pods are reported | eBPF tab with a device selected | a count is shown, not silently narrowed |
| MIG bridge covers every instance | `nvml_gpu_memory_total_bytes{mig_uuid!=""}` | one row per instance, each with a distinct `GPU_I_ID` |
| eBPF correlation discriminates | load one instance, select the other | the other instance's panels are empty |

---

## Notes for the implementer

- **eBPF's own `gpu_uuid` is not a usable filter** (3 of 43 pods). Device scope on that tab is resolved
  through `gpu_alloc_device_pod_info` by pod, and must degrade to *no* pods rather than *all* pods.
- **`label_values(gpu_uuid)` is not a safe source for a picker.** Two exporters write that label with
  different meanings ([12 §2.3](../12-monitoring-ui.md)). Derive scope from DCGM.
- **Task 6 is destructive and irreversible without re-partitioning again.** Record the layout first, and
  make sure no pod holds the instance.
- **The legend cap is a display cap.** Never drop a series from the query to shorten the legend.
- **`GPU_I_ID=~".*"` matches the empty string**, so "All instances" needs `GPU_I_ID!=""` alongside it or a
  device row leaks onto the MIG dashboard.
- **Do not commit** without approval, per the project's CLAUDE.md.
