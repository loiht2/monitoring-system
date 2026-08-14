# Monitoring UI Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the advanced monitoring UI legible and good-looking, and make the 27 currently-dead eBPF panels render.

**Architecture:** All colour moves to one token module with a validator-checked palette; series colours are allocated by entity key rather than array position. Template-variable substitution is generalised so `$pod`, `$__range` and `$__rate_interval` resolve. The page gains a shell (app bar, tabs, context banner, labelled control bar, row cards) and the seven existing renderers are restyled. No panel is added or removed — `panels.json` stays derived from the Grafana JSON.

**Tech Stack:** Next.js 15 (App Router, standalone), React 19, TypeScript, Chart.js 4, vitest; FastAPI + httpx + pytest on the API side; Python 3 for the extractor.

**Spec:** [13 — UI visual design](../13-ui-visual-design.md). Section references below point there.

---

## Working directory

Everything is relative to `/home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/feature-monitoring-ui`.

UI commands run from `services/advanced-monitoring-ui/`:

```bash
npm test            # vitest run
npx tsc --noEmit    # the real correctness gate
npx next build      # production build
```

API commands run from `services/advanced-monitoring-api/`: `python -m pytest -q`.
Extractor tests run from the repo root: `python -m pytest scripts/test_extract_panels.py -q`.

---

## File structure

**New — UI:**

| File | Responsibility |
|---|---|
| `lib/theme.ts` | Every colour and spacing token. The only file with a hex literal |
| `lib/theme.test.ts` | Asserts the palette matches the validated set and slots are unique |
| `lib/series.ts` | Series key derivation, stable slot allocation, the "Other" fold |
| `lib/series.test.ts` | Slot stability under re-ordering and filtering |
| `components/Legend.tsx` | External legend chips, shared by every multi-series renderer |
| `components/AppShell.tsx` | App bar, page header, dashboard tabs |
| `components/ContextBanner.tsx` | The dashboard description banner, tone by dashboard |
| `components/ControlBar.tsx` | Labelled scope / range / refresh controls |
| `components/ScopeSelect.tsx` | Popover multi-select with a summary label |
| `components/RowSection.tsx` | Collapsible row card with panel count |

**Modified — UI:** `app/globals.css`, `app/page.tsx`, `lib/promql.ts`, `lib/api.ts`, `components/PanelFrame.tsx`, `components/PanelGrid.tsx`, all seven of `components/panels/*.tsx`.

**Modified — other:** `scripts/extract-panels.py`, `scripts/test_extract_panels.py`, `services/advanced-monitoring-api/app/main.py`, `app/prometheus.py`, `tests/test_routes.py`.

---

## Task 0: Reset the unreviewed restyle

`PanelFrame.tsx` (+164 lines) and `PanelGrid.tsx` (+60) picked up an unrequested visual restyle — state chips, "Live data" badges, dashed empty-state boxes, CSS-variable hooks — while implementing the `gpu_metric_supported` wiring. None of it was reviewed and all of it is superseded by §3 of the spec. Start from a known baseline so the redesign is the only change in the diff.

**Files:**
- Modify: `services/advanced-monitoring-ui/components/PanelFrame.tsx`
- Modify: `services/advanced-monitoring-ui/components/PanelGrid.tsx`
- Delete: `services/advanced-monitoring-ui/app/page.tsx.orig`

- [ ] **Step 1: Inspect what the restyle added**

```bash
cd /home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/feature-monitoring-ui
git diff services/advanced-monitoring-ui/components/PanelFrame.tsx
```

- [ ] **Step 2: Restore both files to HEAD, then re-apply only the `supported` prop threading**

```bash
git checkout -- services/advanced-monitoring-ui/components/PanelFrame.tsx \
                services/advanced-monitoring-ui/components/PanelGrid.tsx
rm -f services/advanced-monitoring-ui/app/page.tsx.orig
```

`PanelFrame` at HEAD takes `{title, description, state, children}` and needs no `supported` prop — only `PanelGrid` threads it. Re-add to `PanelGrid.tsx` exactly this, and nothing else: `supported: Record<string, boolean>` in the props type, and `supported={supported}` on each of the seven renderer calls in `render(...)`.

- [ ] **Step 3: Verify the baseline is clean and still passes**

```bash
cd services/advanced-monitoring-ui && npm test && npx tsc --noEmit
```
Expected: 20 tests pass, tsc silent. `git diff --stat` for `PanelGrid.tsx` should now be roughly +10, not +60.

- [ ] **Step 4: Commit**

```bash
git add -A services/advanced-monitoring-ui
git commit -m "reset unreviewed panel restyle to baseline"
```

---

## Task 1: Design tokens

**Files:**
- Create: `services/advanced-monitoring-ui/lib/theme.ts`
- Create: `services/advanced-monitoring-ui/lib/theme.test.ts`
- Modify: `services/advanced-monitoring-ui/app/globals.css`

- [ ] **Step 1: Write the failing test**

`lib/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SERIES, SURFACE, INK, STATUS, SEQUENTIAL, OTHER } from './theme';

describe('theme', () => {
  it('uses the eight validated dark-mode series steps, in order', () => {
    // Validated by dataviz scripts/validate_palette.js against SURFACE.panel (#131922):
    // all five checks PASS. Changing any hex invalidates that result — re-run it.
    expect(SERIES).toEqual([
      '#3987e5', '#d95926', '#199e70', '#c98500',
      '#d55181', '#008300', '#9085e9', '#e66767',
    ]);
  });

  it('has no duplicate series slots', () => {
    expect(new Set(SERIES).size).toBe(SERIES.length);
  });

  it('keeps status colours out of the series palette', () => {
    for (const s of Object.values(STATUS)) expect(SERIES).not.toContain(s);
  });

  it('renders the sequential ramp dark to light for a dark surface', () => {
    // Low values recede into the surface; high values stand off it.
    expect(SEQUENTIAL[0]).toBe('#0d366b');
    expect(SEQUENTIAL[SEQUENTIAL.length - 1]).toBe('#cde2fb');
  });

  it('folds the ninth and later series into a muted Other, not a generated hue', () => {
    expect(OTHER).toBe(INK.muted);
    expect(SERIES).not.toContain(OTHER);
  });

  it('exposes the surfaces the palette was validated against', () => {
    expect(SURFACE.panel).toBe('#131922');
    expect(SURFACE.page).toBe('#0b0f16');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd services/advanced-monitoring-ui && npx vitest run lib/theme.test.ts
```
Expected: FAIL — `Failed to resolve import "./theme"`.

- [ ] **Step 3: Write `lib/theme.ts`**

```ts
/** Every colour in the UI. Nothing else may hold a hex literal.
 *
 *  The series palette is the reference dark-mode column, validated against SURFACE.panel
 *  with the dataviz skill's scripts/validate_palette.js — all five checks pass (lightness
 *  band, chroma floor, CVD separation, normal-vision floor, contrast). Editing any hex
 *  invalidates that; re-run the validator rather than reasoning about it.
 *  See docs-internal/13-ui-visual-design.md §1.
 */

export const SURFACE = {
  page:   '#0b0f16',
  panel:  '#131922',
  raised: '#1a212c',
  border: 'rgba(255,255,255,0.08)',
  grid:   'rgba(255,255,255,0.06)',
} as const;

export const INK = {
  primary:   '#e6edf3',
  secondary: '#9aa7b4',
  muted:     '#6e7d8d',
} as const;

export const SERIES = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#008300', '#9085e9', '#e66767',
] as const;

/** The ninth and later series. Never a generated hue — see §1.3. */
export const OTHER = INK.muted;

/** Reserved for state. Never used for a series, and never the only cue. */
export const STATUS = {
  good:     '#0ca30c',
  warning:  '#fab219',
  serious:  '#ec835a',
  critical: '#d03b3b',
} as const;

/** One hue, dark → light: on a dark surface the near-zero end is the end that recedes. */
export const SEQUENTIAL = [
  '#0d366b', '#184f95', '#1c5cab', '#256abf',
  '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#cde2fb',
] as const;

export const RADIUS = 10;
```

- [ ] **Step 4: Run the test again**

```bash
npx vitest run lib/theme.test.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Re-derive the CSS variables from the same values**

Replace `app/globals.css` entirely:

```css
:root {
  --bg-page: #0b0f16;
  --bg-panel: #131922;
  --bg-raised: #1a212c;
  --border-color: rgba(255, 255, 255, 0.08);
  --grid-color: rgba(255, 255, 255, 0.06);
  --text-main: #e6edf3;
  --text-muted: #9aa7b4;
  --text-dim: #6e7d8d;
  --accent: #3987e5;
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
  --radius: 10px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg-page);
  color: var(--text-main);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}

/* Columns that must align vertically get tabular figures; standalone numbers do not.
   Scoped to .tabular rather than every th/td: a text cell in tabular figures just looks
   wrong, and the hero/stat values must keep proportional figures. */
.tabular { font-variant-numeric: tabular-nums; }

button { font: inherit; color: inherit; }
```

Then update the fallbacks in existing components: `var(--bg-panel,#161b22)` → `var(--bg-panel)` and `var(--border-color,#30363d)` → `var(--border-color)`, in `components/PanelFrame.tsx` and `app/page.tsx`. The old fallback hexes are the pre-redesign surface and must not survive.

- [ ] **Step 6: Verify nothing broke**

```bash
npm test && npx tsc --noEmit
```
Expected: 26 tests pass, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add services/advanced-monitoring-ui/lib/theme.ts \
        services/advanced-monitoring-ui/lib/theme.test.ts \
        services/advanced-monitoring-ui/app/globals.css \
        services/advanced-monitoring-ui/components/PanelFrame.tsx \
        services/advanced-monitoring-ui/app/page.tsx
git commit -m "add design tokens with the validated dark series palette"
```

---

## Task 2: Series slot allocation

Fixes two rule violations: colour assigned by array position (`SERIES_COLORS[datasets.length % 8]`), and a ninth series wrapping back to slot 1.

**Files:**
- Create: `services/advanced-monitoring-ui/lib/series.ts`
- Create: `services/advanced-monitoring-ui/lib/series.test.ts`

- [ ] **Step 1: Write the failing test**

`lib/series.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { seriesKey, assignColors } from './series';
import { SERIES, OTHER } from './theme';

describe('seriesKey', () => {
  it('is independent of label insertion order', () => {
    expect(seriesKey({ pod: 'a', gpu: '1' })).toBe(seriesKey({ gpu: '1', pod: 'a' }));
  });

  it('separates series that differ in any label', () => {
    expect(seriesKey({ pod: 'a' })).not.toBe(seriesKey({ pod: 'b' }));
  });
});

describe('assignColors', () => {
  it('gives each series a distinct slot', () => {
    const c = assignColors([{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }]);
    expect(new Set(Object.values(c)).size).toBe(3);
  });

  it('keeps a series colour when the input order changes', () => {
    // Colour follows the entity, not its rank: re-sorting must not repaint anything.
    const forward = assignColors([{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }]);
    const reverse = assignColors([{ pod: 'c' }, { pod: 'b' }, { pod: 'a' }]);
    expect(reverse).toEqual(forward);
  });

  it('keeps survivors on their colour when a series is filtered out', () => {
    // The freed slot must NOT be back-filled: dropping 'b' has to leave 'c' where it was.
    // This is why the previous assignment is an input — see §1.3.
    const all = assignColors([{ pod: 'a' }, { pod: 'b' }, { pod: 'c' }]);
    const fewer = assignColors([{ pod: 'a' }, { pod: 'c' }], all);
    expect(fewer[seriesKey({ pod: 'a' })]).toBe(all[seriesKey({ pod: 'a' })]);
    expect(fewer[seriesKey({ pod: 'c' })]).toBe(all[seriesKey({ pod: 'c' })]);
  });

  it('gives a genuinely new series the lowest free slot', () => {
    const prev = { [seriesKey({ pod: 'a' })]: SERIES[1] };
    const next = assignColors([{ pod: 'a' }, { pod: 'z' }], prev);
    expect(next[seriesKey({ pod: 'a' })]).toBe(SERIES[1]);   // retained
    expect(next[seriesKey({ pod: 'z' })]).toBe(SERIES[0]);   // lowest free
  });

  it('carries a filtered-out series forward so its slot stays reserved', () => {
    const all = assignColors([{ pod: 'a' }, { pod: 'b' }]);
    const fewer = assignColors([{ pod: 'a' }], all);
    expect(fewer[seriesKey({ pod: 'b' })]).toBe(all[seriesKey({ pod: 'b' })]);
  });

  it('folds the ninth series into Other rather than reusing slot 1', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ pod: `p${String(i).padStart(2, '0')}` }));
    const c = assignColors(many);
    const used = Object.values(c);
    expect(used.filter((x) => x === OTHER).length).toBe(2);
    expect(used.filter((x) => x === SERIES[0]).length).toBe(1);
  });

  it('uses every slot before folding', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ pod: `p${i}` }));
    expect(new Set(Object.values(assignColors(eight)))).toEqual(new Set(SERIES));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run lib/series.test.ts
```
Expected: FAIL — `Failed to resolve import "./series"`.

- [ ] **Step 3: Write `lib/series.ts`**

```ts
import { SERIES, OTHER } from './theme';

/** A series' identity: its label set, order-independent.
 *  Length-prefixing each part keeps `{a:'b:c'}` distinct from `{'a:b':'c'}`. */
export function seriesKey(labels: Record<string, string>): string {
  return Object.keys(labels).sort()
    .map((k) => `${k.length}:${k}=${labels[k].length}:${labels[k]}`)
    .join(',');
}

/** Map each series to a colour, keyed by identity so re-ranking or filtering never
 *  repaints a survivor. New keys take the lowest free slot in sorted-key order —
 *  deterministic, and independent of the order the query happened to return.
 *
 *  `previous` is the panel's existing assignment. Everything in it is retained, including
 *  series not in `series` any more: their slots stay reserved. Without that, dropping one
 *  series lets the next one slide into the freed slot and change colour, which is exactly
 *  what "colour follows the entity, not its rank" forbids. Callers hold this map in a ref
 *  across refreshes, per panel. See §1.3.
 *
 *  `previous` has no default **deliberately**. A renderer that wrote `assignColors(series)`
 *  and forgot to thread its ref would compile, pass every test, and silently restore the
 *  rank-based repainting this function exists to prevent — a visual bug no test can see.
 *  Requiring the argument makes that omission a type error. Passing a literal `{}` is
 *  still possible but is now a visible, deliberate act.
 *
 *  Past eight series there is no ninth hue: the remainder folds into one muted Other. */
export function assignColors(
  series: Record<string, string>[],
  previous: Record<string, string>,        // required on purpose — see below
): Record<string, string> {
  const out: Record<string, string> = { ...previous };
  const taken = new Set(Object.values(out));
  const fresh = [...new Set(series.map(seriesKey))].filter((k) => !(k in out)).sort();

  for (const k of fresh) {
    const free = SERIES.find((c) => !taken.has(c));
    out[k] = free ?? OTHER;
    if (free) taken.add(free);
  }
  return out;
}
```

- [ ] **Step 4: Run the test again**

```bash
npx vitest run lib/series.test.ts
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/lib/series.ts services/advanced-monitoring-ui/lib/series.test.ts
git commit -m "allocate series colours by entity key instead of array position"
```

---

## Task 3: Template-variable substitution

This is what makes 27 dead panels render. Do it before restyling anything you cannot see.

**Files:**
- Modify: `services/advanced-monitoring-ui/lib/promql.ts`
- Modify: `services/advanced-monitoring-ui/lib/promql.test.ts`

- [ ] **Step 1: Write the failing tests**

The signature gains a third argument, so the file's **existing** `substituteVars` tests stop compiling.
Update each existing call to pass an options object before appending the new cases:

```ts
const OPTS = { rangeSeconds: 3600, step: 18, scrapeInterval: 30 };
// e.g. substituteVars('x{g=~"$gpu"}', { gpu: ['a'] })  →
//      substituteVars('x{g=~"$gpu"}', { gpu: ['a'] }, OPTS)
```

Then append to `lib/promql.test.ts`:

```ts
import { substituteVars, formatDuration, rateInterval } from './promql';

describe('formatDuration', () => {
  it('renders seconds, minutes, hours and days as PromQL literals', () => {
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(45)).toBe('45s');
  });

  it('falls back to seconds when the range is not a whole unit', () => {
    expect(formatDuration(5400)).toBe('5400s');
  });
});

describe('rateInterval', () => {
  it('is never narrower than four scrape intervals', () => {
    // A rate window narrower than the true scrape interval yields gaps.
    expect(rateInterval(1, 30)).toBe('120s');
  });

  it('widens with the step once the step dominates', () => {
    expect(rateInterval(300, 30)).toBe('330s');
  });
});

describe('substituteVars — built-ins', () => {
  const opts = { rangeSeconds: 3600, step: 18, scrapeInterval: 30 };

  it('resolves $__range to the selected range', () => {
    expect(substituteVars('increase(x[$__range])', {}, opts)).toBe('increase(x[1h])');
  });

  it('resolves $__rate_interval', () => {
    expect(substituteVars('rate(x[$__rate_interval])', {}, opts)).toBe('rate(x[120s])');
  });

  it('resolves $__all like an empty selection', () => {
    expect(substituteVars('x{p=~"$__all"}', {}, opts)).toBe('x{p=~".*"}');
  });

  it('substitutes pod alongside gpu', () => {
    expect(substituteVars('x{pod=~"$pod",gpu=~"$gpu"}', { pod: ['a'], gpu: ['g1'] }, opts))
      .toBe('x{pod=~"a",gpu=~"g1"}');
  });

  it('leaves no literal $ in a real eBPF expression', () => {
    const expr = 'sum(increase(ebpf_cuda_kernel_launch_calls_total'
               + '{k8s_pod_name=~"$pod",gpu_uuid=~"$gpu"}[$__range]))';
    expect(substituteVars(expr, { pod: [], gpu: [] }, opts)).not.toContain('$');
  });

  it('does not mistake $__rate_interval for $__range', () => {
    // $__range is a prefix of nothing, but naive ordering can corrupt longer names.
    expect(substituteVars('rate(x[$__rate_interval])', {}, opts)).not.toContain('range');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run lib/promql.test.ts
```
Expected: FAIL — `formatDuration is not a function`, and `substituteVars` takes two arguments.

- [ ] **Step 3: Rewrite `lib/promql.ts`**

```ts
/** Template-variable substitution and range-step derivation.
 *
 * The panel spec stores Grafana's expressions verbatim, including `$gpu`, `$pod` and
 * Grafana's built-ins. Substituting here — immediately before the request — keeps the
 * stored spec byte-identical to the Grafana source it was extracted from.
 *
 * Until this handled the built-ins, all 27 eBPF panels sent literal `$__range` to
 * Prometheus, got a 400, and rendered as "No data in this range". See
 * docs-internal/13-ui-visual-design.md §0.2.
 */

/** Escape a label value so it cannot change the meaning of the surrounding regex. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Seconds as a PromQL duration literal, whole units only. */
export function formatDuration(seconds: number): string {
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/** Grafana's own rule: max(step + scrape, 4 × scrape). Narrower than the real scrape
 *  interval and the rate window straddles too few samples, producing gaps. */
export function rateInterval(step: number, scrapeInterval: number): string {
  return `${Math.max(step + scrapeInterval, 4 * scrapeInterval)}s`;
}

export interface SubstituteOptions {
  rangeSeconds: number;
  step: number;
  scrapeInterval: number;
}

export function substituteVars(
  expr: string,
  vars: Record<string, string[]>,
  opts: SubstituteOptions,
): string {
  let out = expr;

  // Built-ins first, longest name first so `$__rate_interval` is never matched as a
  // prefix by a shorter built-in.
  const builtins: [string, string][] = [
    ['$__rate_interval', rateInterval(opts.step, opts.scrapeInterval)],
    ['$__range', formatDuration(opts.rangeSeconds)],
    ['$__all', '.*'],
  ];
  for (const [name, value] of builtins) out = out.split(name).join(value);

  for (const [name, values] of Object.entries(vars)) {
    const selected = values.filter((v) => v !== 'All');
    // Empty or "All" means every series — `.*` rather than an empty alternation,
    // which would match only the empty string and silently blank the panel.
    const repl = selected.length ? selected.map(escapeRe).join('|') : '.*';
    out = out.split(`$${name}`).join(repl);
  }
  return out;
}

/** Pick a step that keeps a range query near 200 points, so wide ranges stay cheap. */
export function deriveStep(rangeSeconds: number, targetPoints = 200): number {
  return Math.max(1, Math.floor(rangeSeconds / targetPoints));
}

/** Matches the widest ServiceMonitor interval in deploy/a30-node/. The widest is the safe
 *  choice: a rate window sized for a faster scrape than the real one yields gaps. */
export const SCRAPE_INTERVAL_SECONDS = 30;
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run lib/promql.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update every caller**

`substituteVars` now takes three arguments. Update all seven renderers in `components/panels/` and the `gpu_metric_supported` query in `app/page.tsx`. Each renderer already computes `rangeSeconds` or receives it; instant-query renderers (`StatPanel`, `GaugePanel`, `BarGaugePanel`, `TablePanel`) need `rangeSeconds` added to their props so `$__range` resolves — `PanelGrid` passes it.

The options object at each call site:

```ts
const opts = { rangeSeconds, step: deriveStep(rangeSeconds), scrapeInterval: SCRAPE_INTERVAL_SECONDS };
```

- [ ] **Step 6: Verify the whole suite and the types**

```bash
npm test && npx tsc --noEmit
```
Expected: all tests pass, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add services/advanced-monitoring-ui/lib services/advanced-monitoring-ui/components services/advanced-monitoring-ui/app
git commit -m "resolve \$pod, \$__range and \$__rate_interval so eBPF panels query"
```

---

## Task 4: Carry description and per-dashboard variables through the extractor

**Files:**
- Modify: `scripts/extract-panels.py`
- Modify: `scripts/test_extract_panels.py`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test_extract_panels.py`, matching the file's existing style:

```python
def test_dashboard_carries_its_description():
    """The context banner text is the dashboard's own description; nothing else has it."""
    out = build_catalog(_load_all())
    for dash in out["dashboards"]:
        assert dash["description"], f"{dash['uid']} has no description"


def test_dashboard_carries_its_own_variables():
    """A global list cannot say that `pod` belongs only to the software dashboard,
    which is what decides whether the Pod control renders on a tab."""
    out = build_catalog(_load_all())
    by_uid = {d["uid"]: {v["name"] for v in d["variables"]} for d in out["dashboards"]}
    assert by_uid["gpu-software"] == {"pod", "gpu"}
    assert by_uid["gpu-hardware-device"] == {"gpu"}
    assert by_uid["gpu-hardware-mig"] == {"gpu"}


def test_variable_query_is_preserved_verbatim():
    """`pod` is metric-scoped: label_values(<metric>, k8s_pod_name). Dropping the metric
    offers pods that can never appear in an eBPF panel."""
    out = build_catalog(_load_all())
    soft = next(d for d in out["dashboards"] if d["uid"] == "gpu-software")
    pod = next(v for v in soft["variables"] if v["name"] == "pod")
    assert pod["query"] == "label_values(ebpf_cuda_kernel_launch_calls_total, k8s_pod_name)"
```

If `_load_all()` and `build_catalog()` are not the names already used in that file, adapt these tests to the helpers it actually defines — read the file first and match it.

- [ ] **Step 2: Run and watch them fail**

```bash
python -m pytest scripts/test_extract_panels.py -q
```
Expected: FAIL — `KeyError: 'description'`.

- [ ] **Step 3: Extend the extractor**

In `scripts/extract-panels.py`, the per-dashboard dict currently carries `uid`, `title`, `rows`. Add two keys, and keep the existing global `variables` list so nothing downstream breaks:

```python
def variables_of(dash):
    """A dashboard's own template variables, in declaration order. The global list is
    deduped across dashboards and so cannot say which dashboard owns which variable."""
    return [{"name": v.get("name"), "query": v.get("query", ""),
             "includeAll": bool(v.get("includeAll")), "multi": bool(v.get("multi"))}
            for v in dash.get("templating", {}).get("list", [])]
```

and in the loop that builds each dashboard entry:

```python
dashboards.append({
    "uid": dash.get("uid"),
    "title": dash.get("title", ""),
    "description": dash.get("description", ""),
    "variables": variables_of(dash),
    "rows": rows_of(dash),
})
```

- [ ] **Step 4: Run the tests and regenerate**

```bash
python -m pytest scripts/test_extract_panels.py -q
python scripts/extract-panels.py
python scripts/check-dashboards.py
```
Expected: tests pass; the checker reports 0 problems (it verifies `panels.json` is not stale).

- [ ] **Step 5: Mirror the shape in the UI's types**

In `services/advanced-monitoring-ui/lib/api.ts`, extend `DashboardSpec`:

```ts
export interface VariableSpec {
  name: string; query: string; includeAll: boolean; multi: boolean;
}
export interface DashboardSpec {
  uid: string; title: string; description: string;
  variables: VariableSpec[]; rows: RowSpec[];
}
```

- [ ] **Step 6: Verify**

```bash
cd services/advanced-monitoring-ui && npx tsc --noEmit
```
Expected: silent.

- [ ] **Step 7: Commit**

```bash
git add scripts services/advanced-monitoring-api/app/panels.json services/advanced-monitoring-ui/lib/api.ts
git commit -m "carry dashboard description and per-dashboard variables in the catalog"
```

---

## Task 5: Metric-scoped label values

The `pod` variable's query is `label_values(ebpf_cuda_kernel_launch_calls_total, k8s_pod_name)`. A bare label lookup answers with the monitoring system's own pods, which can never appear in an eBPF panel.

**Files:**
- Modify: `services/advanced-monitoring-api/app/prometheus.py`
- Modify: `services/advanced-monitoring-api/app/main.py`
- Modify: `services/advanced-monitoring-api/tests/test_routes.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_routes.py`, following the file's existing fake-client style:

```python
@pytest.mark.anyio
async def test_label_values_forwards_match_selector(monkeypatch):
    """Prometheus scopes a label lookup with match[]; without it the picker offers
    values that no panel on that dashboard can ever produce."""
    seen = {}

    async def fake_get(client, url, params):
        seen["url"], seen["params"] = url, params
        return ["pod-a"]

    monkeypatch.setattr(prometheus, "_get", fake_get)
    r = await _client_get("/label/k8s_pod_name/values"
                          "?match=ebpf_cuda_kernel_launch_calls_total&start=1&end=2")
    assert r.status_code == 200
    assert r.json()["values"] == ["pod-a"]
    assert seen["params"]["match[]"] == "ebpf_cuda_kernel_launch_calls_total"


@pytest.mark.anyio
async def test_label_values_omits_match_when_absent(monkeypatch):
    seen = {}

    async def fake_get(client, url, params):
        seen["params"] = params
        return []

    monkeypatch.setattr(prometheus, "_get", fake_get)
    await _client_get("/label/gpu_uuid/values?start=1&end=2")
    assert "match[]" not in seen["params"]
```

Adapt `_client_get` to whatever helper the file already uses to call the app.

- [ ] **Step 2: Run and watch it fail**

```bash
cd services/advanced-monitoring-api && python -m pytest tests/test_routes.py -q
```
Expected: FAIL — `KeyError: 'match[]'`.

- [ ] **Step 3: Add the parameter**

In `app/prometheus.py`, extend `label_values`:

```python
async def label_values(client, base: str, label: str,
                       start: float | None = None, end: float | None = None,
                       match: str | None = None) -> list:
    """Values seen for a label, optionally scoped to a time window and to a metric.

    Unscoped in time, Prometheus answers from the whole retention window, so a device
    removed days ago is still listed. Measured on the validation cluster: a MIG instance
    deleted hours earlier still appeared.

    Unscoped by metric, every pod in the cluster is offered for a variable whose Grafana
    query is metric-scoped — including this monitoring stack's own pods, which can never
    appear in an eBPF panel.
    """
    params: dict = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    if match is not None:
        params["match[]"] = match
    data = await _get(client, f"{base}/api/v1/label/{label}/values", params)
```

Keep the rest of the function body unchanged. In `app/main.py`:

```python
@app.get("/label/{name}/values")
async def get_label_values(name: str, start: float | None = None, end: float | None = None,
                           match: str | None = Query(default=None)):
    try:
        return {"values": await prometheus.label_values(
            _client, PROMETHEUS_URL, name, start=start, end=end, match=match)}
    except prometheus.UpstreamError as exc:
        return {"values": [], "error": str(exc)}
```

- [ ] **Step 4: Run the tests**

```bash
python -m pytest -q
```
Expected: 14 passed.

- [ ] **Step 5: Teach the UI client to send it**

In `services/advanced-monitoring-ui/lib/api.ts`:

```ts
labelValues: (name: string, start: number, end: number, match?: string) =>
  get<{ values: string[]; error?: string }>(
    `/label/${encodeURIComponent(name)}/values?start=${start}&end=${end}`
    + (match ? `&match=${encodeURIComponent(match)}` : '')),
```

Add a helper that reads the metric out of a variable query, so the UI never hardcodes a metric name:

```ts
/** `label_values(metric, label)` → metric; `label_values(label)` → undefined. */
export function matchFromVariableQuery(query: string): string | undefined {
  const m = /^label_values\(\s*([^,)]+)\s*,/.exec(query);
  return m ? m[1].trim() : undefined;
}
```

- [ ] **Step 6: Verify**

```bash
cd ../advanced-monitoring-ui && npx tsc --noEmit
```
Expected: silent.

- [ ] **Step 7: Commit**

```bash
git add services/advanced-monitoring-api services/advanced-monitoring-ui/lib/api.ts
git commit -m "scope label value lookups to a metric when the variable query names one"
```

---

## Task 6: The fourth empty state — "Query rejected"

A 400 from Prometheus currently renders as "No data in this range". That is what hid 27 broken panels.

**Files:**
- Modify: `services/advanced-monitoring-ui/lib/api.ts`
- Create: `services/advanced-monitoring-ui/lib/panelState.ts`
- Create: `services/advanced-monitoring-ui/lib/panelState.test.ts`
- Modify: `services/advanced-monitoring-ui/components/PanelFrame.tsx`

- [ ] **Step 1: Write the failing test**

`lib/panelState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stateForError } from './panelState';
import { ApiError } from './api';

describe('stateForError', () => {
  it('reports a rejected query as a rejection, not as absence of data', () => {
    // A malformed query is a bug. Rendering it as "no data" is what hid 27 dead panels.
    expect(stateForError(new ApiError('parse error', 400))).toBe('rejected');
    expect(stateForError(new ApiError('bad_data', 422))).toBe('rejected');
  });

  it('reports an unreachable upstream as down', () => {
    expect(stateForError(new ApiError('bad gateway', 502))).toBe('down');
    expect(stateForError(new ApiError('unavailable', 503))).toBe('down');
  });

  it('treats a network failure as down, since no status came back', () => {
    expect(stateForError(new TypeError('Failed to fetch'))).toBe('down');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run lib/panelState.test.ts
```
Expected: FAIL — cannot resolve `./panelState`.

- [ ] **Step 3: Write `lib/panelState.ts`**

```ts
import { ApiError } from './api';
import type { PanelState } from '@/components/PanelFrame';

/** Which empty state an error means. A 4xx is Prometheus rejecting the query we sent —
 *  a bug in the expression or its substitution, not an observation about the cluster.
 *  Anything else is treated as the upstream being unreachable. See §6. */
export function stateForError(e: unknown): PanelState {
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) return 'rejected';
  return 'down';
}
```

- [ ] **Step 4: Add the state to `PanelFrame`**

```ts
export type PanelState = 'ok' | 'loading' | 'nodata' | 'unsupported' | 'rejected' | 'down';

const MESSAGE: Record<Exclude<PanelState, 'ok' | 'loading'>, string> = {
  // The four causes an empty panel can have. Collapsing them into one "No data" is
  // exactly the ambiguity gpu_metric_supported and this state exist to remove.
  nodata: 'No data in this range',
  unsupported: 'Not supported on this GPU',
  rejected: 'Query rejected',
  down: 'Prometheus unreachable',
};
```

Colour the message by state, using `STATUS` from `lib/theme` — `rejected` and `down` in `STATUS.critical`, `unsupported` in `STATUS.warning`, `nodata` in `INK.muted` — and always with the text label, never colour alone.

- [ ] **Step 5: Route every renderer's catch through it**

In all seven `components/panels/*.tsx`, replace

```ts
setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
```

with

```ts
setState(stateForError(e));
```

In `TimeSeriesPanel`, the all-rejected branch becomes `setState(stateForError(results[0].reason))` for the error half, leaving the empty-but-successful half on the support check from Task 12 of the previous plan.

- [ ] **Step 6: Verify**

```bash
npm test && npx tsc --noEmit
```
Expected: all pass, tsc silent.

- [ ] **Step 7: Commit**

```bash
git add services/advanced-monitoring-ui
git commit -m "distinguish a rejected query from absence of data"
```

---

## Task 7: Panel frame and shared legend

**Files:**
- Modify: `services/advanced-monitoring-ui/components/PanelFrame.tsx`
- Create: `services/advanced-monitoring-ui/components/Legend.tsx`

- [ ] **Step 1: Write `components/Legend.tsx`**

```tsx
'use client';
import { INK } from '@/lib/theme';

/** Legend chips, rendered outside the canvas. Chart.js's built-in legend eats plot
 *  height and cannot be styled to match the page. Identity is never colour-alone: the
 *  chip carries the colour, the label carries the name. See §3. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;   // one series is named by the panel title
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
    </div>
  );
}
```

- [ ] **Step 2: Restyle `PanelFrame`**

Keep the component's props and the state machine from Task 6. Change only the presentation, per §3: panel background `SURFACE.panel`, 1px `SURFACE.border`, radius `RADIUS`, padding `1rem`; title in `INK.primary` at `0.9rem` weight 600; an `ⓘ` affordance beside the title that shows `description` on hover **and** keyboard focus (a `<button type="button">` with `aria-label`, not a bare `title` attribute); body fills the remaining height.

- [ ] **Step 3: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```
Expected: all pass, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add services/advanced-monitoring-ui/components
git commit -m "restyle the panel frame and add an external legend"
```

---

## Task 8: TimeSeriesPanel — 42 of 58 panels

**Files:**
- Modify: `services/advanced-monitoring-ui/components/panels/TimeSeriesPanel.tsx`

- [ ] **Step 1: Replace the local palette with the allocator**

Delete the `SERIES_COLORS` constant. The panel holds its colour assignment in a ref so a slot survives
refreshes and filtering — passing `{}` each time would reallocate from scratch and repaint on every change:

```ts
const colorMap = useRef<Record<string, string>>({});
// …once the series are known, before building datasets:
colorMap.current = assignColors(rawSeries.map((s) => s.metric), colorMap.current);
const colorOf = (m: Record<string, string>) => colorMap.current[seriesKey(m)];
// …per dataset:
borderColor: colorOf(s.metric),
```

The same ref pattern applies anywhere `assignColors` is called from a renderer (Task 9's BarGauge, Task 10's
state timeline). The second argument is **required by the signature** precisely so this cannot be forgotten:
`assignColors(series)` is a type error, not a silent reversion to rank-based colour.

- [ ] **Step 2: Apply the mark spec**

```ts
borderWidth: 2,
pointRadius: 0,
pointHoverRadius: 5,      // ≥8px hit target at 2× device pixel ratio
tension: 0.25,
// One series may carry a fill; several translucent fills over each other muddy the plot.
fill: datasets.length === 1 ? { target: 'origin' } : false,
backgroundColor: datasets.length === 1 ? `${color}1a` : undefined,   // 0.10 alpha
```

- [ ] **Step 3: Recess the chrome and theme the tooltip**

```ts
scales: {
  x: { type: 'time', grid: { display: false },
       ticks: { color: INK.muted, maxTicksLimit: 6, font: { size: 10 } } },
  y: { grid: { color: SURFACE.grid, drawTicks: false },
       border: { display: false },
       ticks: { color: INK.muted, maxTicksLimit: 5, font: { size: 10 } },
       min: spec.min, max: spec.max },
},
plugins: {
  legend: { display: false },          // rendered by <Legend/> outside the canvas
  tooltip: {
    backgroundColor: SURFACE.raised, borderColor: SURFACE.border, borderWidth: 1,
    titleColor: INK.secondary, bodyColor: INK.primary, padding: 10,
    displayColors: true, boxWidth: 8, boxHeight: 8,
  },
},
interaction: { mode: 'index', intersect: false },
```

Vertical gridlines go; horizontal ones stay, at `SURFACE.grid`. The axis border is removed — the gridline nearest the baseline already reads as one.

- [ ] **Step 4: Render the legend above the canvas**

Pass `items` built from the same `colors` map into `<Legend/>` inside `PanelFrame`, above the `<canvas>`.

- [ ] **Step 5: Verify visually against real data**

```bash
npm test && npx tsc --noEmit && npx next build
```

Then, with a dev server pointed at the live API, open the Device tab and confirm: no series is invisible against the background, filtering one GPU out does not recolour the remaining series, and a panel with >8 series shows a single grey "Other".

- [ ] **Step 6: Commit**

```bash
git add services/advanced-monitoring-ui/components/panels/TimeSeriesPanel.tsx
git commit -m "restyle the timeseries renderer on the validated palette"
```

---

## Task 9: Stat, Gauge and BarGauge

**Files:**
- Modify: `components/panels/StatPanel.tsx`, `GaugePanel.tsx`, `BarGaugePanel.tsx`

- [ ] **Step 1: Stat — value plus sparkline**

Add a second, range query alongside the instant one and draw its result as a bare sparkline behind the value: no axes, no grid, 1.5px line in `SERIES[0]` with a 0.10-alpha fill. Value in `INK.primary` at `2.2rem` weight 700, proportional figures (a standalone number, not a column). Caption `Total (<range>)` in `INK.muted` beneath.

Three panels use this renderer, so this is three extra range queries per refresh — acceptable.

- [ ] **Step 2: Gauge — restyle the arc**

In `GaugePanel.tsx`: track `strokeWidth` 12 in `SURFACE.border`, value arc in `SERIES[0]` with `strokeLinecap="round"`, value centred in `INK.primary` at `1.8rem` weight 700, and `min`/`max` labels at the arc ends in `INK.muted`. Replace the hardcoded `#2a78d6` and `var(--border-color,#30363d)` with the tokens.

Do **not** add a threshold colour ramp: no collected field gives a per-GPU power or temperature limit, so any threshold would be invented.

- [ ] **Step 3: BarGauge — mark spec**

Horizontal bars, 4px rounded data-end anchored to the baseline, a 2px `SURFACE.panel` gap between adjacent bars, label in `INK.secondary` on the left and the value direct-labelled at the bar end in `INK.primary`. Colour each bar by `assignColors` on its series labels.

- [ ] **Step 4: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/components/panels
git commit -m "restyle the stat, gauge and bargauge renderers"
```

---

## Task 10: Table, StateTimeline and Heatmap

**Files:**
- Modify: `components/panels/TablePanel.tsx`, `StateTimelinePanel.tsx`, `HeatmapPanel.tsx`

- [ ] **Step 1: Table**

Header row in `INK.muted`, uppercase, `0.7rem`, letter-spacing `0.04em`. Body rows separated by a 1px `SURFACE.border` bottom rule, no zebra striping. Numeric cells get `font-variant-numeric: tabular-nums` (the `.tabular` class from Task 1) so columns align.

- [ ] **Step 2: State timeline**

Bands coloured from `STATUS` by state, with a 2px `SURFACE.panel` gap between adjacent bands so two same-coloured neighbours stay countable. A legend of the states present, above the plot, via `<Legend/>`.

- [ ] **Step 3: Heatmap — real ramp and a legend**

Replace `fill="#2a78d6" opacity={v/peak}` with a discrete step from `SEQUENTIAL`:

```ts
const step = (v: number) =>
  SEQUENTIAL[Math.min(SEQUENTIAL.length - 1,
                      Math.floor((v / peak) * SEQUENTIAL.length))];
```

An alpha ramp over the panel surface tops out at the mid blue, so the busiest cells read as barely more than the quiet ones. Add a gradient legend bar beneath the plot with `0` and the peak value labelled — a sequential encoding without a scale is unreadable.

- [ ] **Step 4: Verify**

```bash
npm test && npx tsc --noEmit && npx next build
```

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/components/panels
git commit -m "restyle the table, state-timeline and heatmap renderers"
```

---

## Task 11: App shell — bar, header, tabs, context banner

**Files:**
- Create: `components/AppShell.tsx`, `components/ContextBanner.tsx`

- [ ] **Step 1: `ContextBanner.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { INK, STATUS, SURFACE, RADIUS } from '@/lib/theme';

/** The dashboard's own `description` from the Grafana JSON — no second source, so the
 *  wording cannot drift from what check-dashboards.py governs. The MIG banner is
 *  warning-toned because its content is a correctness warning: instance utilisation
 *  must never be summed into a device total. See §2. */
export function ContextBanner({ text, tone }: { text: string; tone: 'info' | 'warning' }) {
  const [open, setOpen] = useState(false);
  const accent = tone === 'warning' ? STATUS.warning : INK.secondary;
  const [first, ...rest] = splitFirstSentence(text);
  return (
    <div style={{ display: 'flex', gap: '0.6rem', padding: '0.7rem 0.9rem',
                  background: SURFACE.raised, borderRadius: RADIUS,
                  border: `1px solid ${SURFACE.border}`, borderLeft: `3px solid ${accent}`,
                  fontSize: '0.82rem', color: INK.secondary, marginBottom: '0.9rem' }}>
      <span aria-hidden style={{ color: accent, fontWeight: 700 }}>
        {tone === 'warning' ? '!' : 'i'}
      </span>
      <div>
        {open ? text : first}
        {rest.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)}
                  style={{ marginLeft: '0.4rem', background: 'none', border: 'none',
                           color: accent, cursor: 'pointer', padding: 0,
                           textDecoration: 'underline' }}>
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
    </div>
  );
}

/** [first sentence, remainder] — the descriptions are paragraphs; the banner shows one
 *  sentence and keeps the rest a click away. */
function splitFirstSentence(text: string): [string, ...string[]] {
  const m = /^(.*?[.!?])\s+(.*)$/s.exec(text.trim());
  return m ? [m[1], m[2]] : [text.trim()];
}
```

Tone is chosen by dashboard uid in `AppShell`: `gpu-hardware-mig` → `warning`, everything else → `info`.

- [ ] **Step 2: `AppShell.tsx`**

An app bar (product name left; a live dot in `STATUS.good` plus "Updated HH:MM" right), then the page header (eyebrow in `SERIES[0]` uppercase `0.72rem` letter-spaced; `<h1>` at `2rem` weight 700 in `INK.primary`), then the tab row.

Tabs are `<button role="tab">` with `aria-selected`; the selected tab carries a 2px bottom border in `SERIES[0]` and `INK.primary` text, the rest `INK.muted`. Tab labels and order come from `catalog.dashboards`.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npx next build
```

- [ ] **Step 4: Commit**

```bash
git add services/advanced-monitoring-ui/components
git commit -m "add the app shell, dashboard tabs and context banner"
```

---

## Task 12: Control bar and row sections

**Files:**
- Create: `components/ControlBar.tsx`, `components/ScopeSelect.tsx`, `components/RowSection.tsx`

- [ ] **Step 1: `ScopeSelect.tsx`**

Replaces `<select multiple>`, which shows only a few rows and gives no hint it is multi-select.

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { INK, SURFACE, RADIUS } from '@/lib/theme';

export function ScopeSelect({ label, options, selected, onChange, allLabel }: {
  label: string; options: string[]; selected: string[];
  onChange: (next: string[]) => void; allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape. Without both, the popover strands the
  // keyboard user and swallows clicks meant for the panel behind it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = selected.length === 0 ? allLabel : `${selected.length} selected`;
  const toggle = (v: string) => onChange(
    selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em',
                    color: INK.muted, marginBottom: '0.25rem' }}>{label}</div>
      <button type="button" aria-expanded={open} aria-haspopup="listbox"
              onClick={() => setOpen(!open)}
              style={{ background: SURFACE.panel, border: `1px solid ${SURFACE.border}`,
                       borderRadius: RADIUS, color: INK.primary, cursor: 'pointer',
                       padding: '0.4rem 0.7rem', minWidth: 170, textAlign: 'left' }}>
        {summary} <span aria-hidden style={{ float: 'right', color: INK.muted }}>▾</span>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable
             style={{ position: 'absolute', zIndex: 20, marginTop: 4, minWidth: 240,
                      maxHeight: 280, overflowY: 'auto', background: SURFACE.raised,
                      border: `1px solid ${SURFACE.border}`, borderRadius: RADIUS,
                      padding: '0.3rem' }}>
          {options.length === 0 && (
            <div style={{ color: INK.muted, padding: '0.4rem 0.5rem' }}>None in this range</div>
          )}
          {options.map((o) => (
            <label key={o} role="option" aria-selected={selected.includes(o)}
                   style={{ display: 'flex', gap: '0.5rem', alignItems: 'center',
                            padding: '0.35rem 0.5rem', cursor: 'pointer',
                            fontSize: '0.8rem', wordBreak: 'break-all' }}>
              <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
              {o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `ControlBar.tsx`**

Labelled groups on a `SURFACE.raised` bar with radius `RADIUS`. Each label is `0.7rem` uppercase `INK.muted` above its control.

- **GPU scope** — `ScopeSelect` over `gpu_uuid` values.
- **Pod scope** — `ScopeSelect` over `k8s_pod_name`, **rendered only when the active dashboard declares a `pod` variable**. Its values come from `api.labelValues('k8s_pod_name', start, end, matchFromVariableQuery(v.query))`.
- **Time range** — a segmented control, not a dropdown: `5m 15m 1h 6h 24h 7d` as adjoining buttons, the selected one filled `SERIES[0]` with `INK.primary` text.
- **Refresh** — interval select plus a manual refresh button.

- [ ] **Step 3: `RowSection.tsx`**

Replaces `<details>/<summary>`. A `SURFACE.raised` header with a rotating chevron, the row title at `0.95rem` weight 600 in `INK.primary`, and `· N panels` in `INK.muted`. The header is a `<button>` with `aria-expanded`; default open state comes from the row's `collapsed` flag.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npx next build
```

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/components
git commit -m "add the labelled control bar, scope popovers and row sections"
```

---

## Task 13: Compose, deploy and verify against the cluster

**Files:**
- Modify: `services/advanced-monitoring-ui/app/page.tsx`

- [ ] **Step 1: Rewrite `page.tsx` to compose the shell**

Replace the four bare `<select>` elements and the `<details>` loop with `AppShell` → `ContextBanner` → `ControlBar` → `RowSection` + `PanelGrid`. State to add: `pods: string[]`, `selPods: string[]`. `vars` becomes `{ gpu: sel, pod: selPods }`.

Fetch pod values only when the active dashboard declares a `pod` variable:

```ts
const podVar = cat?.dashboards[dash].variables.find((v) => v.name === 'pod');
useEffect(() => {
  if (!podVar) { setPods([]); setSelPods([]); return; }
  const end = Math.floor(Date.now() / 1000);
  api.labelValues('k8s_pod_name', end - range, end, matchFromVariableQuery(podVar.query))
     .then((r) => setPods(r.values)).catch(() => {});
}, [podVar, range, tick]);
```

- [ ] **Step 2: Full local gate**

```bash
cd services/advanced-monitoring-ui && npm test && npx tsc --noEmit && npx next build
cd ../.. && python scripts/check-dashboards.py
```
Expected: all tests pass, tsc silent, build succeeds, checker reports 0 problems.

- [ ] **Step 3: Build and push with a fresh tag**

`imagePullPolicy: IfNotPresent` means reusing a tag silently keeps the old image running.

```bash
SHA=$(git rev-parse --short HEAD)-redesign
REG=192.168.6.123:30080/library
docker build -t $REG/advanced-monitoring-ui:$SHA services/advanced-monitoring-ui
docker push $REG/advanced-monitoring-ui:$SHA
sed -e "s|REPLACE_ME_UI|$REG/advanced-monitoring-ui:$SHA|" \
    deploy/a30-node/70-advanced-monitoring.yaml | kubectl apply -f -
kubectl -n gpu-monitoring rollout status deploy/advanced-monitoring-ui --timeout=180s
```

If Task 5 changed the API, rebuild and push it the same way first.

- [ ] **Step 4: Prove the eBPF dashboard is alive**

This is the check that matters — 27 panels were dead.

```bash
curl -s -G 'http://192.168.6.123:30802/api/query' --data-urlencode \
  'q=sum(increase(ebpf_cuda_kernel_launch_calls_total{k8s_pod_name=~".*"}[1h]))'
```
Expected: a `vector` result, **not** a 400 parse error.

Then open `http://192.168.6.123:30802/`, select the Workloads tab, and confirm every panel shows either data or a state that is **not** "No data in this range" for the reason of a malformed query. Any panel still reading "Query rejected" is a substitution bug — fix it before proceeding.

- [ ] **Step 5: Confirm no literal `$` reaches Prometheus**

With the browser devtools network tab open on each of the three tabs, filter to `/api/query`. No request URL may contain `%24` (an encoded `$`).

- [ ] **Step 6: Re-check the palette claim**

```bash
cd /tmp/claude-1000/bundled-skills/*/dataviz 2>/dev/null || \
  cd ~/.claude/plugins/cache/*/dataviz
node scripts/validate_palette.js "$(grep -oE '#[0-9a-f]{6}' \
  /home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/feature-monitoring-ui/services/advanced-monitoring-ui/lib/theme.ts \
  | sed -n '/3987e5/,/e66767/p' | paste -sd,)" --mode dark --surface "#131922"
```
Expected: ALL CHECKS PASS. If a hex drifted during implementation, this catches it.

- [ ] **Step 7: Commit**

```bash
git add services/advanced-monitoring-ui/app/page.tsx
git commit -m "compose the redesigned shell and wire the pod scope control"
```

---

## Verification summary

Run before declaring the work done:

| Check | Command | Expected |
|---|---|---|
| UI tests | `npm test` | all pass |
| Types | `npx tsc --noEmit` | silent |
| Build | `npx next build` | succeeds |
| API tests | `python -m pytest -q` | all pass |
| Extractor tests | `python -m pytest scripts/test_extract_panels.py -q` | all pass |
| Dashboard contract | `python scripts/check-dashboards.py` | 0 problems |
| Palette | `validate_palette.js … --surface #131922` | ALL CHECKS PASS |
| eBPF panels live | Workloads tab in a browser | data or an honest state; no "Query rejected" |
| No literal `$` | devtools network filter | no `%24` in any `/api/query` |

---

## Notes for the implementer

- **`panels.json` is generated.** Never hand-edit it; run `python scripts/extract-panels.py`, and `check-dashboards.py` will catch it if you forget.
- **No new panels.** The mockups show an "Active pods" top-N list that does not exist; §7 of the spec records why it is not being built. Adding PromQL to the frontend is forbidden by [12 §1.1](../12-monitoring-ui.md).
- **`lib/theme.ts` is the only file with a hex literal.** If you find yourself typing `#` anywhere else, add a token instead.
- **Do not commit** without approval — the project's CLAUDE.md requires it. The commit steps above are the intended granularity for when approval is given.
- **Where the plan gives values instead of full JSX** (Tasks 9, 10, 11 and the `ControlBar`/`RowSection` steps of 12), every decision is pinned — exact token, size, weight, ARIA role, and the reason. Only the boilerplate markup is left to the implementer. Where behaviour is subtle rather than decorative — `ScopeSelect`'s dismissal, `ContextBanner`'s sentence split, the heatmap ramp — the code is given in full. If a step feels ambiguous while implementing, that is a plan bug: stop and ask rather than inventing a value.
- **The three mockups are in [`docs-internal/front-end-design/`](../front-end-design/)** and are direction, not specification. Consult them for layout and density; consult the spec for anything with a number in it.
