import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERIES, SURFACE, INK, STATUS, SEQUENTIAL, OTHER,
  DARK, LIGHT, PALETTES, resolveColor, resolveColorAlpha,
} from './theme';

const CSS = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

/** The value bound to a token, in the dark (`:root`) or light block. */
function tokenValue(name: string, theme: 'dark' | 'light'): string | undefined {
  const block = theme === 'dark'
    ? CSS.slice(CSS.indexOf(':root {'), CSS.indexOf(":root[data-theme='light']"))
    : CSS.slice(CSS.indexOf(":root[data-theme='light']"));
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
}

describe('palettes', () => {
  it('keeps the eight validated dark-mode series steps, in order', () => {
    // Validated by dataviz scripts/validate_palette.js against DARK.surface.panel:
    // all five checks PASS. Changing any hex invalidates that — re-run it.
    expect(DARK.series).toEqual([
      '#3987e5', '#d95926', '#199e70', '#c98500',
      '#d55181', '#008300', '#9085e9', '#e66767',
    ]);
  });

  it('keeps the eight searched light-mode series steps, in order', () => {
    // Searched, not hand-picked: min pairwise separation 62 under simulated
    // protanopia/deuteranopia/tritanopia, every entry >= 3:1 on #f6f8fa. Adjusting
    // one entry by eye dropped that to 9 when it was tried.
    expect(LIGHT.series).toEqual([
      '#0d98d3', '#ad5c0b', '#17a140', '#7f27a5',
      '#741b1b', '#246b5d', '#2d1b74', '#f0199a',
    ]);
  });

  it('has no duplicate series slots in either palette', () => {
    for (const p of Object.values(PALETTES)) {
      expect(new Set(p.series).size).toBe(p.series.length);
    }
  });

  it('keeps status colours out of the series palette', () => {
    for (const p of Object.values(PALETTES)) {
      for (const s of Object.values(p.status)) expect(p.series).not.toContain(s);
    }
  });

  it('runs each sequential ramp away from its own surface', () => {
    // Low values must recede into the page, so the ramps run in opposite directions.
    expect(DARK.sequential[0]).toBe('#0d366b');                            // dark → light
    expect(DARK.sequential[DARK.sequential.length - 1]).toBe('#cde2fb');
    expect(LIGHT.sequential[0]).toBe('#cde2fb');                           // light → dark
    expect(LIGHT.sequential[LIGHT.sequential.length - 1]).toBe('#0d366b');
  });

  it('gives both palettes the same number of slots', () => {
    // A theme switch must never change how many series get a distinct hue.
    expect(LIGHT.series.length).toBe(DARK.series.length);
    expect(LIGHT.sequential.length).toBe(DARK.sequential.length);
  });
});

describe('tokens', () => {
  it('exposes tokens rather than hexes, so a theme switch needs no re-render', () => {
    expect(SERIES.every((c) => c.startsWith('var(--'))).toBe(true);
    expect(SURFACE.panel).toBe('var(--bg-panel)');
    expect(INK.primary).toBe('var(--text-main)');
    expect(SEQUENTIAL.every((c) => c.startsWith('var(--'))).toBe(true);
    expect(Object.values(STATUS).every((c) => c.startsWith('var(--'))).toBe(true);
  });

  it('folds the ninth and later series into a muted Other, not a generated hue', () => {
    expect(OTHER).toBe(INK.muted);
    expect(SERIES).not.toContain(OTHER);
  });
});

describe('globals.css matches the palettes', () => {
  // The hexes live in two places by necessity — TypeScript cannot emit CSS custom
  // properties, and canvas cannot read them from TypeScript. This is the guard that
  // keeps them the same: drift here would show as a wrong-coloured page and nothing else.
  it('binds every dark series slot to the DARK palette', () => {
    DARK.series.forEach((hex, i) => expect(tokenValue(`--series-${i + 1}`, 'dark')).toBe(hex));
  });

  it('binds every light series slot to the LIGHT palette', () => {
    LIGHT.series.forEach((hex, i) => expect(tokenValue(`--series-${i + 1}`, 'light')).toBe(hex));
  });

  it('binds both sequential ramps', () => {
    DARK.sequential.forEach((hex, i) => expect(tokenValue(`--seq-${i + 1}`, 'dark')).toBe(hex));
    LIGHT.sequential.forEach((hex, i) => expect(tokenValue(`--seq-${i + 1}`, 'light')).toBe(hex));
  });

  it('binds the surfaces and ink each palette was validated against', () => {
    expect(tokenValue('--bg-panel', 'dark')).toBe(DARK.surface.panel);
    expect(tokenValue('--bg-page', 'dark')).toBe(DARK.surface.page);
    expect(tokenValue('--bg-panel', 'light')).toBe(LIGHT.surface.panel);
    expect(tokenValue('--bg-page', 'light')).toBe(LIGHT.surface.page);
    expect(tokenValue('--text-main', 'light')).toBe(LIGHT.ink.primary);
  });

  it('defaults to dark, so a first paint never flashes white', () => {
    expect(CSS.indexOf(':root {')).toBeLessThan(CSS.indexOf(":root[data-theme='light']"));
    expect(tokenValue('--bg-page', 'dark')).toBe(DARK.surface.page);
  });
});

describe('resolveColor', () => {
  // Canvas cannot read the cascade, so Chart.js needs a real colour. There is no
  // document in this environment, which is exactly the SSR case.
  it('passes a plain colour through untouched', () => {
    expect(resolveColor('#3987e5')).toBe('#3987e5');
  });

  it('returns the token unchanged when there is no document to resolve against', () => {
    expect(resolveColor('var(--series-1)')).toBe('var(--series-1)');
  });

  it('appends alpha only to a resolved hex, never to a bare token', () => {
    // "var(--series-1)1a" is not a colour; it would silently paint nothing.
    expect(resolveColorAlpha('#3987e5', '1a')).toBe('#3987e51a');
    expect(resolveColorAlpha('var(--series-1)', '1a')).toBe('var(--series-1)');
  });
});
