'use client';
import { useEffect, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { formatValue } from '@/lib/format';
import { INK, SERIES, SURFACE } from '@/lib/theme';
import { PanelFrame, PanelState } from '../PanelFrame';

function arc(cx: number, cy: number, r: number, frac: number): string {
  const a = Math.PI * (1 - Math.min(1, Math.max(0, frac)));
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  return `M ${cx - r} ${cy} A ${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

export function GaugePanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [value, setValue] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rangeSeconds = end - start;
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars, { rangeSeconds, step: deriveStep(rangeSeconds), scrapeInterval: SCRAPE_INTERVAL_SECONDS }));
        if (cancelled) return;
        if (!r.result.length) {
          const metrics = spec.targets.flatMap((t) => extractMetricNames(t.expr));
          const allUnsupported = metrics.length > 0 && metrics.every((m) => supported[m] === false);
          setState(emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported }));
          return;
        }
        setValue(Number(r.result[0].value[1]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(stateForError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const frac = max > min ? (value - min) / (max - min) : 0;

  // No threshold ramp: nothing collected gives a per-GPU power or temperature limit, so
  // any band boundary would be invented. The arc reads position against min/max instead.
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', height: '100%' }}>
        <svg viewBox="0 0 120 76" style={{ width: '100%', maxWidth: 210 }}>
          <path d={arc(60, 62, 48, 1)} fill="none" stroke={SURFACE.border}
                strokeWidth={12} strokeLinecap="round" />
          <path d={arc(60, 62, 48, frac)} fill="none" stroke={SERIES[0]}
                strokeWidth={12} strokeLinecap="round" />
          <text x={12} y={74} textAnchor="middle" fontSize={8} fill={INK.muted}>
            {formatValue(min, spec.unit)}
          </text>
          <text x={108} y={74} textAnchor="middle" fontSize={8} fill={INK.muted}>
            {formatValue(max, spec.unit)}
          </text>
        </svg>
        <div style={{ fontSize: '1.8rem', fontWeight: 700, color: INK.primary,
                      marginTop: '-1.1rem' }}>
          {formatValue(value, spec.unit)}
        </div>
      </div>
    </PanelFrame>
  );
}
