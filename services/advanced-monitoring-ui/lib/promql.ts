/** Template-variable substitution and range-step derivation.
 *
 * The panel spec stores Grafana's expressions verbatim, including `$gpu`, `$pod` and
 * Grafana's built-ins. Substituting here — immediately before the request — keeps the
 * stored spec byte-identical to the Grafana source it was extracted from.
 *
 * Until this handled the built-ins, all 27 eBPF panels sent literal `$__range` to
 * Prometheus, got a 400, and rendered as "No data in this range". See
 * specs/13-ui-visual-design.md §0.2.
 */

/** Escape a label value so it cannot change the meaning of the surrounding regex. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Seconds as a PromQL duration literal, whole units only. */
export function formatDuration(seconds: number): string {
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/** Grafana's own rule: max(step + scrape, 4 × scrape). Narrower than the real scrape
 *  interval and the rate window straddles too few samples, producing gaps. */
export function rateInterval(step: number, scrapeInterval: number): string {
  return `${Math.max(step + scrapeInterval, 4 * scrapeInterval)}s`;
}

export interface SubstituteOptions {
  rangeSeconds: number;
  step: number;
  scrapeInterval: number;
}

export function substituteVars(
  expr: string,
  vars: Record<string, string[]>,
  opts: SubstituteOptions,
): string {
  let out = expr;

  // Built-ins first, longest name first so `$__rate_interval` is never matched as a
  // prefix by a shorter built-in.
  const builtins: [string, string][] = [
    ['$__rate_interval', rateInterval(opts.step, opts.scrapeInterval)],
    ['$__range', formatDuration(opts.rangeSeconds)],
    ['$__all', '.*'],
  ];
  for (const [name, value] of builtins) out = out.split(name).join(value);

  for (const [name, values] of Object.entries(vars)) {
    const selected = values.filter((v) => v !== 'All');
    // Empty or "All" means every series — `.*` rather than an empty alternation,
    // which would match only the empty string and silently blank the panel.
    const repl = selected.length ? selected.map(escapeRe).join('|') : '.*';
    out = out.split(`$${name}`).join(repl);
  }
  return out;
}

/** Pick a step that keeps a range query near 200 points, so wide ranges stay cheap. */
export function deriveStep(rangeSeconds: number, targetPoints = 200): number {
  return Math.max(1, Math.floor(rangeSeconds / targetPoints));
}

/** Matches the widest ServiceMonitor interval in deploy/. The widest is the safe
 *  choice: a rate window sized for a faster scrape than the real one yields gaps. */
export const SCRAPE_INTERVAL_SECONDS = 30;
