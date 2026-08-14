import { SERIES, OTHER } from './theme';

/** A series' identity: its label set, order-independent.
 *  Length-prefixing each part keeps `{a:'b:c'}` distinct from `{'a:b':'c'}`. */
export function seriesKey(labels: Record<string, string>): string {
  return Object.keys(labels).sort()
    .map((k) => `${k.length}:${k}=${labels[k].length}:${labels[k]}`)
    .join(',');
}

/** Map each series to a colour, keyed by identity so re-ranking or filtering never
 *  repaints a survivor. New keys take the lowest free slot in sorted-key order —
 *  deterministic, and independent of the order the query happened to return.
 *
 *  `previous` is the panel's existing assignment. Everything in it is retained, including
 *  series not in `series` any more: their slots stay reserved. Without that, dropping one
 *  series lets the next one slide into the freed slot and change colour, which is exactly
 *  what "colour follows the entity, not its rank" forbids. Callers hold this map in a ref
 *  across refreshes, per panel. See §1.3.
 *
 *  `previous` has no default deliberately: a renderer that forgot to thread its ref would
 *  compile, pass every test, and silently restore rank-based repainting. Requiring the
 *  argument makes that omission a type error.
 *
 *  Past eight series there is no ninth hue: the remainder folds into one muted Other. */
export function assignColors(
  series: Record<string, string>[],
  previous: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...previous };
  const taken = new Set(Object.values(out));
  const fresh = [...new Set(series.map(seriesKey))].filter((k) => !(k in out)).sort();

  for (const k of fresh) {
    const free = SERIES.find((c) => !taken.has(c));
    out[k] = free ?? OTHER;
    if (free) taken.add(free);
  }
  return out;
}

/** A series' legend text: the target's legendFormat with `{{label}}` interpolated.
 *
 *  A MIG series also carries its instance id. The dashboards label an instance by
 *  GPU_I_PROFILE alone, so two 1g.6gb instances on the same card read identically and are
 *  indistinguishable on a chart — the picker says `id 5`, the legend did not. The
 *  legendFormat lives in the dashboard JSON, so the id is appended here instead, in the
 *  same `· id N` form the picker uses. A format that already names GPU_I_ID keeps it. */
export function seriesLabel(format: string, metric: Record<string, string>): string {
  const fmt = format || '';
  const interpolated = fmt.replace(/\{\{(\w+)\}\}/g, (_m, k) => metric[k] ?? '');
  const base = interpolated || Object.values(metric).join(' ');
  const id = metric.GPU_I_ID;
  if (!id || fmt.includes('{{GPU_I_ID}}')) return base;
  return `${base} · id ${id}`;
}
