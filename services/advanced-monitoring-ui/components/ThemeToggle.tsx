'use client';
import { useTheme } from './ThemeProvider';
import { INK, SURFACE, RADIUS } from '@/lib/theme';

/** Sun and moon drawn rather than typed: the container image's font stack renders many
 *  symbol glyphs as tofu, which is why every other affordance here is geometry too. */
function Icon({ theme }: { theme: 'dark' | 'light' }) {
  return theme === 'dark' ? (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 9.5A5.6 5.6 0 0 1 6.5 2.5a5.8 5.8 0 1 0 7 7Z"
            fill="currentColor" />
    </svg>
  ) : (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3.1" fill="currentColor" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <line key={a} x1="8" y1="1.4" x2="8" y2="3.1" stroke="currentColor"
              strokeWidth="1.4" strokeLinecap="round"
              transform={`rotate(${a} 8 8)`} />
      ))}
    </svg>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      // The label names the destination, not the current state: a control that says
      // "dark" while the page is dark reads as a status, not a switch.
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        background: SURFACE.raised, border: `1px solid ${SURFACE.border}`,
        borderRadius: RADIUS, color: INK.secondary, cursor: 'pointer',
        padding: '0.3rem 0.6rem', fontSize: '0.78rem', lineHeight: 1,
      }}
    >
      <Icon theme={theme} />
      <span>{next === 'light' ? 'Light' : 'Dark'}</span>
    </button>
  );
}
