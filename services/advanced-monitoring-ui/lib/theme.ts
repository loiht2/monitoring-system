/** Every colour in the UI. Nothing else may hold a hex literal.
 *
 *  Two palettes, one token layer. The hexes below are the source of truth and are what
 *  gets validated; components never import them. What components import are the
 *  `var(--…)` tokens, so a theme switch is a single attribute on <html> and no component
 *  re-renders to change colour. app/globals.css binds the tokens to these hexes — a test
 *  asserts the two agree, because a drift there would be invisible until someone looked
 *  at the wrong-coloured page.
 *
 *  **Do not hand-edit a palette hex.** Both series palettes are validated (lightness
 *  band, chroma floor, CVD separation, contrast); each was reached by search, and
 *  adjusting one entry by eye collapses the result. Measured twice while building this:
 *  darkening published Okabe-Ito to pass contrast on the light surface dropped its
 *  deuteranopia separation from 53.7 to 0.0, and "softening" one hue of the light
 *  palette dropped protanopia separation from 62.0 to 9.0. Re-run the validator.
 *  See specs/13-ui-visual-design.md §1.
 */

/** The reference dark palette, validated with the dataviz skill's
 *  scripts/validate_palette.js against `#131922` — all five checks pass. */
export const DARK = {
  surface: { page: '#0b0f16', panel: '#131922', raised: '#1a212c',
             border: 'rgba(255,255,255,0.08)', grid: 'rgba(255,255,255,0.06)' },
  ink:     { primary: '#e6edf3', secondary: '#9aa7b4', muted: '#6e7d8d' },
  series:  ['#3987e5', '#d95926', '#199e70', '#c98500',
            '#d55181', '#008300', '#9085e9', '#e66767'],
  status:  { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
  // One hue, dark → light: on a dark surface the near-zero end is the end that recedes.
  sequential: ['#0d366b', '#184f95', '#1c5cab', '#256abf',
               '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#cde2fb'],
} as const;

/** The light palette. The series colours are a searched set: every pair stays at least
 *  59 units apart under simulated protanopia, deuteranopia and tritanopia, and every
 *  colour clears 3:1 against the `#f6f8fa` panel it is drawn on — the threshold for a
 *  graphical object such as a 2px line. Published Okabe-Ito was measured first and
 *  rejected: its separation is excellent but four of its eight fail contrast here,
 *  because it was drawn for filled marks on white rather than thin strokes. */
export const LIGHT = {
  surface: { page: '#eef1f5', panel: '#f6f8fa', raised: '#e9edf2',
             border: 'rgba(15,23,36,0.12)', grid: 'rgba(15,23,36,0.09)' },
  ink:     { primary: '#141a21', secondary: '#4a5763', muted: '#697787' },
  // Blue leads, as it does in DARK: slot 0 doubles as the UI accent (eyebrow, active
  // tab, selected control), and a dark red accent reads as an error state. Order is
  // free to choose — CVD separation is pairwise over the whole set, so reordering
  // leaves all three simulated separations byte-identical (62.0 / 66.7 / 63.0).
  series:  ['#0d98d3', '#ad5c0b', '#17a140', '#7f27a5',
            '#741b1b', '#246b5d', '#2d1b74', '#f0199a'],
  status:  { good: '#0a7a0a', warning: '#a06800', serious: '#bf5218', critical: '#b02525' },
  // Reversed against the dark ramp: on a light surface it is the near-zero end that must
  // recede into the page, so the ramp runs light → dark.
  sequential: ['#cde2fb', '#86b6ef', '#5598e7', '#3987e5',
               '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#0d366b'],
} as const;

export type ThemeName = 'dark' | 'light';
export const PALETTES: Record<ThemeName, typeof DARK | typeof LIGHT> = { dark: DARK, light: LIGHT };

/* ── The token layer components actually consume ─────────────────────────────
   These are CSS custom properties, not colours. The browser resolves them at paint
   time, which is what lets one attribute on <html> repaint the whole UI — inline
   styles and SVG `fill` both accept them. Canvas does not; see resolveColor(). */

export const SURFACE = {
  page:   'var(--bg-page)',
  panel:  'var(--bg-panel)',
  raised: 'var(--bg-raised)',
  border: 'var(--border-color)',
  grid:   'var(--grid-color)',
} as const;

export const INK = {
  primary:   'var(--text-main)',
  secondary: 'var(--text-muted)',
  muted:     'var(--text-dim)',
} as const;

export const SERIES = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
] as const;

/** The ninth and later series. Never a generated hue — see §1.3. */
export const OTHER = INK.muted;

/** Reserved for state. Never used for a series, and never the only cue. */
export const STATUS = {
  good:     'var(--good)',
  warning:  'var(--warning)',
  serious:  'var(--serious)',
  critical: 'var(--critical)',
} as const;

export const SEQUENTIAL = [
  'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)',
  'var(--seq-6)', 'var(--seq-7)', 'var(--seq-8)', 'var(--seq-9)',
] as const;

export const RADIUS = 10;

/** Resolve a `var(--x)` token to the colour it currently stands for.
 *
 *  Only canvas needs this: Chart.js writes pixels itself and never consults the
 *  cascade, so handing it the literal string "var(--series-1)" paints nothing. Every
 *  other surface (DOM, SVG) takes the token directly and repaints on a theme change
 *  for free. Returns the input unchanged when it is not a token, or when called during
 *  SSR where there is no computed style to read. */
export function resolveColor(value: string): string {
  if (typeof window === 'undefined' || !value.startsWith('var(')) return value;
  const name = value.slice(4, -1).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return resolved || value;
}

/** `resolveColor` plus an alpha suffix, for the lone-series area fill. Applying the
 *  suffix to an unresolved token would produce "var(--series-1)1a", which is not a
 *  colour and silently renders nothing. */
export function resolveColorAlpha(value: string, hexAlpha: string): string {
  const base = resolveColor(value);
  return base.startsWith('#') ? `${base}${hexAlpha}` : base;
}
