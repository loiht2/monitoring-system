/** Distinguishes "unsupported on this GPU" from "genuinely empty" using the
 *  gpu_metric_supported{gpu_uuid, GPU_I_ID, metric, source} 1|0 signal.
 */

/** Scan a PromQL expression for metric-name identifiers. Not a real parser: it just
 *  finds bare identifiers immediately followed by `{` or a PromQL boundary, skipping
 *  function calls and keywords is unnecessary here since the spec only ever names
 *  actual metrics (DCGM_FI_*, nvml_*, gpu_alloc_*, ebpf_*, GPUDevice*, ...). */
function looksLikeMetricName(id: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_:]*$/.test(id) && /[A-Za-z]/.test(id);
}

const KEYWORDS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset',
  'and', 'or', 'unless', 'bool', 'sum', 'avg', 'min', 'max', 'count', 'rate',
  'irate', 'increase', 'delta', 'idelta', 'sort', 'sort_desc', 'topk', 'bottomk',
  'quantile', 'histogram_quantile', 'abs', 'ceil', 'floor', 'round', 'clamp',
  'clamp_min', 'clamp_max', 'label_replace', 'vector', 'scalar',
]);

export function extractMetricNames(expr: string): string[] {
  // Label selectors (and their string values) are the only place non-metric identifiers
  // sit next to metric names, so drop everything inside `{...}` before scanning.
  const stripped = expr.replace(/\{[^}]*\}/g, '');
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_:]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const id = m[0];
    // Skip the unit suffix of a duration literal like `5m` or `1h30m` — the digits
    // preceding it aren't part of the identifier match, so `m`/`h` alone would land here.
    const before = stripped.slice(0, m.index);
    if (/\d$/.test(before) && /^[smhdwy]+$/.test(id)) continue;
    const after = stripped.slice(m.index + id.length).trimStart();
    // Function/aggregation names are always followed by `(`; metric names never are.
    if (after.startsWith('(')) continue;
    if (KEYWORDS.has(id)) continue;
    if (!looksLikeMetricName(id)) continue;
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export function buildSupportMap(
  rows: { metric: Record<string, string>; value: [number, string] }[],
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const row of rows) {
    const name = row.metric.metric;
    if (!name) continue;
    const supported = row.value[1] === '1';
    map[name] = map[name] || supported;
  }
  return map;
}
