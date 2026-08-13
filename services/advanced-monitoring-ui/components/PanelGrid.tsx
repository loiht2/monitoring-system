'use client';
import { PanelSpec } from '@/lib/api';
import { TimeSeriesPanel } from './panels/TimeSeriesPanel';
import { StatPanel } from './panels/StatPanel';
import { GaugePanel } from './panels/GaugePanel';
import { BarGaugePanel } from './panels/BarGaugePanel';
import { TablePanel } from './panels/TablePanel';
import { StateTimelinePanel } from './panels/StateTimelinePanel';
import { HeatmapPanel } from './panels/HeatmapPanel';
import { PanelFrame } from './PanelFrame';

export function PanelGrid({ panels, vars, rangeSeconds, tick }: {
  panels: PanelSpec[]; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  return (
    // Grafana's 24-column grid, reproduced so gridPos from the spec lays out unchanged.
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: '0.75rem' }}>
      {panels.map((p) => (
        <div key={p.id} style={{ gridColumn: `span ${p.gridPos.w}`, height: p.gridPos.h * 34 }}>
          {render(p, vars, rangeSeconds, tick)}
        </div>
      ))}
    </div>
  );
}

function render(p: PanelSpec, vars: Record<string, string[]>, rangeSeconds: number, tick: number) {
  switch (p.type) {
    case 'timeseries': return <TimeSeriesPanel spec={p} vars={vars} rangeSeconds={rangeSeconds} tick={tick} />;
    case 'stat':       return <StatPanel spec={p} vars={vars} tick={tick} />;
    case 'gauge':      return <GaugePanel spec={p} vars={vars} tick={tick} />;
    case 'bargauge':   return <BarGaugePanel spec={p} vars={vars} tick={tick} />;
    case 'table':      return <TablePanel spec={p} vars={vars} tick={tick} />;
    case 'state-timeline': return <StateTimelinePanel spec={p} vars={vars} rangeSeconds={rangeSeconds} tick={tick} />;
    case 'heatmap':        return <HeatmapPanel spec={p} vars={vars} rangeSeconds={rangeSeconds} tick={tick} />;
    default:
      // Any panel type the spec gains later renders as an explicit empty state, not blank.
      return <PanelFrame title={p.title} description={p.description} state="nodata">
        <div /></PanelFrame>;
  }
}
