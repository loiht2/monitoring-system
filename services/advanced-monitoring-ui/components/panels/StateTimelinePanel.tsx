'use client';
import { useEffect, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { seriesLabel } from '@/lib/series';
import { INK, STATUS, SURFACE } from '@/lib/theme';
import { Legend } from '../Legend';
import { PanelFrame, PanelState } from '../PanelFrame';

/** The two states this renderer's data can be in. The metric is a boolean per reason:
 *  a sample is either asserting the condition or it is not. Colour is never the only
 *  cue — each state ships with its name in the legend above the plot. */
const INACTIVE = { name: 'Inactive', color: SURFACE.border };
const ACTIVE = { name: 'Active', color: STATUS.warning };

export function StateTimelinePanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [series, setSeries] = useState<{ label: string; pts: [number, number][] }[]>([]);
  const [span, setSpan] = useState<[number, number]>([0, 1]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rangeSeconds = end - start;   // a custom span costs the same as a preset of that length
      try {
        const r = await api.queryRange(substituteVars(spec.targets[0].expr, vars, { rangeSeconds, step: deriveStep(rangeSeconds), scrapeInterval: SCRAPE_INTERVAL_SECONDS }),
                                       start, end, deriveStep(rangeSeconds));
        if (cancelled) return;
        if (!r.result.length) {
          const metrics = spec.targets.flatMap((t) => extractMetricNames(t.expr));
          const allUnsupported = metrics.length > 0 && metrics.every((m) => supported[m] === false);
          setState(emptyState({ deviceScope, selected: vars.gpu, partitioned, allUnsupported }));
          return;
        }
        setSpan([start, end]);
        setSeries(r.result.map((s: any) => ({
          label: seriesLabel(spec.targets[0].legendFormat, s.metric),
          pts: s.values.map(([t, v]: [number, string]) => [Number(t), Number(v)]),
        })));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(stateForError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  const [t0, t1] = span, w = Math.max(1, t1 - t0), rowH = 22;
  // Only the states actually present get a chip; an absent state is not explained away.
  const anyActive = series.some((s) => s.pts.some(([, v]) => v !== 0));
  const anyInactive = series.some((s) => s.pts.some(([, v]) => v === 0));
  const legend = [
    ...(anyInactive ? [INACTIVE] : []),
    ...(anyActive ? [ACTIVE] : []),
  // These chips name states, not series: no onToggle, so they stay inert.
  ].map((x) => ({ key: x.name, label: x.name, color: x.color }));

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Legend items={legend} />
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          {series.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                                  marginBottom: 3 }}>
              <div style={{ width: 190, flexShrink: 0, fontSize: '0.7rem',
                            color: INK.secondary, overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
              <svg width="100%" height={rowH} style={{ display: 'block' }}>
                <rect x={0} y={4} width="100%" height={rowH - 8}
                      fill={INACTIVE.color} rx={3} />
                {s.pts.map(([t, v], j) => v === 0 ? null : (
                  // Each sample paints one step-wide band. The 2px surface stroke keeps two
                  // same-coloured neighbours countable instead of merging into one run.
                  <rect key={j} x={`${((t - t0) / w) * 100}%`} y={4}
                        width={`${(1 / (s.pts.length || 1)) * 100}%`} height={rowH - 8}
                        fill={ACTIVE.color} stroke={SURFACE.panel} strokeWidth={2}
                        shapeRendering="crispEdges" />
                ))}
              </svg>
            </div>
          ))}
        </div>
      </div>
    </PanelFrame>
  );
}
