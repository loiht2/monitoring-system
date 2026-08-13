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
