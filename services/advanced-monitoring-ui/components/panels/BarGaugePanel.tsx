'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { formatValue } from '@/lib/format';
import { PanelFrame, PanelState } from '../PanelFrame';

export function BarGaugePanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [bars, setBars] = useState<{ label: string; value: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setBars(r.result.map((s: any) => ({
          label: (spec.targets[0].legendFormat || '').replace(
            /\{\{(\w+)\}\}/g, (_m, k) => s.metric[k] ?? '') || Object.values(s.metric).join(' '),
          value: Number(s.value[1]),
        })));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  const min = spec.min ?? 0, max = spec.max ?? 1;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem',
                    justifyContent: 'center', height: '100%' }}>
        {bars.map((b) => (
          <div key={b.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span>{b.label}</span><span>{formatValue(b.value, spec.unit)}</span>
            </div>
            <div style={{ height: 8, background: 'var(--border-color,#30363d)', borderRadius: 4 }}>
              <div style={{
                width: `${Math.min(100, Math.max(0, ((b.value - min) / (max - min)) * 100))}%`,
                height: '100%', background: '#2a78d6', borderRadius: 4,
              }} />
            </div>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}
