import { describe, it, expect } from 'vitest';
import { legendItems } from './legend';
import { SERIES, OTHER } from './theme';

describe('legendItems', () => {
  it('lists every series, however many there are', () => {
    // Reverses the earlier Other-fold: naming 8 of 47 hid what the panel was plotting.
    const items = [
      ...SERIES.map((c, i) => ({ label: `hued-${i}`, color: c })),
      ...Array.from({ length: 39 }, (_, i) => ({ label: `grey-${i}`, color: OTHER })),
    ];
    const r = legendItems(items);
    expect(r).toHaveLength(47);
    expect(r.some((x) => x.label.startsWith('Other —'))).toBe(false);
  });

  it('still orders by palette slot, hued first', () => {
    const items = [
      { label: 'grey', color: OTHER },
      { label: 'third', color: SERIES[2] },
      { label: 'first', color: SERIES[0] },
    ];
    expect(legendItems(items).map((x) => x.label)).toEqual(['first', 'third', 'grey']);
  });

  it('leaves a single series unlisted — the panel title names it', () => {
    expect(legendItems([{ label: 'only', color: SERIES[0] }])).toEqual([]);
  });

  it('carries the series key through, so rows keep a stable identity', () => {
    const items = [
      { key: 'k-b', label: 'dup', color: SERIES[1] },
      { key: 'k-a', label: 'dup', color: SERIES[0] },
    ];
    expect(legendItems(items).map((x) => x.key)).toEqual(['k-a', 'k-b']);
  });
});
