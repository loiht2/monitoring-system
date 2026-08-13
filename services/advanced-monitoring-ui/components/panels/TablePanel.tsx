'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

// Labels that identify the scrape target rather than the measured entity. Grafana hides
// them via an organize transformation; showing them buries the useful columns.
const HIDE = new Set(['__name__', 'job', 'instance', 'namespace', 'pod', 'service',
                      'container', 'endpoint', 'node', 'Hostname', 'UUID', 'device',
                      'modelName', 'pci_bus_id', 'DCGM_FI_DRIVER_VERSION']);

export function TablePanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cols, setCols] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        const keys = [...new Set(r.result.flatMap((s: any) => Object.keys(s.metric)))]
          .filter((k) => !HIDE.has(k)).sort();
        setCols([...keys, 'Value']);
        setRows(r.result.map((s: any) => [...keys.map((k) => s.metric[k] ?? ''), s.value[1]]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ overflow: 'auto', height: '100%' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead><tr>{cols.map((c) => (
            <th key={c} style={{
              textAlign: 'left', padding: '0.35rem 0.5rem', position: 'sticky', top: 0,
              background: 'var(--bg-panel,#161b22)', color: 'var(--text-muted)',
              textTransform: 'uppercase', fontSize: '0.7rem', letterSpacing: '0.04em',
              borderBottom: '1px solid var(--border-color,#30363d)',
            }}>{c}</th>))}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (
              <td key={j} style={{ padding: '0.35rem 0.5rem',
                                   borderBottom: '1px solid var(--border-color,#30363d)' }}>{c}</td>
            ))}</tr>))}</tbody>
        </table>
      </div>
    </PanelFrame>
  );
}
