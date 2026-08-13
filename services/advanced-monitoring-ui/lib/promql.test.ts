import { describe, it, expect } from 'vitest';
import { substituteVars, deriveStep } from './promql';

describe('substituteVars', () => {
  it('replaces $gpu with a regex alternation of the selection', () => {
    expect(substituteVars('DCGM_FI_DEV_FB_USED{gpu_uuid=~"$gpu"}', { gpu: ['GPU-a', 'GPU-b'] }))
      .toBe('DCGM_FI_DEV_FB_USED{gpu_uuid=~"GPU-a|GPU-b"}');
  });

  it('replaces an empty or All selection with .* so the panel shows everything', () => {
    expect(substituteVars('x{gpu_uuid=~"$gpu"}', { gpu: [] })).toBe('x{gpu_uuid=~".*"}');
    expect(substituteVars('x{gpu_uuid=~"$gpu"}', { gpu: ['All'] })).toBe('x{gpu_uuid=~".*"}');
  });

  it('escapes regex metacharacters in values so a UUID cannot alter the query', () => {
    expect(substituteVars('x{u=~"$gpu"}', { gpu: ['a.b+c'] })).toBe('x{u=~"a\\.b\\+c"}');
  });

  it('leaves an expression with no variable untouched', () => {
    expect(substituteVars('up', { gpu: ['GPU-a'] })).toBe('up');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(substituteVars('a{u=~"$gpu"} + b{u=~"$gpu"}', { gpu: ['g'] }))
      .toBe('a{u=~"g"} + b{u=~"g"}');
  });
});

describe('deriveStep', () => {
  it('keeps a range near 200 points', () => {
    expect(deriveStep(3600)).toBe(18);      // 1h  -> 200 points
    expect(deriveStep(300)).toBe(1);        // 5m  -> floor is 1s
    expect(deriveStep(604800)).toBe(3024);  // 7d
  });

  it('never returns zero, which Prometheus rejects', () => {
    expect(deriveStep(1)).toBeGreaterThanOrEqual(1);
  });
});
