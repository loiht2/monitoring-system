import { extractMetricNames } from './support';

export interface TargetLike { expr: string; legendFormat: string }

/** Labels for the targets this panel plots that are KNOWN unsupported on the selected
 *  entities. A panel renders normally when any metric is supported, and names the ones
 *  that are not — otherwise a reader sees three of four pipes and concludes the fourth
 *  was idle. See 14 §3.1.
 *
 *  Only an explicit `false` qualifies. An absent verdict is Unverified, and asserting
 *  "not supported" without evidence is exactly what 10 §1 forbids. */
export function unsupportedTargets(
  targets: TargetLike[],
  supported: Record<string, boolean>,
): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const metrics = extractMetricNames(t.expr);
    if (!metrics.length || !metrics.every((m) => supported[m] === false)) continue;
    const label = labelFor(t, metrics[0]);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** The legend format's trailing role — "{{node}} gpu{{gpu}} · integer" -> "integer".
 *  The template variables cannot be resolved without a series, and the suffix is the
 *  part that names what is missing. */
function labelFor(t: TargetLike, metric: string): string {
  const fmt = (t.legendFormat || '').trim();
  if (!fmt) return metric;
  const tail = fmt.split('·').pop()!.trim();
  return tail && !tail.includes('{{') ? tail : metric;
}

export type EmptyState = 'partitioned' | 'unsupported' | 'nodata';

/** Which empty state an empty-but-successful panel deserves, most specific first.
 *
 *  `partitioned` outranks `unsupported` because it is the more precise statement: once
 *  MIG is on, DCGM stops reporting device-scope profiling fields and reports instance
 *  entities instead (02 §4), so the support rule can legitimately report 0 for a
 *  device-scope field on a partitioned card. Saying "not supported" there would be true
 *  but useless — the reading exists, at another scope. See 14 §3.2. */
export function emptyState(o: {
  deviceScope: boolean;
  selected: string[];
  partitioned: Set<string>;
  allUnsupported: boolean;
}): EmptyState {
  const everySelectedIsPartitioned =
    o.selected.length > 0 && o.selected.every((g) => o.partitioned.has(g));
  if (o.deviceScope && everySelectedIsPartitioned) return 'partitioned';
  if (o.allUnsupported) return 'unsupported';
  return 'nodata';
}
