'use client';
import { ReactNode } from 'react';
import { Catalog } from '@/lib/api';
import { INK, SERIES, STATUS, SURFACE } from '@/lib/theme';

/** Banner tone by dashboard uid: the MIG description is a correctness warning
 *  (instance utilisation must never be summed into a device total), the rest are
 *  informational. See §2. */
export function bannerTone(uid: string): 'info' | 'warning' {
  return uid === 'gpu-hardware-mig' ? 'warning' : 'info';
}

/** The tab's short label: the part after the em dash when the title carries one, else the
 *  whole title. Derived rather than looked up, so a renamed dashboard still gets a label. */
function tabLabel(title: string): string {
  const i = title.lastIndexOf('—');
  const tail = i === -1 ? '' : title.slice(i + 1).trim();
  return tail || title;
}

/** HH:MM in the viewer's locale, or an em dash before the first load. */
function updatedAt(when: Date | null): string {
  if (!when) return '—';
  return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** App bar, page header and the dashboard tab row. Everything below the tabs —
 *  context banner, control bar, rows — is passed as children. */
export function AppShell({ catalog, activeIndex, onSelect, eyebrow, lastUpdated, children }: {
  catalog: Catalog;
  activeIndex: number;
  onSelect: (index: number) => void;
  eyebrow: string;
  lastUpdated: Date | null;
  children: ReactNode;
}) {
  const active = catalog.dashboards[activeIndex];
  return (
    <div style={{ minHeight: '100vh', background: SURFACE.page }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                       gap: '1rem', padding: '0.7rem 1.25rem',
                       borderBottom: `1px solid ${SURFACE.border}`, background: SURFACE.panel }}>
        <span style={{ color: INK.primary, fontSize: '0.95rem', fontWeight: 600 }}>
          GPU observability
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem',
                       color: INK.secondary, fontSize: '0.8rem' }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%',
                                     background: STATUS.good, display: 'inline-block' }} />
          Updated {updatedAt(lastUpdated)}
        </span>
      </header>

      <main style={{ padding: '1.25rem', maxWidth: 1800, margin: '0 auto' }}>
        <div style={{ color: SERIES[0], fontSize: '0.72rem', textTransform: 'uppercase',
                      letterSpacing: '0.08em', fontWeight: 600 }}>
          {eyebrow}
        </div>
        <h1 style={{ margin: '0.25rem 0 0.9rem', fontSize: '2rem', fontWeight: 700,
                     color: INK.primary }}>
          {active.title}
        </h1>

        <div role="tablist" aria-label="Dashboards"
             style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap',
                      borderBottom: `1px solid ${SURFACE.border}`, marginBottom: '0.9rem' }}>
          {catalog.dashboards.map((d, i) => {
            const on = i === activeIndex;
            return (
              <button key={d.uid} type="button" role="tab" aria-selected={on}
                      onClick={() => onSelect(i)}
                      title={d.title} aria-label={d.title}
                      style={{ background: 'none', border: 'none',
                               borderBottom: `2px solid ${on ? SERIES[0] : 'transparent'}`,
                               color: on ? INK.primary : INK.muted, cursor: 'pointer',
                               fontSize: '0.9rem', fontWeight: on ? 600 : 500,
                               padding: '0.5rem 0.9rem', marginBottom: -1 }}>
                {tabLabel(d.title)}
              </button>
            );
          })}
        </div>

        {children}
      </main>
    </div>
  );
}
