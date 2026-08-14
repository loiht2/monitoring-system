'use client';
import { useState } from 'react';
import { INK, SERIES, SURFACE, STATUS, RADIUS } from '@/lib/theme';
import { PRESETS, RangeSelection, validateCustom } from '@/lib/timeRange';

/** Epoch seconds → the local-time string `<input type="datetime-local">` expects.
 *  toISOString() is UTC, so the local offset is removed first. */
function toLocalInput(seconds: number): string {
  const d = new Date(seconds * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** The input's local-time string → epoch seconds. NaN for an empty or partial value,
 *  which validateCustom reports rather than silently applying. */
function fromLocalInput(value: string): number {
  return new Date(value).getTime() / 1000;
}

const hhmm = (s: number) =>
  new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const labelStyle = {
  fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  color: INK.muted, marginBottom: '0.25rem',
};

const fieldStyle = {
  background: SURFACE.panel, border: `1px solid ${SURFACE.border}`, borderRadius: RADIUS,
  color: INK.primary, fontSize: '0.8rem', padding: '0.35rem 0.5rem',
};

/** Six presets as one click each, plus a seventh Custom segment holding an ABSOLUTE
 *  window. Apply is disabled while the range is invalid and the reason sits beside it —
 *  an ignored Apply reads as "no data" rather than "bad input". See 13 §10. */
export function TimeRangeControl({ value, onChange }: {
  value: RangeSelection;
  onChange: (next: RangeSelection) => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const [open, setOpen] = useState(value.kind === 'custom');
  const [startText, setStartText] = useState(() =>
    toLocalInput(value.kind === 'custom' ? value.start : now - 900));
  const [endText, setEndText] = useState(() =>
    toLocalInput(value.kind === 'custom' ? value.end : now));

  const start = fromLocalInput(startText);
  const end = fromLocalInput(endText);
  const problem = validateCustom(start, end, Math.floor(Date.now() / 1000));

  const segments = [
    ...PRESETS.map((p) => ({
      key: p.label,
      label: p.label,
      on: value.kind === 'preset' && value.seconds === p.seconds,
      onClick: () => { setOpen(false); onChange({ kind: 'preset', seconds: p.seconds }); },
    })),
    {
      key: 'custom',
      label: value.kind === 'custom' ? `${hhmm(value.start)} → ${hhmm(value.end)}` : 'Custom',
      on: value.kind === 'custom',
      onClick: () => setOpen(true),
    },
  ];

  return (
    <div>
      <div style={labelStyle}>Time range</div>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="group" aria-label="Time range" style={{ display: 'flex' }}>
          {segments.map((s, i) => (
            <button key={s.key} type="button" aria-pressed={s.on} onClick={s.onClick}
                    style={{ background: s.on ? SERIES[0] : SURFACE.panel,
                             color: s.on ? INK.primary : INK.secondary,
                             border: `1px solid ${SURFACE.border}`,
                             borderLeftWidth: i === 0 ? 1 : 0,
                             borderTopLeftRadius: i === 0 ? RADIUS : 0,
                             borderBottomLeftRadius: i === 0 ? RADIUS : 0,
                             borderTopRightRadius: i === segments.length - 1 ? RADIUS : 0,
                             borderBottomRightRadius: i === segments.length - 1 ? RADIUS : 0,
                             cursor: 'pointer', fontSize: '0.8rem',
                             fontWeight: s.on ? 600 : 500, padding: '0.4rem 0.8rem' }}>
              {s.label}
            </button>
          ))}
        </div>

        {open && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="datetime-local" aria-label="Range start" value={startText}
                   onChange={(e) => setStartText(e.target.value)} style={fieldStyle} />
            <input type="datetime-local" aria-label="Range end" value={endText}
                   onChange={(e) => setEndText(e.target.value)} style={fieldStyle} />
            <button type="button" disabled={problem !== null}
                    onClick={() => onChange({ kind: 'custom', start, end })}
                    style={{ background: SURFACE.panel,
                             border: `1px solid ${SURFACE.border}`, borderRadius: RADIUS,
                             color: problem ? INK.muted : SERIES[0],
                             cursor: problem ? 'not-allowed' : 'pointer',
                             fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
              Apply
            </button>
            {problem && (
              <span role="status" style={{ color: STATUS.warning, fontSize: '0.75rem' }}>
                {problem}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
