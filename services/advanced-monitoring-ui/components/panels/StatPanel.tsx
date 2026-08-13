'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { formatValue } from '@/lib/format';
import { PanelFrame, PanelState } from '../PanelFrame';

export function StatPanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [value, setValue] = useState<number | null>(null);

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

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ height: '100%', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: '2.2rem', fontWeight: 700 }}>
        {value === null ? '—' : formatValue(value, spec.unit)}
      </div>
    </PanelFrame>
  );
}
