import { describe, it, expect } from 'vitest';
import { formatValue } from './format';

describe('formatValue', () => {
  it('renders a ratio as a percentage', () => {
    expect(formatValue(0.921, 'percentunit')).toBe('92.1%');
  });
  it('renders bytes in binary units, matching Grafana', () => {
    expect(formatValue(6241124352, 'bytes')).toBe('5.8 GiB');
  });
  it('renders throughput with a per-second suffix', () => {
    expect(formatValue(1048576, 'Bps')).toBe('1.0 MiB/s');
  });
  it('renders a non-finite value as a dash rather than NaN', () => {
    expect(formatValue(NaN, 'watt')).toBe('—');
  });
});

describe('formatValue — seconds', () => {
  it('renders sub-millisecond latency in µs rather than collapsing to 0.00', () => {
    // The bug this fixes: si() rendered 0.000123 as "0.00", destroying the value.
    // Every eBPF latency panel is a P95/P99 in seconds, so they all read as nothing.
    expect(formatValue(0.000123, 's')).toBe('123 µs');
  });

  it('scales through ns, µs, ms and s', () => {
    expect(formatValue(0.000000045, 's')).toBe('45 ns');
    expect(formatValue(0.0034, 's')).toBe('3.4 ms');
    expect(formatValue(2.5, 's')).toBe('2.5 s');
  });

  it('keeps large durations in seconds rather than inventing minutes', () => {
    expect(formatValue(3600, 's')).toBe('3600 s');
  });

  it('renders zero without a spurious unit jump', () => {
    expect(formatValue(0, 's')).toBe('0 s');
  });
});

describe('formatValue — ops', () => {
  it('keeps the rate suffix', () => {
    expect(formatValue(1234, 'ops')).toBe('1.2K ops/s');
    expect(formatValue(7, 'ops')).toBe('7.00 ops/s');
  });
});

describe('formatValue — bytes stay IEC', () => {
  it('renders MiB, not decimal MB', () => {
    // Deliberate: DCGM reports FB_USED in MiB (02 §0.3) and Grafana's `bytes` unit is
    // IEC. Decimal MB would put this UI 4.9% adrift of Grafana on the same metric.
    expect(formatValue(12616466432, 'bytes')).toBe('11.8 GiB');
    expect(formatValue(5 * 1024 * 1024, 'bytes')).toBe('5.0 MiB');
  });
});

describe('formatValue — hertz', () => {
  it('joins the SI prefix to the unit', () => {
    // si() rendered this as "1.4G Hz"; the prefix belongs against the unit symbol.
    expect(formatValue(1410000000, 'hertz')).toBe('1.4 GHz');
    expect(formatValue(500, 'hertz')).toBe('500 Hz');
  });

  it('leaves the other SI-derived renderings alone', () => {
    expect(formatValue(1024 * 1024, 'Bps')).toBe('1.0 MiB/s');
    expect(formatValue(1234, undefined)).toBe('1.2K');
  });
});

describe('formatValue — custom rate units carried from the dashboard', () => {
  // The eBPF dashboard names these two rates for what they count rather than the
  // generic `ops`. Grafana appends an unrecognised unit string as a suffix; without a
  // case here the UI fell through to `si()` and dropped the label entirely, so the
  // panel read as a bare number.
  it('renders an allocation rate with its own suffix', () => {
    expect(formatValue(1234, 'allocations/s')).toBe('1.2K allocations/s');
    expect(formatValue(7, 'allocations/s')).toBe('7.00 allocations/s');
  });

  it('renders a free rate with its own suffix', () => {
    expect(formatValue(1234, 'frees/s')).toBe('1.2K frees/s');
  });

  it('still falls back to a bare number for a unit it does not know', () => {
    expect(formatValue(1234, 'si:B/allocation')).toBe('1.2K');
  });
});
