import { describe, it, expect } from 'vitest';
import { substituteVars, deriveStep, formatDuration, rateInterval } from './promql';

const OPTS = { rangeSeconds: 3600, step: 18, scrapeInterval: 30 };

describe('substituteVars', () => {
  it('replaces $gpu with a regex alternation of the selection', () => {
    expect(substituteVars('DCGM_FI_DEV_FB_USED{gpu_uuid=~"$gpu"}', { gpu: ['GPU-a', 'GPU-b'] }, OPTS))
      .toBe('DCGM_FI_DEV_FB_USED{gpu_uuid=~"GPU-a|GPU-b"}');
  });

  it('replaces an empty or All selection with .* so the panel shows everything', () => {
    expect(substituteVars('x{gpu_uuid=~"$gpu"}', { gpu: [] }, OPTS)).toBe('x{gpu_uuid=~".*"}');
    expect(substituteVars('x{gpu_uuid=~"$gpu"}', { gpu: ['All'] }, OPTS)).toBe('x{gpu_uuid=~".*"}');
  });

  it('escapes regex metacharacters in values so a UUID cannot alter the query', () => {
    expect(substituteVars('x{u=~"$gpu"}', { gpu: ['a.b+c'] }, OPTS)).toBe('x{u=~"a\\.b\\+c"}');
  });

  it('leaves an expression with no variable untouched', () => {
    expect(substituteVars('up', { gpu: ['GPU-a'] }, OPTS)).toBe('up');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(substituteVars('a{u=~"$gpu"} + b{u=~"$gpu"}', { gpu: ['g'] }, OPTS))
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

describe('formatDuration', () => {
  it('renders seconds, minutes, hours and days as PromQL literals', () => {
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(45)).toBe('45s');
  });

  it('uses the largest unit that divides exactly', () => {
    expect(formatDuration(5400)).toBe('90m');   // not a whole hour, but a whole minute
  });

  it('falls back to seconds when the range is not a whole unit', () => {
    expect(formatDuration(5401)).toBe('5401s');
  });
});

describe('rateInterval', () => {
  it('is never narrower than four scrape intervals', () => {
    // A rate window narrower than the true scrape interval yields gaps.
    expect(rateInterval(1, 30)).toBe('120s');
  });

  it('widens with the step once the step dominates', () => {
    expect(rateInterval(300, 30)).toBe('330s');
  });
});

describe('substituteVars — built-ins', () => {
  const opts = { rangeSeconds: 3600, step: 18, scrapeInterval: 30 };

  it('resolves $__range to the selected range', () => {
    expect(substituteVars('increase(x[$__range])', {}, opts)).toBe('increase(x[1h])');
  });

  it('resolves $__rate_interval', () => {
    expect(substituteVars('rate(x[$__rate_interval])', {}, opts)).toBe('rate(x[120s])');
  });

  it('resolves $__all like an empty selection', () => {
    expect(substituteVars('x{p=~"$__all"}', {}, opts)).toBe('x{p=~".*"}');
  });

  it('substitutes pod alongside gpu', () => {
    expect(substituteVars('x{pod=~"$pod",gpu=~"$gpu"}', { pod: ['a'], gpu: ['g1'] }, opts))
      .toBe('x{pod=~"a",gpu=~"g1"}');
  });

  it('leaves no literal $ in a real eBPF expression', () => {
    const expr = 'sum(increase(ebpf_cuda_kernel_launch_calls_total'
               + '{k8s_pod_name=~"$pod",gpu_uuid=~"$gpu"}[$__range]))';
    expect(substituteVars(expr, { pod: [], gpu: [] }, opts)).not.toContain('$');
  });

  it('does not mistake $__rate_interval for $__range', () => {
    // $__range is a prefix of nothing, but naive ordering can corrupt longer names.
    expect(substituteVars('rate(x[$__rate_interval])', {}, opts)).not.toContain('range');
  });
});
