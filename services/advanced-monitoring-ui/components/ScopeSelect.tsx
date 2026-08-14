'use client';
import { useEffect, useRef, useState } from 'react';
import { INK, SURFACE, RADIUS } from '@/lib/theme';

/** `labels` renames an option for display only; the value sent to `onChange` is
 *  unchanged. Device and MIG scopes are opaque identifiers the operator cannot read —
 *  see 13 §11 — while Pod scope is already its own name and passes no map. */
export function ScopeSelect({ label, options, selected, onChange, allLabel, labels }: {
  label: string; options: string[]; selected: string[];
  onChange: (next: string[]) => void; allLabel: string;
  labels?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape. Without both, the popover strands the
  // keyboard user and swallows clicks meant for the panel behind it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = selected.length === 0 ? allLabel : `${selected.length} selected`;
  const toggle = (v: string) => onChange(
    selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em',
                    color: INK.muted, marginBottom: '0.25rem' }}>{label}</div>
      <button type="button" aria-expanded={open} aria-haspopup="listbox"
              onClick={() => setOpen(!open)}
              style={{ background: SURFACE.panel, border: `1px solid ${SURFACE.border}`,
                       borderRadius: RADIUS, color: INK.primary, cursor: 'pointer',
                       padding: '0.4rem 0.7rem', minWidth: 170, textAlign: 'left' }}>
        {summary}
        {/* Drawn, not typed: the container image's font stack is thin enough that `ⓘ`
            rendered as tofu, so structural affordances use geometry instead of glyphs. */}
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10"
             style={{ float: 'right', marginTop: '0.35rem', color: INK.muted }}>
          <path d="M1 3.5 L5 7 L9 3.5" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="listbox" aria-multiselectable
             style={{ position: 'absolute', zIndex: 20, marginTop: 4, minWidth: 240,
                      maxHeight: 280, overflowY: 'auto', background: SURFACE.raised,
                      border: `1px solid ${SURFACE.border}`, borderRadius: RADIUS,
                      padding: '0.3rem' }}>
          {options.length === 0 && (
            <div style={{ color: INK.muted, padding: '0.4rem 0.5rem' }}>None in this range</div>
          )}
          {options.map((o) => (
            <label key={o} role="option" aria-selected={selected.includes(o)}
                   style={{ display: 'flex', gap: '0.5rem', alignItems: 'center',
                            padding: '0.35rem 0.5rem', cursor: 'pointer',
                            fontSize: '0.8rem', wordBreak: 'break-all' }}>
              <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
              {labels?.[o] ?? o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
