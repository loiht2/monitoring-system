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
    default:            return si(v, '');
  }
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
  return `${n}${u[i]}${suffix ? ' ' + suffix : ''}`;
}
