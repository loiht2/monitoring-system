import { describe, it, expect } from 'vitest';
import { pointRadiusFor, SPARSE_POINT_THRESHOLD, bucketDensity, bound } from './chart';

describe('pointRadiusFor', () => {
  it('draws a marker for a single-sample series', () => {
    // The bug this exists for: Chart.js strokes segments between points, so one
    // point with radius 0 renders literally nothing — the panel reads as empty
    // even though the query returned data. A 7d window over a short workload
    // routinely lands here.
    expect(pointRadiusFor(1)).toBeGreaterThan(0);
  });

  it('draws markers for a handful of samples', () => {
    // Measured against the live cluster: a 24h window over a ~10-minute workload
    // returns 10-11 samples per series, a 7d window returns 1-3.
    expect(pointRadiusFor(3)).toBeGreaterThan(0);
    expect(pointRadiusFor(11)).toBeGreaterThan(0);
  });

  it('hides markers once the series is dense enough to read as a line', () => {
    // A 5m window returns ~127 samples; markers there would smear the line.
    expect(pointRadiusFor(127)).toBe(0);
  });

  it('switches exactly at the threshold', () => {
    expect(pointRadiusFor(SPARSE_POINT_THRESHOLD)).toBeGreaterThan(0);
    expect(pointRadiusFor(SPARSE_POINT_THRESHOLD + 1)).toBe(0);
  });
});

describe('bound', () => {
  it('sorts +Inf above every finite bound', () => {
    expect(bound('+Inf')).toBe(Number.POSITIVE_INFINITY);
    expect(bound('0.01')).toBeLessThan(bound('+Inf'));
  });
});

describe('bucketDensity', () => {
  // Prometheus histogram buckets are cumulative: le="0.01" already contains
  // everything le="0.001" counted. A heatmap drawn from them directly is a
  // monotonic wash where +Inf is always darkest — which is exactly why the
  // latency-distribution panel was unreadable.
  const cumulative = [
    { le: '0.001', pts: [[0, 2], [10, 1]] as [number, number][] },
    { le: '0.01',  pts: [[0, 5], [10, 4]] as [number, number][] },
    { le: '+Inf',  pts: [[0, 9], [10, 4]] as [number, number][] },
  ];

  it('subtracts each bucket from the one below it', () => {
    const d = bucketDensity(cumulative);
    expect(d.map((r) => r.le)).toEqual(['0.001', '0.01', '+Inf']);
    expect(d[0].pts.map((p) => p[1])).toEqual([2, 1]);   // lowest keeps its own count
    expect(d[1].pts.map((p) => p[1])).toEqual([3, 3]);   // 5-2, 4-1
    expect(d[2].pts.map((p) => p[1])).toEqual([4, 0]);   // 9-5, 4-4
  });

  it('preserves the total across all buckets', () => {
    // The widest cumulative bucket is the total count; densities must re-sum to it.
    const d = bucketDensity(cumulative);
    const at0 = d.reduce((sum, r) => sum + r.pts[0][1], 0);
    expect(at0).toBe(9);
  });

  it('sorts rows by bound regardless of input order', () => {
    const shuffled = [cumulative[2], cumulative[0], cumulative[1]];
    expect(bucketDensity(shuffled).map((r) => r.le)).toEqual(['0.001', '0.01', '+Inf']);
  });

  it('clamps a negative difference to zero', () => {
    // Cumulative counts should never decrease with le, but two series scraped a
    // moment apart can disagree at the edge; a negative cell has no meaning here.
    const skewed = [
      { le: '0.001', pts: [[0, 5]] as [number, number][] },
      { le: '0.01',  pts: [[0, 3]] as [number, number][] },
    ];
    expect(bucketDensity(skewed)[1].pts[0][1]).toBe(0);
  });

  it('treats a missing sample in the row below as zero', () => {
    const ragged = [
      { le: '0.001', pts: [[0, 1]] as [number, number][] },
      { le: '+Inf',  pts: [[0, 4], [10, 7]] as [number, number][] },
    ];
    expect(bucketDensity(ragged)[1].pts.map((p) => p[1])).toEqual([3, 7]);
  });
});
