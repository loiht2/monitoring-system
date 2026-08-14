import { describe, it, expect } from 'vitest';
import { toggle, isolate, isHidden } from './visibility';

describe('toggle', () => {
  it('hides a visible series and shows a hidden one', () => {
    expect(isHidden(toggle(new Set(), 'a'), 'a')).toBe(true);
    expect(isHidden(toggle(new Set(['a']), 'a'), 'a')).toBe(false);
  });

  it('does not disturb the other series', () => {
    const r = toggle(new Set(['b']), 'a');
    expect(isHidden(r, 'b')).toBe(true);
  });
});

describe('isolate', () => {
  it('hides every series except the chosen one', () => {
    const r = isolate(['a', 'b', 'c'], 'b');
    expect(isHidden(r, 'a')).toBe(true);
    expect(isHidden(r, 'b')).toBe(false);
    expect(isHidden(r, 'c')).toBe(true);
  });

  it('un-isolates when the already-isolated series is isolated again', () => {
    // Otherwise alt-clicking the same row twice is a dead end with 46 hidden series.
    const once = isolate(['a', 'b', 'c'], 'b');
    expect(isolate(['a', 'b', 'c'], 'b', once).size).toBe(0);
  });
});
