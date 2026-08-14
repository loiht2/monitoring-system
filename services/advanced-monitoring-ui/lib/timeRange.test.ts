import { describe, it, expect } from 'vitest';
import { resolveRange, validateCustom, PRESETS } from './timeRange';

describe('resolveRange', () => {
  it('resolves a preset relative to now', () => {
    const r = resolveRange({ kind: 'preset', seconds: 3600 }, 1_000_000);
    expect(r).toEqual({ start: 996_400, end: 1_000_000 });
  });

  it('returns a custom range verbatim, not relative to now', () => {
    // Absolute on purpose: re-rendering hours later must show the same window.
    const r = resolveRange({ kind: 'custom', start: 100, end: 700 }, 9_999_999);
    expect(r).toEqual({ start: 100, end: 700 });
  });

  it('reports the span so step derivation is identical for both kinds', () => {
    expect(resolveRange({ kind: 'custom', start: 100, end: 700 }, 0).end
         - resolveRange({ kind: 'custom', start: 100, end: 700 }, 0).start).toBe(600);
  });
});

describe('validateCustom', () => {
  it('accepts a well-formed past window', () => {
    expect(validateCustom(100, 700, 1000)).toBeNull();
  });

  it('rejects a start at or after the end', () => {
    expect(validateCustom(700, 700, 1000)).toBe('Start must be before end');
    expect(validateCustom(800, 700, 1000)).toBe('Start must be before end');
  });

  it('rejects an end in the future', () => {
    // Prometheus has nothing there; a silently-empty panel would look like a bug.
    expect(validateCustom(100, 2000, 1000)).toBe('End cannot be in the future');
  });

  it('rejects a zero-length or unparseable input', () => {
    expect(validateCustom(NaN, 700, 1000)).toBe('Enter both a start and an end');
    expect(validateCustom(100, NaN, 1000)).toBe('Enter both a start and an end');
  });
});

describe('PRESETS', () => {
  it('keeps the six one-click ranges', () => {
    expect(PRESETS.map((p) => p.label)).toEqual(['5m', '15m', '1h', '6h', '24h', '7d']);
  });
});
