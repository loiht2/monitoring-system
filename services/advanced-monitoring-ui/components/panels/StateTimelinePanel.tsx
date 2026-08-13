'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

export function StateTimelinePanel({ spec, vars, rangeSeconds, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [series, setSeries] = useState<{ label: string; pts: [number, number][] }[]>([]);
  const [span, setSpan] = useState<[number, number]>([0, 1]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = Math.floor(Date.now() / 1000), start = end - rangeSeconds;
      try {
        const r = await api.queryRange(substituteVars(spec.targets[0].expr, vars),
                                       start, end, deriveStep(rangeSeconds));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setSpan([start, end]);
        setSeries(r.result.map((s: any) => ({
          label: (spec.targets[0].legendFormat || '').replace(
            /\{\{(\w+)\}\}/g, (_m, k) => s.metric[k] ?? '') || Object.values(s.metric).join(' '),
          pts: s.values.map(([t, v]: [number, string]) => [Number(t), Number(v)]),
        })));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, rangeSeconds, tick]);

  const [t0, t1] = span, w = Math.max(1, t1 - t0), rowH = 22;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ overflow: 'auto', height: '100%' }}>
        {series.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                                marginBottom: 3 }}>
            <div style={{ width: 190, flexShrink: 0, fontSize: '0.7rem',
                          color: 'var(--text-muted)', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
            <svg width="100%" height={rowH} style={{ display: 'block' }}>
              <rect x={0} y={4} width="100%" height={rowH - 8}
                    fill="var(--border-color,#30363d)" rx={3} />
              {s.pts.map(([t, v], j) => v === 0 ? null : (
                // Each sample paints one step-wide band; adjacent bands merge visually.
                <rect key={j} x={`${((t - t0) / w) * 100}%`} y={4}
                      width={`${(1 / (s.pts.length || 1)) * 100}%`} height={rowH - 8}
                      fill="#eb6834" />
              ))}
            </svg>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}
