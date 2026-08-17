/** Every colour in the UI. Nothing else may hold a hex literal.
 *
 *  The series palette is the reference dark-mode column, validated against SURFACE.panel
 *  with the dataviz skill's scripts/validate_palette.js — all five checks pass (lightness
 *  band, chroma floor, CVD separation, normal-vision floor, contrast). Editing any hex
 *  invalidates that; re-run the validator rather than reasoning about it.
 *  See specs/13-ui-visual-design.md §1.
 */

export const SURFACE = {
  page:   '#0b0f16',
  panel:  '#131922',
  raised: '#1a212c',
  border: 'rgba(255,255,255,0.08)',
  grid:   'rgba(255,255,255,0.06)',
} as const;

export const INK = {
  primary:   '#e6edf3',
  secondary: '#9aa7b4',
  muted:     '#6e7d8d',
} as const;

export const SERIES = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#008300', '#9085e9', '#e66767',
] as const;

/** The ninth and later series. Never a generated hue — see §1.3. */
export const OTHER = INK.muted;

/** Reserved for state. Never used for a series, and never the only cue. */
export const STATUS = {
  good:     '#0ca30c',
  warning:  '#fab219',
  serious:  '#ec835a',
  critical: '#d03b3b',
} as const;

/** One hue, dark → light: on a dark surface the near-zero end is the end that recedes. */
export const SEQUENTIAL = [
  '#0d366b', '#184f95', '#1c5cab', '#256abf',
  '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#cde2fb',
] as const;

export const RADIUS = 10;
