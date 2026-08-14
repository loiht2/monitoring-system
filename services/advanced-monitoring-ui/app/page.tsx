'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, Catalog, matchFromVariableQuery } from '@/lib/api';
import { deriveStep, substituteVars, SCRAPE_INTERVAL_SECONDS } from '@/lib/promql';
import { buildSupportMap } from '@/lib/support';
import { AppShell, bannerTone } from '@/components/AppShell';
import { ContextBanner } from '@/components/ContextBanner';
import { ControlBar } from '@/components/ControlBar';
import { ScopeSelect } from '@/components/ScopeSelect';
import { RowSection } from '@/components/RowSection';
import { PanelGrid } from '@/components/PanelGrid';
import { INK } from '@/lib/theme';
import { RangeSelection, resolveRange } from '@/lib/timeRange';
import { deviceOptions, migOptions, migVars, ebpfScopeOptions } from '@/lib/scope';
import { podsForScope, unattributed, ambiguousNames, exceedsCap } from '@/lib/correlate';

/** No pod name can contain an underscore, so this alternation matches nothing. A device
 *  that resolves to no pods must yield an empty result and the ordinary "No data in this
 *  range" — an empty variable list substitutes to `.*`, which would show every pod as if
 *  it were that device's. See 13 §11.1.2. */
const NO_PODS = '__none__';

/** "GPU Hardware — Device" → "GPU HARDWARE". The catalog has no eyebrow field; the
 *  part before the em dash is the family the dashboard belongs to. */
function eyebrowFor(title: string): string {
  return title.split('—')[0].trim().toUpperCase();
}

export default function Page() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [dash, setDash] = useState(0);
  const [pods, setPods] = useState<string[]>([]);
  const [supported, setSupported] = useState<Record<string, boolean>>({});
  const [partitioned, setPartitioned] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string[]>([]);
  const [selPods, setSelPods] = useState<string[]>([]);
  const [dcgm, setDcgm] = useState<{ metric: Record<string, string> }[]>([]);
  const [alloc, setAlloc] = useState<{ metric: Record<string, string> }[]>([]);
  const [bridge, setBridge] = useState<{ metric: Record<string, string> }[]>([]);
  const [selMig, setSelMig] = useState<string[]>([]);
  const [selDev, setSelDev] = useState<string[]>([]);
  const [range, setRange] = useState<RangeSelection>({ kind: 'preset', seconds: 3600 });
  const [tick, setTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refresh, setRefresh] = useState(() => {
    if (typeof window === 'undefined') return 0;          // SSR guard
    return Number(localStorage.getItem('adv_mon_refresh') ?? 0) || 0;
  });

  // Resolved once per selection and per refresh tick, not per render: a preset follows
  // "now", but re-reading the clock on every render would retrigger every effect forever.
  const { start, end } = useMemo(
    () => resolveRange(range, Math.floor(Date.now() / 1000)), [range, tick]);
  const rangeSeconds = end - start;

  const activeDashboard = cat?.dashboards[dash];
  const podVar = activeDashboard?.variables.find((v) => v.name === 'pod');
  const isSoftware = activeDashboard?.uid === 'gpu-software';
  // Only the device tab reads device-scope fields, which are exactly the ones MIG silences.
  const deviceScope = activeDashboard?.uid === 'gpu-hardware-device';
  const migScope = activeDashboard?.uid === 'gpu-hardware-mig';
  // Both pickers come from DCGM, the one exporter that describes device and instance
  // scope coherently. A bare label_values(gpu_uuid) also picks up HAMi's dra-monitor,
  // which writes a MIG *instance* uuid into that label — an entity the Device tab can
  // never plot. See 12 §2.3.
  const devices = deviceOptions(dcgm);
  const migs = migOptions(dcgm);

  useEffect(() => { api.getCatalog().then(setCat).catch(() => {}); }, []);
  useEffect(() => {
    // The eBPF tab's device identity comes from the NVML exporter's allocation map, not
    // from eBPF's own gpu_uuid label, which covers only ~3 of 43 pods and carries no MIG
    // discriminator at all. See 13 §11.1.
    //
    // MUST be windowed, never instant. gpu_alloc_device_pod_info describes CURRENT
    // allocations: an instant query returns 0 series once the pods have finished
    // (measured: 0 instant vs 67 over 24h), which would blank the whole tab for any
    // historical range.
    if (!isSoftware) { setAlloc([]); return; }
    const span = Math.max(60, end - start);
    api.query(`last_over_time(gpu_alloc_device_pod_info[${span}s])`)
       .then((r) => setAlloc(r.result)).catch(() => setAlloc([]));
  }, [isSoftware, start, end, tick]);
  useEffect(() => {
    // Metric-scoped: a bare k8s_pod_name lookup returns every pod in the cluster,
    // including this monitoring stack's own.
    if (!podVar) { setPods([]); setSelPods([]); return; }
    api.labelValues('k8s_pod_name', start, end, matchFromVariableQuery(podVar.query))
       .then((r) => setPods(r.values)).catch(() => {});
  }, [podVar, start, end, tick]);
  useEffect(() => {
    if (isSoftware) { setSupported({}); return; }
    api.query(substituteVars('gpu_metric_supported{gpu_uuid=~"$gpu"}', { gpu: sel },
                    { rangeSeconds, step: deriveStep(rangeSeconds), scrapeInterval: SCRAPE_INTERVAL_SECONDS }))
      .then((r) => setSupported(buildSupportMap(r.result))).catch(() => setSupported({}));
  }, [isSoftware, sel, rangeSeconds, tick]);
  useEffect(() => {
    // Any gpu_uuid that reports an instance entity is a partitioned card. Same evidence
    // DCGM already provides — no new exporter, no new metric. See 14 §3.2.
    api.query('count by (gpu_uuid) (DCGM_FI_DEV_FB_USED{GPU_I_ID!=""})')
       .then((r) => setPartitioned(new Set(r.result.map((s) => s.metric.gpu_uuid))))
       .catch(() => {});
  }, [tick]);
  useEffect(() => {
    // One query, both scopes. DCGM_FI_DEV_FB_USED reports one row per entity — device
    // rows carry GPU_I_ID="", instance rows carry an id — so it describes both.
    api.query('DCGM_FI_DEV_FB_USED').then((r) => setDcgm(r.result)).catch(() => setDcgm([]));
  }, [tick]);
  useEffect(() => {
    // The mig_uuid ↔ GPU_I_ID bridge: the only series carrying both naming schemes.
    // Deliberately a SHORT window, not the selected range — a wide one still returns
    // instances a repartition has since destroyed, and the eBPF picker would offer a
    // phantom entity. See 13 §11.2.
    api.query('last_over_time(nvml_gpu_memory_total_bytes{mig_uuid!=""}[5m])')
       .then((r) => setBridge(r.result)).catch(() => setBridge([]));
  }, [tick]);
  useEffect(() => { localStorage.setItem('adv_mon_refresh', String(refresh)); }, [refresh]);
  useEffect(() => {
    if (!refresh) return;
    const t = setInterval(() => setTick((n) => n + 1), refresh * 1000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => { setLastUpdated(new Date()); }, [tick]);

  // The eBPF GPU scope lists cards *and* instances together, because a pod runs on
  // either. Derived from DCGM + the NVML bridge — the same derivation the Device and MIG
  // tabs use — so every entity that exists is offered. gpu_alloc_device_pod_info is NOT
  // the source: it names only devices some pod has already held, so a freshly created
  // instance was invisible until something ran on it. It stays what RESOLVES a selection
  // to pods, below. See 13 §11 and §11.1.
  const allocScope = ebpfScopeOptions(dcgm, bridge);

  // Device selection narrows to the pods that held it; Pod scope narrows further.
  // No device selection means "no device filter", not "no pods".
  const selCards = selDev.filter((v) => v.startsWith('dev:')).map((v) => v.slice(4));
  const selInsts = selDev.filter((v) => v.startsWith('mig:')).map((v) => v.slice(4));
  const scoped = selDev.length
    ? [...new Set([
        ...(selCards.length ? podsForScope(alloc, { kind: 'device', gpuUuid: selCards }) : []),
        ...(selInsts.length ? podsForScope(alloc, { kind: 'mig', migUuid: selInsts }) : []),
      ])].sort()
    : null;
  const capped = scoped !== null && exceedsCap(scoped);
  const intersected = scoped === null || capped
    ? selPods
    : selPods.length ? selPods.filter((p) => scoped.includes(p)) : scoped;
  // A device that resolves to nothing must plot nothing, not everything.
  const effectivePods = scoped !== null && !capped && intersected.length === 0
    ? [NO_PODS] : intersected;
  const missing = isSoftware ? unattributed(pods, alloc) : [];
  const ambiguous = isSoftware ? ambiguousNames(alloc) : [];

  // $gpu stays `.*` on the eBPF tab: the device filter is expressed entirely through
  // $pod, and also constraining gpu_uuid would re-introduce the 3-of-43 problem.
  // A MIG option is one operator-facing choice carrying two identifiers, because DCGM
  // publishes no instance uuid: the card in $gpu and the instance id in $migid. The
  // option's value is the composite of the two and must never be substituted raw.
  // See 12 §2.4.
  const vars: Record<string, string[]> = migScope
    ? migVars(migs, selMig)
    : isSoftware ? { gpu: [], pod: effectivePods }
    : { gpu: sel, pod: selPods };

  if (!cat || !activeDashboard) {
    return <div style={{ padding: '2rem', color: INK.muted }}>Loading…</div>;
  }
  const d = activeDashboard;

  return (
    <AppShell catalog={cat} activeIndex={dash} onSelect={setDash}
              eyebrow={eyebrowFor(d.title)} lastUpdated={lastUpdated}>
      <ContextBanner text={d.description} tone={bannerTone(d.uid)} />

      <ControlBar
        gpuScope={migScope ? (
          <ScopeSelect label="MIG instance" options={migs.map((m) => m.value)}
                       selected={selMig} onChange={setSelMig} allLabel="All instances"
                       labels={Object.fromEntries(migs.map((m) => [m.value, m.label]))} />
        ) : isSoftware ? (
          <div>
            <ScopeSelect label="GPU scope" options={allocScope.map((o) => o.value)}
                         selected={selDev} onChange={setSelDev} allLabel="All GPUs"
                         labels={Object.fromEntries(allocScope.map((o) => [o.value, o.label]))} />
            {/* Each limit is stated, not hidden: attribution is a join across two
                exporters with different lifetimes. See 13 §11.1.2–§11.1.4. */}
            <div style={{ fontSize: '0.7rem', color: INK.muted, marginTop: '0.3rem',
                          maxWidth: 260 }}>
              {capped && <div>Too many pods to filter; showing all.</div>}
              {missing.length > 0 && (
                <div>{missing.length} pods not attributed to a device</div>
              )}
              {ambiguous.length > 0 && (
                <div>{ambiguous.length} pod names exist in more than one namespace;
                     attribution may over-match</div>
              )}
            </div>
          </div>
        ) : (
          <ScopeSelect label="GPU scope" options={devices.map((o) => o.value)}
                       selected={sel} onChange={setSel} allLabel="All GPUs"
                       labels={Object.fromEntries(devices.map((o) => [o.value, o.label]))} />
        )}
        podScope={podVar ? (
          <ScopeSelect label="Pod scope" options={pods} selected={selPods}
                       onChange={setSelPods} allLabel="All pods" />
        ) : undefined}
        range={range} onRangeChange={setRange}
        refresh={refresh} onRefreshChange={setRefresh}
        onRefreshNow={() => { setLastUpdated(new Date()); setTick((n) => n + 1); }} />

      {d.rows.map((row) => (
        <RowSection key={row.title} title={row.title} panelCount={row.panels.length}
                    defaultOpen={!row.collapsed}>
          <PanelGrid panels={row.panels} vars={vars} start={start} end={end} tick={tick}
                     supported={supported} partitioned={partitioned}
                     deviceScope={deviceScope} />
        </RowSection>
      ))}
    </AppShell>
  );
}
