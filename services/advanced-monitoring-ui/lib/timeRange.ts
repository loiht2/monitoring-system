/** The time window model: six one-click presets plus an absolute custom range.
 *  See specs/13-ui-visual-design.md §10. */

export const PRESETS = [
  { label: '5m', seconds: 300 },   { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },{ label: '7d', seconds: 604800 },
] as const;

export type RangeSelection =
  | { kind: 'preset'; seconds: number }
  | { kind: 'custom'; start: number; end: number };

/** Absolute [start, end] in epoch seconds. A preset follows "now"; a custom range does
 *  not — re-rendering hours later must show the same window, not a sliding one. */
export function resolveRange(sel: RangeSelection, nowSeconds: number):
    { start: number; end: number } {
  return sel.kind === 'preset'
    ? { start: nowSeconds - sel.seconds, end: nowSeconds }
    : { start: sel.start, end: sel.end };
}

/** The reason a custom range cannot be applied, or null when it can. Apply stays
 *  disabled while this is non-null: a silently-ignored Apply is worse than a disabled
 *  one, because an unchanged chart reads as "no data" rather than "bad input". */
export function validateCustom(start: number, end: number, nowSeconds: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter both a start and an end';
  if (start >= end) return 'Start must be before end';
  if (end > nowSeconds) return 'End cannot be in the future';
  return null;
}
