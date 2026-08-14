'use client';
import { useEffect, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { formatValue } from '@/lib/format';
import { INK, SEQUENTIAL } from '@/lib/theme';
import { PanelFrame, PanelState } from '../PanelFrame';

export function HeatmapPanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cells, setCells] = useState<{ le: string; pts: [number, number][] }[]>([]);
  const [span, setSpan] = useState<[number, number]>([0, 1]);
  const [peak, setPeak] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rangeSeconds = end - start;   // a custom span costs the same as a preset of that length
      try {
        const r = await api.queryRange(substituteVars(spec.targets[0].expr, vars, { rangeSeconds, step: deriveStep(rangeSeconds), scrapeInterval: SCRAPE_INTERVAL_SECONDS }),
                                       start, end, deriveStep(rangeSeconds));
        if (cancelled) return;
        if (!r.result.length) {
          const metrics = spec.targets.flatMap((t) => extractMetricNames(t.expr));
          const allUnsupported = metrics.length > 0 && metrics.every((m) => supported[m] === false);
          setState(emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported }));
          return;
        }
        const rows = r.result
          .map((s: any) => ({ le: s.metric.le ?? '', pts: s.values.map(
            ([t, v]: [number, string]) => [Number(t), Number(v)] as [number, number]) }))
          .sort((a: any, b: any) => Number(a.le) - Number(b.le));
        setSpan([start, end]);
        setPeak(Math.max(1, ...rows.flatMap((x: any) => x.pts.map((p: any) => p[1]))));
        setCells(rows);
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(stateForError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  const [t0, t1] = span, w = Math.max(1, t1 - t0);
  const h = cells.length ? 100 / cells.length : 100;

  // A discrete step through the ramp, not an alpha fade: alpha over this surface tops out
  // near the mid blue, so the busiest cells read as barely more than the quiet ones.
  const step = (v: number) =>
    SEQUENTIAL[Math.min(SEQUENTIAL.length - 1,
                        Math.floor((v / peak) * SEQUENTIAL.length))];

  // A sequential encoding with no scale is unreadable, so the ramp ships with its ends
  // labelled. The stops mirror the bands above exactly.
  const gradient = `linear-gradient(to right, ${SEQUENTIAL.map((c, i) =>
    `${c} ${(i / SEQUENTIAL.length) * 100}% ${((i + 1) / SEQUENTIAL.length) * 100}%`
  ).join(', ')})`;

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
            {cells.map((row, i) => row.pts.map(([t, v], j) => (
              <rect key={`${i}-${j}`} x={((t - t0) / w) * 100} y={100 - (i + 1) * h}
                    width={100 / (row.pts.length || 1)} height={h} fill={step(v)} />
            )))}
          </svg>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem',
                      marginTop: '0.5rem', fontSize: '0.68rem', color: INK.muted }}>
          <span className="tabular">0</span>
          <div aria-hidden style={{ flex: 1, height: 8, borderRadius: 4, background: gradient }} />
          <span className="tabular">{formatValue(peak, spec.unit)}</span>
        </div>
      </div>
    </PanelFrame>
  );
}
