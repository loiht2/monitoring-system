import { SERIES } from './theme';

export interface LegendRow { key?: string; label: string; color: string }

/** Every series, ordered by palette slot so hued rows come first and row n is series
 *  colour n. Nothing is folded: an earlier version summarised everything past the eighth
 *  as "Other — N more series", which answered a height problem by deleting information.
 *  Height is capped by the container instead (13 §9).
 *
 *  Colour still stops at eight (§1.2 is a CVD-validated set), so rows past the eighth
 *  share the muted Other colour and are told apart by isolating them (§9.1). */
export function legendItems(items: LegendRow[]): LegendRow[] {
  if (items.length < 2) return [];            // one series is named by the panel title
  const slot = new Map<string, number>(SERIES.map((c, i) => [c, i]));
  return [...items]
    .sort((a, b) => (slot.get(a.color) ?? SERIES.length) - (slot.get(b.color) ?? SERIES.length))
    .map((i) => ({ ...i }));
}
