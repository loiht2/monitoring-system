'use client';
import { useEffect, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { formatValue } from '@/lib/format';
import { INK, SURFACE } from '@/lib/theme';
import { PanelFrame, PanelState } from '../PanelFrame';

// Labels that identify the scrape target rather than the measured entity. Grafana hides
// them via an organize transformation; showing them buries the useful columns.
const HIDE = new Set(['__name__', 'job', 'instance', 'namespace', 'pod', 'service',
                      'container', 'endpoint', 'node', 'Hostname', 'UUID', 'device',
                      'modelName', 'pci_bus_id', 'DCGM_FI_DRIVER_VERSION']);

export function TablePanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cols, setCols] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

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
        const keys = [...new Set(r.result.flatMap((s: any) => Object.keys(s.metric)))]
          .filter((k) => !HIDE.has(k)).sort();
        setCols([...keys, 'Value']);
        setRows(r.result.map((s: any) => [
          ...keys.map((k) => s.metric[k] ?? ''),
          formatValue(Number(s.value[1]), spec.unit),
        ]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(stateForError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ overflow: 'auto', height: '100%' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead><tr>{cols.map((c) => (
            <th key={c} style={{
              textAlign: 'left', padding: '0.35rem 0.5rem', position: 'sticky', top: 0,
              background: SURFACE.panel, color: INK.muted, fontWeight: 600,
              textTransform: 'uppercase', fontSize: '0.7rem', letterSpacing: '0.04em',
              borderBottom: `1px solid ${SURFACE.border}`,
            }}>{c}</th>))}</tr></thead>
          {/* A hairline rule per row and no zebra striping: the stripe is a second, louder
              cue for something one rule already does. */}
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (
              // The value column is formatted text ("1.2K") and no longer parses as a
              // number, so it is aligned by position to keep its tabular figures.
              <td key={j} className={j === r.length - 1 || (Number.isFinite(Number(c)) && c !== '') ? 'tabular' : undefined}
                  style={{ padding: '0.35rem 0.5rem', color: INK.primary,
                           borderBottom: `1px solid ${SURFACE.border}` }}>{c}</td>
            ))}</tr>))}</tbody>
        </table>
      </div>
    </PanelFrame>
  );
}
