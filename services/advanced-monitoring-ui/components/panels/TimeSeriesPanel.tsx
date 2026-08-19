'use client';
import { useEffect, useRef, useState } from 'react';
import 'chartjs-adapter-date-fns';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { unsupportedTargets, emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { formatValue } from '@/lib/format';
import { assignColors, seriesKey, seriesLabel, targetSeriesKey } from '@/lib/series';
import { isHidden, toggle, isolate } from '@/lib/visibility';
import { INK, SURFACE } from '@/lib/theme';
import { Legend } from '../Legend';
import { PanelFrame, PanelState } from '../PanelFrame';

export function TimeSeriesPanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<any>(null);
  // The panel's colour assignment, carried across refreshes so a slot given to a series
  // is never handed to another one. Reallocating from `{}` each refresh would repaint.
  const colorMap = useRef<Record<string, string>>({});
  const [state, setState] = useState<PanelState>('loading');
  const [legend, setLegend] = useState<{ key: string; label: string; color: string }[]>([]);
  // Which series the reader has hidden, by series key. View state: per panel, and it
  // resets on reload (§9.1). Held in a ref too so the fetch effect can read it without
  // re-running — a toggle must update the chart, never re-query.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const hiddenRef = useRef<Set<string>>(hidden);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rangeSeconds = end - start;   // a custom span costs the same as a preset of that length
      const step = deriveStep(rangeSeconds);
      const results = await Promise.allSettled(spec.targets.map((t) =>
        api.queryRange(substituteVars(t.expr, vars, { rangeSeconds, step: deriveStep(rangeSeconds), scrapeInterval: SCRAPE_INTERVAL_SECONDS }), start, end, step)));
      if (cancelled) return;

      const metrics = spec.targets.flatMap((t) => extractMetricNames(t.expr));
      const allUnsupported = metrics.length > 0 && metrics.every((m) => supported[m] === false);

      // One dead target must not blank a panel whose other targets returned.
      if (results.every((r) => r.status === 'rejected')) {
        const first = results[0];
        setState(first.status === 'rejected'
          ? stateForError(first.reason)
          : emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported }));
        return;
      }

      // Collect the series before colouring: the allocator needs the whole set, and
      // colour must never depend on the position a series landed at in this array.
      const rawSeries: { metric: Record<string, string>; targetIndex: number; label: string; points: any[] }[] = [];
      results.forEach((r, ti) => {
        if (r.status !== 'fulfilled') return;
        r.value.result.forEach((s: any) => {
          rawSeries.push({
            metric: s.metric,
            targetIndex: ti,
            label: seriesLabel(spec.targets[ti].legendFormat, s.metric),
            points: s.values.map(([t, v]: [number, string]) => ({ x: t * 1000, y: Number(v) })),
          });
        });
      });
      if (!rawSeries.length) { setState(emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported })); return; }

      // Keyed per target, not just per label set: a P95 and P99 histogram_quantile()
      // over the same histogram return identically labelled results (the quantile is a
      // query-time constant, never a label), so seriesKey() alone would collapse both
      // onto one colour slot and one visibility-toggle key. targetSeriesKey() is the
      // one place that identity is computed; assignColors() still wants label-record
      // objects, so it's called on trivial single-field wrappers around that same key
      // rather than reintroducing a second, parallel way to tell series apart.
      const keyOf = (s: { targetIndex: number; metric: Record<string, string> }) =>
        targetSeriesKey(s.targetIndex, s.metric);

      colorMap.current = assignColors(rawSeries.map((s) => ({ key: keyOf(s) })), colorMap.current);
      const colorOf = (s: { targetIndex: number; metric: Record<string, string> }) =>
        colorMap.current[seriesKey({ key: keyOf(s) })];

      // Only a lone series carries a fill; several translucent fills muddy the plot.
      const single = rawSeries.length === 1;
      const datasets = rawSeries.map((s) => {
        const color = colorOf(s);
        return {
          label: s.label,
          // Toggling rides on the dataset, so a refresh keeps what the reader hid. The
          // key travels with it so a legend row addresses its own series, not an index.
          seriesKey: keyOf(s),
          hidden: isHidden(hiddenRef.current, keyOf(s)),
          data: s.points,
          borderColor: color,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,      // ≥8px hit target at 2× device pixel ratio
          tension: 0,               // straight segments, matching Grafana's default
          fill: single ? { target: 'origin' } : false,
          backgroundColor: single ? `${color}1a` : undefined,   // 0.10 alpha
        };
      });

      // One row per series, keyed by identity: two targets can legitimately produce the
      // same legend text, and a row must address exactly the series it toggles.
      const byKey = new Map<string, { key: string; label: string; color: string }>();
      rawSeries.forEach((s, i) => {
        const key = keyOf(s);
        if (!byKey.has(key)) byKey.set(key, { key, label: s.label, color: datasets[i].borderColor });
      });
      setLegend([...byKey.values()]);
      setState('ok');

      // A flat all-zero panel auto-scales symmetrically, inventing negative utilisation.
      // Floor at zero only when nothing in the data is negative; an explicit spec.min wins.
      const allNonNegative = rawSeries.every((s) =>
        s.points.every((p: any) => !(p.y < 0)));
      const yMin = spec.min ?? (allNonNegative ? 0 : undefined);

      const { default: Chart } = await import('chart.js/auto');
      // The canvas only mounts once the state is 'ok' (PanelFrame gates its children), so
      // wait for React to commit that update. Without this the import resolves in a
      // microtask on every panel after the first — the chunk is already cached — and
      // canvas.current is still null, leaving the panel permanently chartless. Two frames:
      // the first commits the canvas, the second gives it a laid-out size, without which
      // Chart.js sizes itself to its 300x150 default and never grows into the panel.
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (cancelled) return;
      if (chart.current) {
        // Update in place. Destroying and recreating flickers the canvas on every refresh.
        // The colours ride on the datasets, so a changed assignment applies without a rebuild.
        chart.current.data.datasets = datasets;
        chart.current.options.scales.y.min = yMin;
        chart.current.update();
        return;
      }
      if (!canvas.current) return;
      chart.current = new Chart(canvas.current, {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            // Vertical gridlines go; the gridline nearest the baseline reads as the axis.
            x: { type: 'time', grid: { display: false },
                 ticks: { color: INK.muted, maxTicksLimit: 6, font: { size: 10 } } },
            y: { grid: { color: SURFACE.grid, drawTicks: false },
                 border: { display: false },
                 ticks: { color: INK.muted, maxTicksLimit: 5, font: { size: 10 },
                          // Ticks read in the panel's own unit, as the stat and gauge do.
                          callback: (value: any) => formatValue(Number(value), spec.unit) },
                 min: yMin, max: spec.max },
          },
          plugins: {
            legend: { display: false },          // rendered by <Legend/> outside the canvas
            tooltip: {
              backgroundColor: SURFACE.raised, borderColor: SURFACE.border, borderWidth: 1,
              titleColor: INK.secondary, bodyColor: INK.primary, padding: 10,
              displayColors: true, boxWidth: 8, boxHeight: 8,
              callbacks: {
                // Without this Chart.js prints the raw number: a memory panel showed
                // "12616466432" where it meant 11.8 GiB. See 13 §8.
                label: (ctx: any) =>
                  `${ctx.dataset.label}: ${formatValue(ctx.parsed.y, spec.unit)}`,
              },
            },
          },
        },
      });
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  useEffect(() => () => { chart.current?.destroy(); }, []);

  /** A toggle is a view change, not a data change: it flips dataset.hidden and calls
   *  update(). Rebuilding the chart would lose the two-frame creation path and flicker,
   *  and re-querying would make looking at one series cost a round trip. */
  function onToggle(key: string, isolating: boolean) {
    const keys = legend.map((l) => l.key);
    const next = isolating ? isolate(keys, key, hiddenRef.current)
                           : toggle(hiddenRef.current, key);
    hiddenRef.current = next;
    setHidden(next);
    chart.current?.data.datasets.forEach((d: any) => { d.hidden = isHidden(next, d.seriesKey); });
    chart.current?.update();
  }

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Legend items={legend} unsupported={unsupportedTargets(spec.targets, supported)}
                hidden={hidden} onToggle={onToggle} />
        {/* minHeight so a long legend can never squeeze the plot to nothing — §9. */}
        <div style={{ flex: 1, minHeight: 80, position: 'relative' }}>
          <canvas ref={canvas} />
        </div>
      </div>
    </PanelFrame>
  );
}
