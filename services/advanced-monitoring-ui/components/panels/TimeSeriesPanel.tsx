'use client';
import { useEffect, useRef, useState } from 'react';
import 'chartjs-adapter-date-fns';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
                       '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

export function TimeSeriesPanel({ spec, vars, rangeSeconds, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<any>(null);
  const [state, setState] = useState<PanelState>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = Math.floor(Date.now() / 1000);
      const start = end - rangeSeconds;
      const step = deriveStep(rangeSeconds);
      const results = await Promise.allSettled(spec.targets.map((t) =>
        api.queryRange(substituteVars(t.expr, vars), start, end, step)));
      if (cancelled) return;

      // One dead target must not blank a panel whose other targets returned.
      if (results.every((r) => r.status === 'rejected')) {
        const first = results[0];
        const down = first.status === 'rejected' && first.reason instanceof ApiError
                     && first.reason.status >= 500;
        setState(down ? 'down' : 'nodata');
        return;
      }

      const datasets: any[] = [];
      results.forEach((r, ti) => {
        if (r.status !== 'fulfilled') return;
        r.value.result.forEach((s: any) => {
          const legend = (spec.targets[ti].legendFormat || '').replace(
            /\{\{(\w+)\}\}/g, (_m, k) => s.metric[k] ?? '');
          datasets.push({
            label: legend || Object.values(s.metric).join(' '),
            data: s.values.map(([t, v]: [number, string]) => ({ x: t * 1000, y: Number(v) })),
            borderColor: SERIES_COLORS[datasets.length % SERIES_COLORS.length],
            borderWidth: 2, pointRadius: 0, tension: 0.25,
          });
        });
      });
      if (!datasets.length) { setState('nodata'); return; }
      setState('ok');

      const { default: Chart } = await import('chart.js/auto');
      if (cancelled) return;
      if (chart.current) {
        // Update in place. Destroying and recreating flickers the canvas on every refresh.
        chart.current.data.datasets = datasets;
        chart.current.update();
        return;
      }
      if (!canvas.current) return;
      chart.current = new Chart(canvas.current, {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { type: 'time', ticks: { color: '#8b949e', maxTicksLimit: 6 },
                 grid: { color: '#30363d' } },
            y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' },
                 min: spec.min, max: spec.max },
          },
          plugins: { legend: { labels: { color: '#8b949e', boxWidth: 10 } } },
        },
      });
    })();
    return () => { cancelled = true; };
  }, [spec, vars, rangeSeconds, tick]);

  useEffect(() => () => { chart.current?.destroy(); }, []);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <canvas ref={canvas} />
    </PanelFrame>
  );
}
