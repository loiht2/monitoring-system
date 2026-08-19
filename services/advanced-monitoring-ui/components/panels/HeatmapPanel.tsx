'use client';
import { useEffect, useState } from 'react';
import { api, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { extractMetricNames } from '@/lib/support';
import { emptyState } from '@/lib/panelSupport';
import { stateForError } from '@/lib/panelState';
import { bucketDensity, BucketRow } from '@/lib/chart';
import { formatValue } from '@/lib/format';
import { INK, SEQUENTIAL, SURFACE } from '@/lib/theme';
import { PanelFrame, PanelState } from '../PanelFrame';

/** A bucket bound is in the metric's own base unit, which is not the panel's unit: the
 *  panel plots a *count* per bucket while the bound is a duration or a size. Prometheus
 *  naming carries it, so read it from the expression — without this, a 0.001s bound went
 *  through the unitless formatter and rendered as "0.00". */
function boundUnitFor(expr: string, fallback?: string): string | undefined {
  if (/_seconds_bucket/.test(expr)) return 's';
  if (/_bytes_bucket/.test(expr)) return 'bytes';
  return fallback;
}

/** Row labels are the bucket's upper bound. */
function boundLabel(le: string, unit?: string): string {
  return le === '+Inf' || !Number.isFinite(Number(le)) ? '∞' : formatValue(Number(le), unit);
}

function clockLabel(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function HeatmapPanel({ spec, vars, start, end, tick, supported,
  partitioned, deviceScope }: {
  spec: PanelSpec; vars: Record<string, string[]>; start: number; end: number; tick: number;
  supported: Record<string, boolean>; partitioned: Set<string>; deviceScope: boolean;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cells, setCells] = useState<BucketRow[]>([]);
  const [peak, setPeak] = useState(1);

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
        // Cumulative → per-bucket. Without this the panel is a monotonic wash with
        // +Inf always darkest, which says nothing about where latency concentrates.
        const rows = bucketDensity(r.result.map((s: any) => ({
          le: s.metric.le ?? '',
          pts: s.values.map(([t, v]: [number, string]) => [Number(t), Number(v)] as [number, number]),
        })));
        setPeak(Math.max(1e-9, ...rows.flatMap((x) => x.pts.map((p) => p[1]))));
        setCells(rows);
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(stateForError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, start, end, tick, supported, partitioned, deviceScope]);

  // Pinned to the selected window like the time-series panels, so the x extent means
  // the same thing on every panel of the dashboard.
  const w = Math.max(1, end - start);
  const h = cells.length ? 100 / cells.length : 100;

  // A discrete step through the ramp, not an alpha fade: alpha over this surface tops out
  // near the mid blue, so the busiest cells read as barely more than the quiet ones.
  const step = (v: number) =>
    SEQUENTIAL[Math.min(SEQUENTIAL.length - 1, Math.floor((v / peak) * SEQUENTIAL.length))];

  // A sequential encoding with no scale is unreadable, so the ramp ships with its ends
  // labelled. The stops mirror the bands above exactly.
  const gradient = `linear-gradient(to right, ${SEQUENTIAL.map((c, i) =>
    `${c} ${(i / SEQUENTIAL.length) * 100}% ${((i + 1) / SEQUENTIAL.length) * 100}%`
  ).join(', ')})`;

  // Every row is labelled when there are few, otherwise roughly every other one —
  // an unlabelled axis was the other half of why this panel could not be read.
  const labelEvery = cells.length > 8 ? Math.ceil(cells.length / 6) : 1;
  const boundUnit = boundUnitFor(spec.targets[0]?.expr ?? '', spec.unit);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: '0.35rem' }}>
          {/* Bucket bounds, bottom-to-top: the row's upper edge, in the metric's base unit. */}
          <div style={{ display: 'flex', flexDirection: 'column-reverse',
                        justifyContent: 'space-between', fontSize: '0.62rem',
                        color: INK.muted, textAlign: 'right', flex: '0 0 auto' }}
               className="tabular">
            {cells.map((row, i) => (
              <span key={row.le} style={{ lineHeight: 1, height: `${h}%`,
                                          display: 'flex', alignItems: 'center',
                                          justifyContent: 'flex-end' }}>
                {i % labelEvery === 0 ? boundLabel(row.le, boundUnit) : ''}
              </span>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100"
                 style={{ display: 'block', background: SURFACE.raised }}>
              {cells.map((row, i) => row.pts.map(([t, v], j) => (
                // Zero-density cells are left unpainted so the surface shows through —
                // painting them the ramp's lowest stop made empty and quiet look alike.
                v <= 0 ? null : (
                  // 1.05× the step so adjacent cells overlap slightly: at exactly one
                  // step wide, anti-aliasing leaves a hairline seam between every pair
                  // and a solid band reads as striped.
                  <rect key={`${i}-${j}`} x={((t - start) / w) * 100} y={100 - (i + 1) * h}
                        width={Math.max(0.4, (deriveStep(w) / w) * 100 * 1.05)} height={h}
                        fill={step(v)} />
                )
              )))}
            </svg>
          </div>
        </div>
        {/* Time axis, matching the window the picker asked for. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem',
                      fontSize: '0.62rem', color: INK.muted }} className="tabular">
          <span>{clockLabel(start)}</span>
          <span>{clockLabel((start + end) / 2)}</span>
          <span>{clockLabel(end)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem',
                      marginTop: '0.4rem', fontSize: '0.68rem', color: INK.muted }}>
          <span className="tabular">0</span>
          <div aria-hidden style={{ flex: 1, height: 8, borderRadius: 4, background: gradient }} />
          <span className="tabular">{formatValue(peak)}</span>
          <span style={{ marginLeft: '0.2rem' }}>per bucket</span>
        </div>
      </div>
    </PanelFrame>
  );
}
