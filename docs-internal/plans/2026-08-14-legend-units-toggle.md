# Legend, Units and Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Name every series in the legend, let a click hide or isolate one, and put a unit on every number the UI displays.

**Architecture:** The legend stops folding names and starts capping height instead — content is scrolled, not deleted. Visibility becomes per-panel view state that drives Chart.js `dataset.hidden`, leaving colour assignment untouched so nothing repaints. `formatValue` gains the two missing units and is applied at the three surfaces that skip it today.

**Tech Stack:** TypeScript/React (Next.js 15), Chart.js 4, vitest.

**Spec:** [13 §8, §9, §9.1](../13-ui-visual-design.md).

---

## Working directory

`/home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/feature-monitoring-ui`, UI commands from
`services/advanced-monitoring-ui/`: `npm test`, `npx tsc --noEmit`, `npx next build`.

**Currently 109 tests pass.**

**Measured facts — do not re-derive, do not contradict:**

| Fact | Value |
|---|---|
| Worst-case series on one panel | **47** (`ebpf_cuda_kernel_launch_calls_total`, eBPF tab at 7d) |
| Tooltip formatting | `plugins.tooltip` has **no `callbacks.label`** → Chart.js prints the raw number, 42 panels |
| Table formatting | `TablePanel` pushes `s.value[1]` verbatim; `formatValue` is not imported, 5 panels |
| Unit `s` | 6 panels; unhandled → `si()` renders a 0.000123 s latency as **`0.00`** |
| Unit `ops` | 4 panels; unhandled → loses the rate suffix |
| y-axis, stat, gauge, bargauge | already formatted — **do not touch** |

---

## Task 1: `formatValue` gains the two missing units

Fixes [13 §8](../13-ui-visual-design.md). Do this first: Tasks 2 and 3 both display values through it.

**Files:**
- Modify: `services/advanced-monitoring-ui/lib/format.ts`, `lib/format.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/format.test.ts`:

```ts
describe('formatValue — seconds', () => {
  it('renders sub-millisecond latency in µs rather than collapsing to 0.00', () => {
    // The bug this fixes: si() rendered 0.000123 as "0.00", destroying the value.
    // Every eBPF latency panel is a P95/P99 in seconds, so they all read as nothing.
    expect(formatValue(0.000123, 's')).toBe('123 µs');
  });

  it('scales through ns, µs, ms and s', () => {
    expect(formatValue(0.000000045, 's')).toBe('45 ns');
    expect(formatValue(0.0034, 's')).toBe('3.4 ms');
    expect(formatValue(2.5, 's')).toBe('2.5 s');
  });

  it('keeps large durations in seconds rather than inventing minutes', () => {
    expect(formatValue(3600, 's')).toBe('3600 s');
  });

  it('renders zero without a spurious unit jump', () => {
    expect(formatValue(0, 's')).toBe('0 s');
  });
});

describe('formatValue — ops', () => {
  it('keeps the rate suffix', () => {
    expect(formatValue(1234, 'ops')).toBe('1.2K ops/s');
    expect(formatValue(7, 'ops')).toBe('7.00 ops/s');
  });
});

describe('formatValue — bytes stay IEC', () => {
  it('renders MiB, not decimal MB', () => {
    // Deliberate: DCGM reports FB_USED in MiB (02 §0.3) and Grafana's `bytes` unit is
    // IEC. Decimal MB would put this UI 4.9% adrift of Grafana on the same metric.
    expect(formatValue(12616466432, 'bytes')).toBe('11.8 GiB');
    expect(formatValue(5 * 1024 * 1024, 'bytes')).toBe('5.0 MiB');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd services/advanced-monitoring-ui && npx vitest run lib/format.test.ts
```
Expected: FAIL — `expected '0.00' to be '123 µs'` and similar.

- [ ] **Step 3: Implement**

In `lib/format.ts`, add two cases to the switch and one helper:

```ts
    case 's':           return duration(v);
    case 'ops':         return `${si(v, '')} ops/s`;
```

```ts
/** Seconds, scaled down. A GPU latency is usually microseconds, and rendering it through
 *  the plain SI helper collapsed it to "0.00" — the panel then looked idle when it was
 *  merely fast. Scales down only: 3600 s stays "3600 s" rather than becoming "1 h",
 *  because these are durations of operations, not wall-clock spans. */
function duration(v: number): string {
  if (v === 0) return '0 s';
  const abs = Math.abs(v);
  if (abs < 1e-6) return `${round(v * 1e9)} ns`;
  if (abs < 1e-3) return `${round(v * 1e6)} µs`;
  if (abs < 1)    return `${round(v * 1e3)} ms`;
  return `${round(v)} s`;
}

/** One decimal below 10, none above — enough to separate 3.4 ms from 3.9 ms without
 *  implying precision the histogram bucket does not have. */
function round(v: number): string {
  return Math.abs(v) < 10 ? String(Number(v.toFixed(1))) : String(Math.round(v));
}
```

- [ ] **Step 4: Run and watch them pass**

```bash
npx vitest run lib/format.test.ts && npx tsc --noEmit
```
Expected: PASS; tsc silent.

---

## Task 2: Apply the unit at the two surfaces that skip it

**Files:**
- Modify: `services/advanced-monitoring-ui/components/panels/TimeSeriesPanel.tsx`,
  `components/panels/TablePanel.tsx`

- [ ] **Step 1: The tooltip**

In `TimeSeriesPanel.tsx`, the `plugins.tooltip` block has no `callbacks`. Add one:

```ts
              callbacks: {
                // Without this Chart.js prints the raw number: a memory panel showed
                // "12616466432" where it meant 11.8 GiB. See 13 §8.
                label: (ctx: any) =>
                  `${ctx.dataset.label}: ${formatValue(ctx.parsed.y, spec.unit)}`,
              },
```

Keep every existing tooltip style property. `formatValue` is already imported in this file for the axis
ticks — do not add a second import.

- [ ] **Step 2: The table**

`TablePanel.tsx` line ~42 builds each row as
`[...keys.map((k) => s.metric[k] ?? ''), s.value[1]]` — the last element is the raw Prometheus string.
Import `formatValue` and format only that value column, leaving the label columns as text:

```ts
        setRows(r.result.map((s: any) => [
          ...keys.map((k) => s.metric[k] ?? ''),
          formatValue(Number(s.value[1]), spec.unit),
        ]));
```

Note the 5 table panels carry **no** `unit`, so `formatValue` falls to its SI default — which is still a
large improvement over a raw string, and correct for the counts these tables show. Do not invent units for
them in the dashboard JSON; `dashboards/` is out of scope here.

- [ ] **Step 3: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: all pass.

---

## Task 3: List every series, and make clicking one toggle it

Fixes [13 §9 and §9.1](../13-ui-visual-design.md). **This reverses the earlier fold** — that decision
answered "the legend is too tall" by deleting information, and a panel that will not say what it is plotting
is not fixed.

**Files:**
- Modify: `services/advanced-monitoring-ui/lib/legend.ts`, `lib/legend.test.ts`,
  `components/Legend.tsx`, `components/panels/TimeSeriesPanel.tsx`

- [ ] **Step 1: Write the failing tests**

Replace the folding tests in `lib/legend.test.ts` — they encode the behaviour being removed. Keep the
ordering tests, which still hold.

```ts
describe('legendItems', () => {
  it('lists every series, however many there are', () => {
    // Reverses the earlier Other-fold: naming 8 of 47 hid what the panel was plotting.
    const items = [
      ...SERIES.map((c, i) => ({ label: `hued-${i}`, color: c })),
      ...Array.from({ length: 39 }, (_, i) => ({ label: `grey-${i}`, color: OTHER })),
    ];
    const r = legendItems(items);
    expect(r).toHaveLength(47);
    expect(r.some((x) => x.label.startsWith('Other —'))).toBe(false);
  });

  it('still orders by palette slot, hued first', () => {
    const items = [
      { label: 'grey', color: OTHER },
      { label: 'third', color: SERIES[2] },
      { label: 'first', color: SERIES[0] },
    ];
    expect(legendItems(items).map((x) => x.label)).toEqual(['first', 'third', 'grey']);
  });

  it('leaves a single series unlisted — the panel title names it', () => {
    expect(legendItems([{ label: 'only', color: SERIES[0] }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run lib/legend.test.ts
```
Expected: FAIL — `expected length 9 to be 47`.

- [ ] **Step 3: Implement the listing**

```ts
/** Every series, ordered by palette slot so hued rows come first and row n is series
 *  colour n. Nothing is folded: an earlier version summarised everything past the eighth
 *  as "Other — N more series", which answered a height problem by deleting information.
 *  Height is capped by the container instead (13 §9).
 *
 *  Colour still stops at eight (§1.2 is a CVD-validated set), so rows past the eighth
 *  share the muted Other colour and are told apart by isolating them (§9.1). */
export function legendItems(items: { label: string; color: string }[]): LegendRow[] {
  if (items.length < 2) return [];
  const slot = new Map(SERIES.map((c, i) => [c, i]));
  return [...items]
    .sort((a, b) => (slot.get(a.color) ?? SERIES.length) - (slot.get(b.color) ?? SERIES.length))
    .map((i) => ({ ...i }));
}
```

- [ ] **Step 4: Write the failing test for visibility state**

Toggling is view state and must be a pure function so it is testable. Add `lib/visibility.ts` +
`lib/visibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toggle, isolate, isHidden } from './visibility';

describe('toggle', () => {
  it('hides a visible series and shows a hidden one', () => {
    expect(isHidden(toggle(new Set(), 'a'), 'a')).toBe(true);
    expect(isHidden(toggle(new Set(['a']), 'a'), 'a')).toBe(false);
  });

  it('does not disturb the other series', () => {
    const r = toggle(new Set(['b']), 'a');
    expect(isHidden(r, 'b')).toBe(true);
  });
});

describe('isolate', () => {
  it('hides every series except the chosen one', () => {
    const r = isolate(['a', 'b', 'c'], 'b');
    expect(isHidden(r, 'a')).toBe(true);
    expect(isHidden(r, 'b')).toBe(false);
    expect(isHidden(r, 'c')).toBe(true);
  });

  it('un-isolates when the already-isolated series is isolated again', () => {
    // Otherwise alt-clicking the same row twice is a dead end with 46 hidden series.
    const once = isolate(['a', 'b', 'c'], 'b');
    expect(isolate(['a', 'b', 'c'], 'b', once).size).toBe(0);
  });
});
```

- [ ] **Step 5: Run, watch it fail, then implement**

```ts
/** Which series a panel is currently hiding, keyed by series key. View state only: it is
 *  per panel and resets on reload, because a hidden series is a temporary act of looking
 *  and silently restoring one across sessions would mean a panel that hides data without
 *  saying so (13 §9.1). */
export function isHidden(hidden: Set<string>, key: string): boolean {
  return hidden.has(key);
}

export function toggle(hidden: Set<string>, key: string): Set<string> {
  const next = new Set(hidden);
  next.has(key) ? next.delete(key) : next.add(key);
  return next;
}

/** Show only `key`. Isolating the series that is already the only visible one clears the
 *  isolation instead — without that, alt-clicking twice strands the reader with 46 hidden
 *  series and no obvious way back. */
export function isolate(allKeys: string[], key: string, current?: Set<string>): Set<string> {
  const alreadyIsolated =
    current !== undefined &&
    !current.has(key) &&
    allKeys.every((k) => k === key || current.has(k));
  return alreadyIsolated ? new Set() : new Set(allKeys.filter((k) => k !== key));
}
```

- [ ] **Step 6: Wire the interaction**

`Legend.tsx` gains `onToggle(key, isolate: boolean)` and `hidden: Set<string>`; each row becomes a
`<button type="button">` with `aria-pressed={!hidden}`, dimmed (`opacity: 0.45`) while hidden, and
`onClick={(e) => onToggle(key, e.altKey || e.metaKey)}`. Rows need a stable `key` — pass the series key
alongside the label, do not key on the label text, which can repeat.

`TimeSeriesPanel.tsx` holds `const [hidden, setHidden] = useState<Set<string>>(new Set())` and applies it
when building datasets: `hidden: isHidden(hidden, seriesKey(s.metric))`. After a toggle, call
`chart.current.update()` — **do not rebuild the chart**, which would lose the double-`requestAnimationFrame`
creation path and flicker.

The container gains `maxHeight: '7.5rem', overflowY: 'auto'` (about five rows) and the canvas wrapper keeps
its `minHeight`.

- [ ] **Step 7: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
grep -rn '#[0-9a-fA-F]\{6\}' components app --include=*.tsx   # must be empty
```
Expected: ~120 tests pass.

---

## Task 4: Deploy and look at it

None of this is provable by unit test alone.

- [ ] **Step 1: Build and roll out**

```bash
cd ../.. && SHA=$(git rev-parse --short HEAD)-legend-units && REG=192.168.6.123:30080/library
docker build -t $REG/advanced-monitoring-ui:$SHA services/advanced-monitoring-ui
docker push $REG/advanced-monitoring-ui:$SHA
kubectl -n gpu-monitoring set image deploy/advanced-monitoring-ui ui=$REG/advanced-monitoring-ui:$SHA
kubectl -n gpu-monitoring rollout status deploy/advanced-monitoring-ui --timeout=180s
```

- [ ] **Step 2: Check each claim in a browser**

Chromium at `/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell`;
`playwright-core` is in `services/advanced-monitoring-ui/node_modules` and the driver script must live in
that directory. **Viewport screenshots, not `fullPage`** — fullPage resizes the viewport and makes Chart.js
canvases redraw tiny.

On http://192.168.6.123:30802/, eBPF tab at 7d, "1. Compute Activity":

| Check | Expected |
|---|---|
| All series listed | 47 legend rows, scrollable, **no** `Other — N more series` |
| Plot survives | the chart is still visible below the legend |
| Click toggles | click a row → that line disappears, the row dims; click again → returns in the **same** colour |
| Alt-click isolates | only that series plots, and the y-axis rescales to it |
| Tooltip units | hover a memory panel → `11.8 GiB`, not `12616466432` |
| Latency readable | a P95 panel shows `123 µs`-style values, not `0.00` |
| Table formatted | no raw Prometheus value strings in the 5 table panels |

Read the PNGs back with the Read tool and describe what is actually visible. Delete the driver script.

---

## Notes for the implementer

- **The fold is being deliberately reversed.** Do not reintroduce `Other — N more series`; if the legend is
  too tall, the container's `max-height` is the lever, not the content.
- **Colour still stops at eight.** Series past the eighth share `OTHER`. Do not generate a ninth hue — the
  palette is CVD-validated as a set.
- **Hiding must not free a colour slot.** `assignColors(series, previous)` retains slots; a hidden series
  keeps its hue so unhiding restores it and neighbours never repaint.
- **Leave alone:** the double-`requestAnimationFrame` chart-creation path, `resolveRange`'s `useMemo` keyed
  on `[range, tick]`, the `__none__` sentinel, and the already-correct axis/stat/gauge/bargauge formatting.
- **Bytes stay IEC.** MiB/GiB, matching Grafana and DCGM's own MiB reporting. See [13 §8](../13-ui-visual-design.md).
- **Do not commit** without approval, per the project's CLAUDE.md.
