interface AllocRow { metric: Record<string, string> }
export type Scope =
  | { kind: 'device'; gpuUuid: string | string[] }
  | { kind: 'mig'; migUuid: string | string[] };

/** The workload pods that held a given device in this window.
 *
 *  The eBPF exporter labels only ~3 of 43 pods with a gpu_uuid and emits no MIG
 *  identifier at all, so filtering its own series on device would hide most of the data.
 *  `gpu_alloc_device_pod_info` knows what every pod was actually granted, including
 *  mig_uuid, and resolves 43/43. See 13 §11.1.
 *
 *  Selecting a whole card includes pods on its MIG instances: an instance is part of the
 *  card. Selecting an instance does not include the card's other pods.
 *
 *  An unmatched selection yields an EMPTY list, never every pod — degrading to "all"
 *  would present one GPU's workload as another's. */
export function podsForScope(rows: AllocRow[], scope: Scope): string[] {
  const raw = scope.kind === 'device' ? scope.gpuUuid : scope.migUuid;
  const wanted = new Set((Array.isArray(raw) ? raw : [raw]).filter(Boolean));
  if (wanted.size === 0) return [];

  const out = new Set<string>();
  for (const r of rows) {
    const key = scope.kind === 'device' ? r.metric.gpu_uuid : r.metric.mig_uuid;
    if (key && wanted.has(key) && r.metric.pod) out.add(r.metric.pod);
  }
  return [...out].sort();
}

/** eBPF pods that no allocation record covers in this window. Coverage is high but not
 *  guaranteed — measured 41/43 a few hours after measuring 43/43, because the two
 *  exporters' series have different lifetimes. The UI reports this count next to the
 *  control instead of silently narrowing. See 13 §11.1.2. */
export function unattributed(ebpfPods: string[], rows: AllocRow[]): string[] {
  const known = new Set(rows.map((r) => r.metric.pod).filter(Boolean));
  return ebpfPods.filter((p) => !known.has(p)).sort();
}

/** Pod names that occur in more than one namespace in this window. Substitution filters
 *  on k8s_pod_name alone, so such a name would over-match into a namespace that is not on
 *  the selected device. None exist on this cluster today (67 pairs / 67 names); this
 *  detects the case rather than assuming it away. See 13 §11.1.3. */
export function ambiguousNames(rows: AllocRow[]): string[] {
  const ns = new Map<string, Set<string>>();
  for (const r of rows) {
    const { pod, namespace } = r.metric;
    if (!pod) continue;
    (ns.get(pod) ?? ns.set(pod, new Set()).get(pod)!).add(namespace ?? '');
  }
  return [...ns.entries()].filter(([, s]) => s.size > 1).map(([p]) => p).sort();
}

/** Above this many pods the alternation approaches practical URL limits (measured: 40
 *  pods = 1030 chars). The caller then applies NO device filter and says so — a
 *  truncated regex would plot a subset while looking complete. See 13 §11.1.4. */
export const POD_FILTER_CAP = 200;
export function exceedsCap(pods: string[]): boolean {
  return pods.length > POD_FILTER_CAP;
}
