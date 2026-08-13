'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { formatValue } from '@/lib/format';
import { PanelFrame, PanelState } from '../PanelFrame';

function arc(cx: number, cy: number, r: number, frac: number): string {
  const a = Math.PI * (1 - Math.min(1, Math.max(0, frac)));
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  return `M ${cx - r} ${cy} A ${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

export function GaugePanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [value, setValue] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setValue(Number(r.result[0].value[1]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const frac = max > min ? (value - min) / (max - min) : 0;

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', height: '100%' }}>
        <svg viewBox="0 0 120 66" style={{ width: '100%', maxWidth: 200 }}>
          <path d={arc(60, 60, 50, 1)} fill="none" stroke="var(--border-color,#30363d)"
                strokeWidth={10} strokeLinecap="round" />
          <path d={arc(60, 60, 50, frac)} fill="none" stroke="#2a78d6"
                strokeWidth={10} strokeLinecap="round" />
        </svg>
        <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: '-0.4rem' }}>
          {formatValue(value, spec.unit)}
        </div>
      </div>
    </PanelFrame>
  );
}
