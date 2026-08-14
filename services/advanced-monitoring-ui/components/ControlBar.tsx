'use client';
import { ReactNode } from 'react';
import { INK, SERIES, SURFACE, RADIUS } from '@/lib/theme';
import { TimeRangeControl } from '@/components/TimeRangeControl';
import { RangeSelection } from '@/lib/timeRange';

export const REFRESH_INTERVALS = [
  { label: 'Off', seconds: 0 }, { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 }, { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
] as const;

const labelStyle = {
  fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  color: INK.muted, marginBottom: '0.25rem',
};

/** Labelled control groups. Neither scope is decided here: the options a tab can
 *  actually plot differ per tab (device cards, MIG instances, pods), so the caller
 *  passes the controls in rather than this component guessing. See §2 and 13 §11. */
export function ControlBar({
  gpuScope, podScope,
  range, onRangeChange, refresh, onRefreshChange, onRefreshNow,
}: {
  gpuScope: ReactNode;
  podScope?: ReactNode;
  range: RangeSelection;
  onRangeChange: (next: RangeSelection) => void;
  refresh: number;
  onRefreshChange: (seconds: number) => void;
  onRefreshNow: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: '1.1rem', alignItems: 'flex-end', flexWrap: 'wrap',
                  background: SURFACE.raised, border: `1px solid ${SURFACE.border}`,
                  borderRadius: RADIUS, padding: '0.7rem 0.9rem', marginBottom: '0.9rem' }}>
      {gpuScope}

      {podScope}

      <TimeRangeControl value={range} onChange={onRangeChange} />

      <div>
        <div style={labelStyle}>Refresh</div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select aria-label="Refresh interval" value={refresh}
                  onChange={(e) => onRefreshChange(Number(e.target.value))}
                  style={{ background: SURFACE.panel, border: `1px solid ${SURFACE.border}`,
                           borderRadius: RADIUS, color: INK.primary, cursor: 'pointer',
                           fontSize: '0.8rem', padding: '0.4rem 0.6rem' }}>
            {REFRESH_INTERVALS.map((r) => (
              <option key={r.seconds} value={r.seconds}>{r.label}</option>
            ))}
          </select>
          <button type="button" onClick={onRefreshNow}
                  style={{ background: SURFACE.panel, border: `1px solid ${SURFACE.border}`,
                           borderRadius: RADIUS, color: SERIES[0], cursor: 'pointer',
                           fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
            Refresh now
          </button>
        </div>
      </div>
    </div>
  );
}
