/** Template-variable substitution and range-step derivation.
 *
 * The panel spec stores Grafana's expressions verbatim, including `$gpu`. Substituting
 * here — immediately before the request — keeps the stored spec byte-identical to the
 * Grafana source it was extracted from.
 */

/** Escape a label value so it cannot change the meaning of the surrounding regex. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function substituteVars(expr: string, vars: Record<string, string[]>): string {
  let out = expr;
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
