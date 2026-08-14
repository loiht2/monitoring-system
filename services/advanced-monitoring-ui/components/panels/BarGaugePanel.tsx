'use client';
import { useEffect, useRef, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { assignColors, seriesKey, seriesLabel } from '@/lib/series';
import { formatValue } from '@/lib/format';
import { INK, SURFACE } from '@/lib/theme';
import { PanelFrame, PanelState } from '../PanelFrame';

export function BarGaugePanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  // Carried across refreshes: a bar keeps its colour when another bar comes or goes.
  const colorMap = useRef<Record<string, string>>({});
  const [state, setState] = useState<PanelState>('loading');
  const [bars, setBars] = useState<{ label: string; value: number; color: string }[]>([]);

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
        // Colour by entity key over the whole set, never by the position a bar landed at.
        colorMap.current = assignColors(r.result.map((s: any) => s.metric), colorMap.current);
        setBars(r.result.map((s: any) => ({
          label: seriesLabel(spec.targets[0].legendFormat, s.metric),
          value: Number(s.value[1]),
          color: colorMap.current[seriesKey(s.metric)],
        })));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(stateForError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  const min = spec.min ?? 0, max = spec.max ?? 1;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      {/* 2px of panel surface between adjacent bars — enough to separate them, not
          enough to read as a list of unrelated rows. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2,
                    justifyContent: 'center', height: '100%' }}>
        {bars.map((b) => {
          const pct = Math.min(100, Math.max(0, ((b.value - min) / (max - min)) * 100));
          const inside = pct >= 55;   // keep the direct label from overflowing the track
          return (
            <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: '38%', flexShrink: 0, fontSize: '0.75rem',
                            color: INK.secondary, overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</div>
              <div style={{ flex: 1, minWidth: 0, position: 'relative', height: 18,
                            background: SURFACE.border, borderRadius: 4 }}>
                {/* Anchored to the baseline; only the data end is rounded. */}
                <div style={{ width: `${pct}%`, height: '100%', background: b.color,
                              borderRadius: '0 4px 4px 0' }} />
                <span className="tabular" style={{
                  position: 'absolute', top: 0, lineHeight: '18px', fontSize: '0.72rem',
                  color: INK.primary, whiteSpace: 'nowrap',
                  ...(inside ? { left: `${pct}%`, transform: 'translateX(-100%)',
                                 paddingRight: '0.4rem' }
                             : { left: `${pct}%`, paddingLeft: '0.4rem' }),
                }}>{formatValue(b.value, spec.unit)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </PanelFrame>
  );
}
