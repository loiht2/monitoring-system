'use client';
import { INK } from '@/lib/theme';
import { legendItems } from '@/lib/legend';
import { isHidden } from '@/lib/visibility';

/** Legend rows, rendered outside the canvas. Chart.js's built-in legend eats plot
 *  height and cannot be styled to match the page. Identity is never colour-alone: the
 *  chip carries the colour, the label carries the name. See §3.
 *
 *  Every series is listed and the list scrolls — height is a layout problem, so it is
 *  capped by the container rather than by deleting names. Clicking a row toggles that
 *  series, alt/⌘-click isolates it. §9, §9.1. */
export function Legend({ items, unsupported = [], hidden = new Set<string>(), onToggle }: {
  items: { key: string; label: string; color: string }[];
  unsupported?: string[];
  hidden?: Set<string>;
  onToggle?: (key: string, isolate: boolean) => void;
}) {
  // One series is named by the panel title — but a named absence always needs saying.
  if (items.length < 2 && unsupported.length === 0) return null;
  const rows = legendItems(items);
  const row = { display: 'inline-flex', alignItems: 'center', gap: '0.3rem' } as const;
  return (
    <div style={{ marginBottom: '0.5rem', fontSize: '0.75rem', color: INK.secondary }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.8rem',
                    maxHeight: '7.5rem', overflowY: 'auto' }}>
        {rows.map((s) => {
          const off = isHidden(hidden, s.key!);
          return (
            <button key={s.key} type="button" aria-pressed={!off}
                    onClick={(e) => onToggle?.(s.key!, e.altKey || e.metaKey)}
                    style={{ ...row, background: 'none', border: 'none', padding: 0,
                             font: 'inherit', color: 'inherit', cursor: 'pointer',
                             opacity: off ? 0.45 : 1 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2,
                                         background: s.color, flex: '0 0 auto' }} />
              {s.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.8rem' }}>
      {unsupported.map((label) => (
        // No colour chip: there is no series. The ring says "a slot that stays empty".
        <span key={`u-${label}`} style={{ display: 'inline-flex', alignItems: 'center',
                                          gap: '0.3rem', color: INK.muted }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, flex: '0 0 auto',
                                     border: `1px solid ${INK.muted}` }} />
          {label} — not supported on this GPU
        </span>
      ))}
      </div>
    </div>
  );
}
