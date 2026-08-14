'use client';
import { useState } from 'react';
import { INK, STATUS, SURFACE, RADIUS } from '@/lib/theme';

export type PanelState =
  'ok' | 'loading' | 'nodata' | 'unsupported' | 'partitioned' | 'rejected' | 'down';

const MESSAGE: Record<Exclude<PanelState, 'ok' | 'loading'>, string> = {
  // The causes an empty panel can have. Collapsing them into one "No data" is
  // exactly the ambiguity gpu_metric_supported and the rejected state exist to remove.
  nodata: 'No data in this range',
  unsupported: 'Not supported on this GPU',
  // Not broken and not unsupported: once MIG is on, the reading lives at instance scope.
  partitioned: 'Partitioned into MIG instances — this reading is per instance. See the MIG tab.',
  rejected: 'Query rejected',
  down: 'Prometheus unreachable',
};

// Colour is a second cue only; the label above always carries the meaning.
const MESSAGE_COLOR: Record<Exclude<PanelState, 'ok' | 'loading'>, string> = {
  nodata: INK.muted,
  unsupported: STATUS.warning,
  partitioned: STATUS.warning,
  rejected: STATUS.critical,
  down: STATUS.critical,
};

/** The description affordance. A bare `title=` attribute is unreachable by keyboard, so
 *  this is a real button that reveals the text on hover *and* focus. See §3. */
function InfoAffordance({ title, description }: { title: string; description: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label={`About ${title}: ${description}`}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'help',
          color: INK.muted, lineHeight: 0, display: 'inline-flex',
        }}
      >
        {/* Drawn, not typed. The obvious glyph for this is `ⓘ` (U+24D8), which the
            container image has no font covering — it rendered as a tofu box beside every
            panel title. Pure geometry depends on no font being installed anywhere. */}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
          <rect x="7.15" y="6.7" width="1.7" height="5" rx="0.85" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <span role="tooltip" style={{
          position: 'absolute', zIndex: 30, top: '1.2rem', left: 0, width: 260,
          background: SURFACE.raised, border: `1px solid ${SURFACE.border}`,
          borderRadius: RADIUS, padding: '0.5rem 0.6rem', fontSize: '0.75rem',
          fontWeight: 400, color: INK.secondary,
        }}>{description}</span>
      )}
    </span>
  );
}

export function PanelFrame({ title, description, state, children }: {
  title: string; description?: string; state: PanelState; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: SURFACE.panel, border: `1px solid ${SURFACE.border}`,
      borderRadius: RADIUS, padding: '1rem', height: '100%',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.35rem',
        fontSize: '0.9rem', color: INK.primary, fontWeight: 600, marginBottom: '0.6rem',
      }}>
        <span>{title}</span>
        {description && <InfoAffordance title={title} description={description} />}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state === 'ok' ? children : (
          <div style={{
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: state === 'loading' ? INK.muted : MESSAGE_COLOR[state],
            fontSize: '0.85rem',
          }}>{state === 'loading' ? '…' : MESSAGE[state]}</div>
        )}
      </div>
    </div>
  );
}
