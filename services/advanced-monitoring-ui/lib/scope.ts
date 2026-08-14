interface Series { metric: Record<string, string> }
export interface DeviceOption { value: string; label: string }
export interface MigOption { value: string; label: string; gpuUuid: string; migId: string }

/** The physical cards. Derived from DCGM rather than a bare label_values(gpu_uuid),
 *  because HAMi's dra-monitor also writes gpu_uuid and sets it to a MIG *instance* uuid
 *  for a MIG-backed claim — so the union of the two offers an entity the Device tab
 *  cannot plot. See 12 §2.3. On any DCGM series gpu_uuid is the parent card, so instance
 *  rows collapse onto their card.
 *
 *  Derived across ALL DCGM series, not just the device-scope rows: a fully partitioned
 *  card publishes no device row at all, so filtering GPU_I_ID="" would drop it. */
export function deviceOptions(series: Series[]): DeviceOption[] {
  const byUuid = new Map<string, string>();
  for (const s of series) {
    const uuid = s.metric.gpu_uuid;
    if (!uuid) continue;
    if (!byUuid.has(uuid)) byUuid.set(uuid, s.metric.gpu ?? '?');
  }
  return [...byUuid.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))
    .map(([uuid, gpu]) => ({ value: uuid, label: `GPU ${gpu} · ${uuid.slice(0, 8)}` }));
}

/** The MIG instances. DCGM publishes no instance uuid, so an instance is
 *  (gpu_uuid, GPU_I_ID) and the option carries both — one operator-facing choice, two
 *  template variables. See 12 §2.4. */
export function migOptions(series: Series[]): MigOption[] {
  const seen = new Map<string, MigOption>();
  for (const s of series) {
    const { gpu_uuid: gpuUuid, GPU_I_ID: migId, GPU_I_PROFILE: profile, gpu } = s.metric;
    if (!gpuUuid || !migId) continue;
    const key = `${gpuUuid}/${migId}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      value: key, gpuUuid, migId,
      label: `GPU ${gpu ?? '?'} · ${profile ?? 'unknown'} · id ${migId}`,
    });
  }
  return [...seen.values()].sort((a, b) =>
    a.gpuUuid.localeCompare(b.gpuUuid) ||
    Number(a.migId) - Number(b.migId));
}

/** The template variables one MIG selection sets. An option's `value` is the composite
 *  `gpuUuid/migId`, because a picker offers one thing; the panels filter on the two parts
 *  separately, so the composite must be split here. Substituting it raw into
 *  `GPU_I_ID=~"$migid"` matches nothing, and the card filter alone then draws every
 *  instance on the card — the selection appears to do nothing. See 12 §2.4. */
export function migVars(options: MigOption[], selected: string[]): Record<string, string[]> {
  const chosen = options.filter((m) => selected.includes(m.value));
  return { gpu: chosen.map((m) => m.gpuUuid), migid: chosen.map((m) => m.migId) };
}

/** The eBPF tab's GPU scope: the cards AND the instances, kind-prefixed so one control
 *  offers both. See 13 §11.
 *
 *  Derived from DCGM plus the NVML bridge, the same derivation the Device and MIG tabs
 *  use — NOT from gpu_alloc_device_pod_info. That map only names devices some pod has
 *  already been granted, so a freshly created instance was simply absent from the picker.
 *  Allocation rows stay what RESOLVES a selection to pods; an entity with no pods in the
 *  window is still selectable and resolves to zero. See 13 §11.1.2.
 *
 *  `bridge` is the NVML series carrying mig_uuid and GPU_I_ID together — the only place
 *  the two naming schemes meet. Query it over a SHORT window: a wide one still returns
 *  instances the card no longer has, which would offer a phantom entity. An instance the
 *  bridge cannot name keeps a distinct, unresolvable value, so eBPF correlation degrades
 *  to "no pods", never to "all pods". See 13 §11.2. */
export function ebpfScopeOptions(dcgm: Series[], bridge: Series[]): DeviceOption[] {
  const migUuid = new Map<string, string>();
  for (const s of bridge) {
    const { gpu_uuid: u, GPU_I_ID: id, mig_uuid: mig } = s.metric;
    if (u && id && mig) migUuid.set(`${u}/${id}`, mig);
  }
  return [
    ...deviceOptions(dcgm).map((o) => ({ value: `dev:${o.value}`, label: o.label })),
    ...migOptions(dcgm).map((o) => ({
      value: `mig:${migUuid.get(o.value) ?? `unresolved:${o.value}`}`,
      label: o.label,
    })),
  ];
}
