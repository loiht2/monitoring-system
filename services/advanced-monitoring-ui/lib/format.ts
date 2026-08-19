/** Grafana unit ids the panel spec carries, rendered the way Grafana renders them. */
export function formatValue(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'percentunit': return `${(v * 100).toFixed(1)}%`;
    case 'percent':     return `${v.toFixed(1)}%`;
    case 'watt':        return `${v.toFixed(0)} W`;
    case 'celsius':     return `${v.toFixed(0)} °C`;
    case 'hertz':       return si(v, 'Hz');
    case 'bytes':       return bytes(v);
    case 'Bps':         return `${bytes(v)}/s`;
    case 's':           return duration(v);
    case 'ops':         return `${si(v, '')} ops/s`;
    // Named for what they count, not the generic `ops`: the dashboard sets these so a
    // reader sees "allocations/s" rather than an unlabelled rate. Grafana appends an
    // unknown unit string as a suffix; without these cases the UI dropped the label.
    case 'allocations/s': return `${si(v, '')} allocations/s`;
    case 'frees/s':       return `${si(v, '')} frees/s`;
    default:            return si(v, '');
  }
}

/** Seconds, scaled down. A GPU latency is usually microseconds, and rendering it through
 *  the plain SI helper collapsed it to "0.00" — the panel then looked idle when it was
 *  merely fast. Scales down only: 3600 s stays "3600 s" rather than becoming "1 h",
 *  because these are durations of operations, not wall-clock spans. */
function duration(v: number): string {
  if (v === 0) return '0 s';
  const abs = Math.abs(v);
  if (abs < 1e-6) return `${round(v * 1e9)} ns`;
  if (abs < 1e-3) return `${round(v * 1e6)} µs`;
  if (abs < 1)    return `${round(v * 1e3)} ms`;
  return `${round(v)} s`;
}

/** One decimal below 10, none above — enough to separate 3.4 ms from 3.9 ms without
 *  implying precision the histogram bucket does not have. */
function round(v: number): string {
  return Math.abs(v) < 10 ? String(Number(v.toFixed(1))) : String(Math.round(v));
}

function bytes(v: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function si(v: number, suffix: string): string {
  const u = ['', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (Math.abs(v) >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  const n = Math.abs(v) < 10 && i === 0 ? v.toFixed(2) : v.toFixed(i ? 1 : 0);
  // The prefix belongs against the unit symbol: 1.4 GHz, not "1.4G Hz".
  return suffix ? `${n} ${u[i]}${suffix}` : `${n}${u[i]}`;
}
