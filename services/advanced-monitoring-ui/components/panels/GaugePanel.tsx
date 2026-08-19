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
  // Carried across refreshes, like BarGaugePanel: a gauge keeps its colour when
  // another gauge comes or goes.
  const colorMap = useRef<Record<string, string>>({});
  const [state, setState] = useState<PanelState>('loading');
  const [gauges, setGauges] = useState<{ key: string; label: string; value: number; color: string }[]>([]);

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
        // One arc per series returned: a multi-select $gpu, or $migid matching more
        // than one instance, legitimately returns several — taking only result[0]
        // silently dropped every entity past the first.
        colorMap.current = assignColors(r.result.map((s: any) => s.metric), colorMap.current);
        setGauges(r.result.map((s: any) => ({
          key: seriesKey(s.metric),
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

  const min = spec.min ?? 0;
  const max = spec.max ?? 1;

  // No threshold ramp: nothing collected gives a per-GPU power or temperature limit, so
  // any band boundary would be invented. The arc reads position against min/max instead.
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center',
                    justifyContent: 'center', gap: '0.5rem', height: '100%' }}>
        {gauges.map((g) => {
          const frac = max > min ? (g.value - min) / (max - min) : 0;
          return (
            <div key={g.key} style={{ display: 'flex', flexDirection: 'column',
                                       alignItems: 'center', flex: '1 1 0', minWidth: 90 }}>
              <svg viewBox="0 0 120 76" style={{ width: '100%', maxWidth: 150 }}>
                <path d={arc(60, 62, 48, 1)} fill="none" stroke={SURFACE.border}
                      strokeWidth={12} strokeLinecap="round" />
                <path d={arc(60, 62, 48, frac)} fill="none" stroke={g.color}
                      strokeWidth={12} strokeLinecap="round" />
                <text x={12} y={74} textAnchor="middle" fontSize={8} fill={INK.muted}>
                  {formatValue(min, spec.unit)}
                </text>
                <text x={108} y={74} textAnchor="middle" fontSize={8} fill={INK.muted}>
                  {formatValue(max, spec.unit)}
                </text>
              </svg>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: INK.primary,
                            marginTop: '-1.1rem' }}>
                {formatValue(g.value, spec.unit)}
              </div>
              {/* Only shown once a second gauge exists — a lone gauge already reads
                  unambiguously from the panel title, and the extra line is clutter. */}
              {gauges.length > 1 && (
                <div style={{ fontSize: '0.7rem', color: INK.secondary, textAlign: 'center',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              maxWidth: '100%' }}>
                  {g.label}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PanelFrame>
  );
}
