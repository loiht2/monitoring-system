'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

export function HeatmapPanel({ spec, vars, rangeSeconds, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cells, setCells] = useState<{ le: string; pts: [number, number][] }[]>([]);
  const [span, setSpan] = useState<[number, number]>([0, 1]);
  const [peak, setPeak] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = Math.floor(Date.now() / 1000), start = end - rangeSeconds;
      try {
        const r = await api.queryRange(substituteVars(spec.targets[0].expr, vars),
                                       start, end, deriveStep(rangeSeconds));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        const rows = r.result
          .map((s: any) => ({ le: s.metric.le ?? '', pts: s.values.map(
            ([t, v]: [number, string]) => [Number(t), Number(v)] as [number, number]) }))
          .sort((a: any, b: any) => Number(a.le) - Number(b.le));
        setSpan([start, end]);
        setPeak(Math.max(1, ...rows.flatMap((x: any) => x.pts.map((p: any) => p[1]))));
        setCells(rows);
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, rangeSeconds, tick]);

  const [t0, t1] = span, w = Math.max(1, t1 - t0);
  const h = cells.length ? 100 / cells.length : 100;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
        {cells.map((row, i) => row.pts.map(([t, v], j) => (
          <rect key={`${i}-${j}`} x={((t - t0) / w) * 100} y={100 - (i + 1) * h}
                width={100 / (row.pts.length || 1)} height={h}
                fill="#2a78d6" opacity={v / peak} />
        )))}
      </svg>
    </PanelFrame>
  );
}
