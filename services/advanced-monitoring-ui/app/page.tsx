'use client';
import { useEffect, useState } from 'react';
import { api, Catalog } from '@/lib/api';
import { PanelGrid } from '@/components/PanelGrid';

const RANGES = [
  { label: '5m', s: 300 }, { label: '15m', s: 900 }, { label: '1h', s: 3600 },
  { label: '6h', s: 21600 }, { label: '24h', s: 86400 }, { label: '7d', s: 604800 },
];
const REFRESH = [
  { label: 'Off', v: 0 }, { label: '10s', v: 10 }, { label: '30s', v: 30 },
  { label: '1m', v: 60 }, { label: '5m', v: 300 },
];

export default function Page() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [dash, setDash] = useState(0);
  const [gpus, setGpus] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [range, setRange] = useState(3600);
  const [tick, setTick] = useState(0);
  const [refresh, setRefresh] = useState(() => {
    if (typeof window === 'undefined') return 0;          // SSR guard
    return Number(localStorage.getItem('adv_mon_refresh') ?? 0) || 0;
  });

  useEffect(() => { api.getCatalog().then(setCat).catch(() => setCat(null)); }, []);
  useEffect(() => {
    // Scoped to the selected range: unscoped, a deleted device still appears.
    const end = Math.floor(Date.now() / 1000);
    api.labelValues('gpu_uuid', end - range, end).then((r) => setGpus(r.values)).catch(() => {});
  }, [range, tick]);
  useEffect(() => { localStorage.setItem('adv_mon_refresh', String(refresh)); }, [refresh]);
  useEffect(() => {
    if (!refresh) return;
    const t = setInterval(() => setTick((n) => n + 1), refresh * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const vars = { gpu: sel };
  const sx = { background: 'var(--bg-panel,#161b22)', color: 'var(--text-main)',
               border: '1px solid var(--border-color,#30363d)', borderRadius: 6,
               padding: '0.35rem 0.5rem' };

  if (!cat) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading…</div>;
  const d = cat.dashboards[dash];

  return (
    <div style={{ padding: '1.25rem', maxWidth: 1800, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap',
                    marginBottom: '1rem' }}>
        <select value={dash} onChange={(e) => setDash(Number(e.target.value))} style={sx}>
          {cat.dashboards.map((x, i) => <option key={x.uid} value={i}>{x.title}</option>)}
        </select>
        <select multiple value={sel} style={{ ...sx, minWidth: 220, height: 34 }}
                onChange={(e) => setSel([...e.target.selectedOptions].map((o) => o.value))}>
          {gpus.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} style={sx}>
          {RANGES.map((r) => <option key={r.s} value={r.s}>{r.label}</option>)}
        </select>
        <select value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} style={sx}>
          {REFRESH.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        <button onClick={() => setTick((n) => n + 1)} style={{ ...sx, cursor: 'pointer' }}>↻</button>
      </div>

      {d.rows.map((row) => (
        <details key={row.title} open={!row.collapsed} style={{ marginBottom: '1rem' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.85rem',
                            marginBottom: '0.6rem' }}>{row.title}</summary>
          <PanelGrid panels={row.panels} vars={vars} rangeSeconds={range} tick={tick} />
        </details>
      ))}
    </div>
  );
}
