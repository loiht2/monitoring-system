/** Which series a panel is currently hiding, keyed by series key. View state only: it is
 *  per panel and resets on reload, because a hidden series is a temporary act of looking
 *  and silently restoring one across sessions would mean a panel that hides data without
 *  saying so (13 §9.1). */
export function isHidden(hidden: Set<string>, key: string): boolean {
  return hidden.has(key);
}

export function toggle(hidden: Set<string>, key: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/** Show only `key`. Isolating the series that is already the only visible one clears the
 *  isolation instead — without that, alt-clicking twice strands the reader with 46 hidden
 *  series and no obvious way back. */
export function isolate(allKeys: string[], key: string, current?: Set<string>): Set<string> {
  const alreadyIsolated =
    current !== undefined &&
    !current.has(key) &&
    allKeys.every((k) => k === key || current.has(k));
  return alreadyIsolated ? new Set() : new Set(allKeys.filter((k) => k !== key));
}
