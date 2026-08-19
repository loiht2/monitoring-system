/** Chart rendering decisions that are pure enough to test without a canvas.
 *  See specs/13-ui-visual-design.md §8. */

/** Below this many samples a line is too sparse to read on its own. Chosen so points
 *  appear at roughly 10px spacing or wider on a typical ~400px-wide panel. */
export const SPARSE_POINT_THRESHOLD = 40;

/** Marker radius for a series, mirroring Grafana's `showPoints: 'auto'`.
 *
 *  A line with a single sample draws nothing at all — Chart.js has no segment to
 *  stroke — and two or three samples draw a hairline that reads as an empty panel.
 *  That is exactly what a wide window over a short-lived workload produces: a 7d
 *  range steps at ~50 minutes, so ten minutes of traffic collapses to one or two
 *  points. Showing markers when the data is sparse is what makes those windows
 *  legible instead of blank. Dense series keep 0 — markers at every sample would
 *  smear a busy line into a band. */
export function pointRadiusFor(sampleCount: number): number {
  return sampleCount <= SPARSE_POINT_THRESHOLD ? 2.5 : 0;
}

export interface BucketRow {
  /** The bucket's upper bound, as Prometheus writes it: a number, or `+Inf`. */
  le: string;
  /** [timestampSeconds, value] pairs, aligned across rows by the range query's step. */
  pts: [number, number][];
}

/** Turn Prometheus's *cumulative* histogram buckets into per-bucket counts.
 *
 *  `_bucket` is cumulative: `le="0.01"` counts everything ≤10ms, which includes
 *  everything the `le="0.001"` row already counted. Drawing those rows straight to a
 *  heatmap therefore paints a monotonic top-heavy wash — the `+Inf` row is always the
 *  darkest, every row below is dimmer, and where the latency actually concentrates is
 *  invisible. Subtracting each row from the one below is what makes a bucket's own
 *  occupancy readable, and is what Grafana's heatmap does with a `format: heatmap`
 *  query.
 *
 *  Rows are sorted by bound first, so the caller may pass them in any order. A negative
 *  difference is clamped to zero: cumulative counts should never decrease with `le`, but
 *  two series scraped a moment apart can disagree at the edge, and a negative cell has
 *  no meaning in a density plot. */
export function bucketDensity(rows: BucketRow[]): BucketRow[] {
  const sorted = [...rows].sort((a, b) => bound(a.le) - bound(b.le));
  return sorted.map((row, i) => {
    const below = i === 0 ? null : sorted[i - 1];
    return {
      le: row.le,
      pts: row.pts.map(([t, v], j) => {
        const under = below?.pts[j]?.[1] ?? 0;
        return [t, Math.max(0, v - under)] as [number, number];
      }),
    };
  });
}

/** `+Inf` sorts above every finite bound; anything unparseable sorts last. */
export function bound(le: string): number {
  const n = Number(le);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}
