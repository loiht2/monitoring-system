import { describe, it, expect } from 'vitest';
import { SERIES, SURFACE, INK, STATUS, SEQUENTIAL, OTHER } from './theme';

describe('theme', () => {
  it('uses the eight validated dark-mode series steps, in order', () => {
    // Validated by dataviz scripts/validate_palette.js against SURFACE.panel (#131922):
    // all five checks PASS. Changing any hex invalidates that result — re-run it.
    expect(SERIES).toEqual([
      '#3987e5', '#d95926', '#199e70', '#c98500',
      '#d55181', '#008300', '#9085e9', '#e66767',
    ]);
  });

  it('has no duplicate series slots', () => {
    expect(new Set(SERIES).size).toBe(SERIES.length);
  });

  it('keeps status colours out of the series palette', () => {
    for (const s of Object.values(STATUS)) expect(SERIES).not.toContain(s);
  });

  it('renders the sequential ramp dark to light for a dark surface', () => {
    // Low values recede into the surface; high values stand off it.
    expect(SEQUENTIAL[0]).toBe('#0d366b');
    expect(SEQUENTIAL[SEQUENTIAL.length - 1]).toBe('#cde2fb');
  });

  it('folds the ninth and later series into a muted Other, not a generated hue', () => {
    expect(OTHER).toBe(INK.muted);
    expect(SERIES).not.toContain(OTHER);
  });

  it('exposes the surfaces the palette was validated against', () => {
    expect(SURFACE.panel).toBe('#131922');
    expect(SURFACE.page).toBe('#0b0f16');
  });
});
