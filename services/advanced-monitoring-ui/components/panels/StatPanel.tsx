'use client';
import { useEffect, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, formatDuration, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { formatValue } from '@/lib/format';
import { INK, SERIES } from '@/lib/theme';
import { PanelFrame, PanelState } from '../PanelFrame';

/** The sparkline's path pair: the line, and the same line closed to the baseline for the
 *  fill. Drawn in a 100×100 user-space box that stretches to the panel with
 *  preserveAspectRatio="none" — the shape is a trend cue, not a measurement. */
function spark(points: number[]): { line: string; area: string } | null {
  if (points.length < 2) return null;
  const lo = Math.min(...points), hi = Math.max(...points);
  const span = hi - lo || 1;
  const xy = points.map((v, i) => [
    (i / (points.length - 1)) * 100,
    100 - ((v - lo) / span) * 100,
  ] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  return { line, area: `${line} L 100 100 L 0 100 Z` };
}

export function StatPanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [value, setValue] = useState<number | null>(null);
  const [trend, setTrend] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rangeSeconds = end - start;   // a custom span costs the same as a preset of that length
      const step = deriveStep(rangeSeconds);
      const expr = substituteVars(spec.targets[0].expr, vars,
        { rangeSeconds, step, scrapeInterval: SCRAPE_INTERVAL_SECONDS });
      // The instant query owns the panel's state; the range query only decorates it, so a
      // failed sparkline must never blank a panel whose value arrived.
      const [instant, range] = await Promise.allSettled([
        api.query(expr),
        api.queryRange(expr, start, end, step),
      ]);
      if (cancelled) return;

      // Absent history draws nothing — an interpolated or synthetic line would be a lie.
      setTrend(range.status === 'fulfilled' && range.value.result.length
        ? range.value.result[0].values.map(([, v]: [number, string]) => Number(v))
          .filter((v: number) => Number.isFinite(v))
        : []);

      if (instant.status === 'rejected') { setState(stateForError(instant.reason)); return; }
      if (!instant.value.result.length) {
        const metrics = spec.targets.flatMap((t) => extractMetricNames(t.expr));
        const allUnsupported = metrics.length > 0 && metrics.every((m) => supported[m] === false);
        setState(emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported }));
        return;
      }
      setValue(Number(instant.value.result[0].value[1]));
      setState('ok');
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  const path = spark(trend);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      {/* The number is the subject; the sparkline sits beside it as context, never behind it. */}
      <div style={{ height: '100%', display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', gap: '0.75rem' }}>
        <div style={{ minWidth: 0 }}>
          {/* A standalone number, not a column: proportional figures, no `tabular` class. */}
          <div style={{ fontSize: '2.2rem', fontWeight: 700,
                        color: INK.primary, lineHeight: 1.1 }}>
            {value === null ? '—' : formatValue(value, spec.unit)}
          </div>
          <div style={{ fontSize: '0.72rem', color: INK.muted, marginTop: '0.2rem' }}>
            {`Total (${formatDuration(end - start)})`}
          </div>
        </div>
        {path && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden
               style={{ flex: '0 0 45%', width: '45%', height: '60%' }}>
            {/* fillOpacity, not an alpha suffix on the colour: the palette is exposed as
                CSS tokens now, and "var(--series-1)1a" is not a colour — SVG discards it
                and paints the area solid black. */}
            <path d={path.area} fill={SERIES[0]} fillOpacity={0.1} stroke="none" />
            <path d={path.line} fill="none" stroke={SERIES[0]} strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
    </PanelFrame>
  );
}
