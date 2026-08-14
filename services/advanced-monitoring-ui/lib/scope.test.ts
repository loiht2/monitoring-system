import { describe, it, expect } from 'vitest';
import { deviceOptions, migOptions, migVars, ebpfScopeOptions } from './scope';
import { substituteVars } from './promql';

// Shape returned by /query for DCGM_FI_DEV_FB_USED.
const series = (m: Record<string, string>) => ({ metric: m, value: [0, '1'] as [number, string] });

describe('deviceOptions', () => {
  it('lists each physical card once, partitioned or not', () => {
    // gpu_uuid on a DCGM series is always the PARENT card, so instance rows collapse
    // onto their card rather than adding an entry.
    const r = deviceOptions([
      series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '4' }),
    ]);
    expect(r.map((o) => o.value)).toEqual(['GPU-a', 'GPU-b']);
  });

  it('never offers a MIG instance uuid', () => {
    // HAMi's dra-monitor puts MIG-… in gpu_uuid; DCGM never does. Sourcing from DCGM
    // is what keeps it out — see 12 §2.3.
    const r = deviceOptions([series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' })]);
    expect(r.some((o) => o.value.startsWith('MIG-'))).toBe(false);
  });

  it('labels a card by its index and short uuid', () => {
    expect(deviceOptions([series({ gpu_uuid: 'GPU-abcdefgh', gpu: '0', GPU_I_ID: '' })])[0].label)
      .toBe('GPU 0 · GPU-abcd');
  });
});

describe('migOptions', () => {
  it('lists one entry per instance with its profile', () => {
    const r = migOptions([
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3', GPU_I_PROFILE: '1g.6gb' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '4', GPU_I_PROFILE: '2g.12gb' }),
    ]);
    expect(r.map((o) => o.label)).toEqual(['GPU 1 · 1g.6gb · id 3', 'GPU 1 · 2g.12gb · id 4']);
  });

  it('carries both identifiers, since DCGM publishes no instance uuid', () => {
    const r = migOptions([series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3', GPU_I_PROFILE: '1g.6gb' })]);
    expect(r[0]).toMatchObject({ gpuUuid: 'GPU-b', migId: '3' });
  });

  it('never offers a whole card', () => {
    const r = migOptions([series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' })]);
    expect(r).toEqual([]);
  });

  it('sorts by card then instance id, not by arrival order', () => {
    const r = migOptions([
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '11', GPU_I_PROFILE: '1g.6gb' }),
      series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '3', GPU_I_PROFILE: '1g.6gb' }),
    ]);
    expect(r.map((o) => o.migId)).toEqual(['3', '11']);
  });
});

describe('migVars', () => {
  const opts = migOptions([
    series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '5', GPU_I_PROFILE: '1g.6gb' }),
    series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '6', GPU_I_PROFILE: '1g.6gb' }),
  ]);

  it('puts the BARE GPU_I_ID under migid, never the composite option value', () => {
    // The option value is `gpuUuid/migId` so one control can carry both identifiers.
    // Substituting that composite into GPU_I_ID=~"$migid" matches no instance, and the
    // panels silently fall back to every instance on the card.
    const v = migVars(opts, ['GPU-b/5']);
    expect(v.migid).toEqual(['5']);
    expect(v.gpu).toEqual(['GPU-b']);
  });

  it('substitutes a real MIG expression down to the single instance', () => {
    const out = substituteVars(
      'DCGM_FI_PROF_SM_ACTIVE{gpu_uuid=~"$gpu", GPU_I_ID=~"$migid", GPU_I_ID!=""}',
      migVars(opts, ['GPU-b/5']),
      { rangeSeconds: 3600, step: 18, scrapeInterval: 30 });
    expect(out).toContain('GPU_I_ID=~"5"');
    expect(out).not.toContain('GPU_I_ID=~".*"');
    expect(out).not.toContain('GPU-b/5');
  });

  it('carries every selected instance, and only those', () => {
    expect(migVars(opts, ['GPU-b/5', 'GPU-b/6']).migid).toEqual(['5', '6']);
  });

  it('an empty selection means all instances', () => {
    expect(migVars(opts, [])).toEqual({ gpu: [], migid: [] });
  });
});

describe('ebpfScopeOptions', () => {
  // Cards and instances together: a pod runs on either and the correlation is identical.
  // Derived from DCGM + the NVML bridge, NOT from gpu_alloc_device_pod_info — a freshly
  // created instance that no pod has used yet has no allocation row, and was invisible.
  const dcgm = [
    series({ gpu_uuid: 'GPU-a', gpu: '0', GPU_I_ID: '' }),
    series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '5', GPU_I_PROFILE: '1g.6gb' }),
    series({ gpu_uuid: 'GPU-b', gpu: '1', GPU_I_ID: '6', GPU_I_PROFILE: '1g.6gb' }),
  ];
  const bridge = [
    series({ gpu_uuid: 'GPU-b', GPU_I_ID: '5', mig_uuid: 'MIG-5' }),
    series({ gpu_uuid: 'GPU-b', GPU_I_ID: '6', mig_uuid: 'MIG-6' }),
  ];

  it('offers every card and every instance, with no allocation rows at all', () => {
    expect(ebpfScopeOptions(dcgm, bridge).map((o) => o.value))
      .toEqual(['dev:GPU-a', 'dev:GPU-b', 'mig:MIG-5', 'mig:MIG-6']);
  });

  it('lists a card DCGM reports no device entity for', () => {
    // GPU 1 is fully partitioned, so it publishes no GPU_I_ID="" row. deviceOptions
    // derives across all series, which is why it is still offered.
    expect(ebpfScopeOptions(dcgm, bridge).some((o) => o.value === 'dev:GPU-b')).toBe(true);
  });

  it('labels an instance the way the MIG picker does', () => {
    const o = ebpfScopeOptions(dcgm, bridge).find((x) => x.value === 'mig:MIG-5');
    expect(o!.label).toBe('GPU 1 · 1g.6gb · id 5');
  });

  it('still offers an instance the bridge cannot name, with an unresolvable value', () => {
    // Degrades to "no pods resolved", never to "all pods". See 13 §11.2.
    const o = ebpfScopeOptions(dcgm, []).filter((x) => x.value.startsWith('mig:'));
    expect(o).toHaveLength(2);
    expect(new Set(o.map((x) => x.value)).size).toBe(2);
    expect(o.some((x) => x.value === 'mig:')).toBe(false);
  });
});
