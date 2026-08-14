'use client';
import { useState } from 'react';
import { INK, STATUS, SURFACE, RADIUS } from '@/lib/theme';

/** The dashboard's own `description` from the Grafana JSON — no second source, so the
 *  wording cannot drift from what check-dashboards.py governs. The MIG banner is
 *  warning-toned because its content is a correctness warning: instance utilisation
 *  must never be summed into a device total. See §2. */
export function ContextBanner({ text, tone }: { text: string; tone: 'info' | 'warning' }) {
  const [open, setOpen] = useState(false);
  const accent = tone === 'warning' ? STATUS.warning : INK.secondary;
  const [first, ...rest] = splitFirstSentence(text);
  return (
    <div style={{ display: 'flex', gap: '0.6rem', padding: '0.7rem 0.9rem',
                  background: SURFACE.raised, borderRadius: RADIUS,
                  border: `1px solid ${SURFACE.border}`, borderLeft: `3px solid ${accent}`,
                  fontSize: '0.82rem', color: INK.secondary, marginBottom: '0.9rem' }}>
      <span aria-hidden style={{ color: accent, fontWeight: 700 }}>
        {tone === 'warning' ? '!' : 'i'}
      </span>
      <div>
        {open ? text : first}
        {rest.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)}
                  style={{ marginLeft: '0.4rem', background: 'none', border: 'none',
                           color: accent, cursor: 'pointer', padding: 0,
                           textDecoration: 'underline' }}>
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
    </div>
  );
}

/** [first sentence, remainder] — the descriptions are paragraphs; the banner shows one
 *  sentence and keeps the rest a click away. */
function splitFirstSentence(text: string): [string, ...string[]] {
  const m = /^(.*?[.!?])\s+(.*)$/s.exec(text.trim());
  return m ? [m[1], m[2]] : [text.trim()];
}
