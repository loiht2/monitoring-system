'use client';
import { ReactNode, useState } from 'react';
import { INK, SURFACE, RADIUS } from '@/lib/theme';

/** A collapsible row card. Replaces `<details>/<summary>`, whose browser-default
 *  triangle carried no panel count and no card edge. The default open state is the
 *  Grafana row state the caller passes in. */
export function RowSection({ title, panelCount, defaultOpen, children }: {
  title: string;
  panelCount: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ background: SURFACE.panel, border: `1px solid ${SURFACE.border}`,
                      borderRadius: RADIUS, marginBottom: '0.9rem', overflow: 'hidden' }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                       background: SURFACE.raised, border: 'none', color: INK.primary,
                       cursor: 'pointer', padding: '0.6rem 0.9rem', textAlign: 'left' }}>
        {/* Drawn, not typed: the container image's font stack is thin enough that `ⓘ`
            rendered as tofu, so structural affordances use geometry instead of glyphs. */}
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12"
             style={{ color: INK.muted, flex: '0 0 auto',
                      transition: 'transform 120ms ease',
                      transform: `rotate(${open ? 90 : 0}deg)` }}>
          <path d="M4.5 2.5 L8 6 L4.5 9.5" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: '0.95rem', fontWeight: 600, color: INK.primary }}>{title}</span>
        <span style={{ fontSize: '0.8rem', color: INK.muted }}>
          · {panelCount} {panelCount === 1 ? 'panel' : 'panels'}
        </span>
      </button>
      {open && <div style={{ padding: '0.8rem' }}>{children}</div>}
    </section>
  );
}
