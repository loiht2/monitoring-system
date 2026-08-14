import { describe, it, expect } from 'vitest';
import { podsForScope, unattributed, ambiguousNames, exceedsCap } from './correlate';

const alloc = (pod: string, gpu: string, mig = '') => ({
  metric: { pod, namespace: 'default', gpu_uuid: gpu, ...(mig ? { mig_uuid: mig } : {}) },
});

const ROWS = [
  alloc('train-a', 'GPU-a'),
  alloc('train-b', 'GPU-b'),
  alloc('mig-x', 'GPU-b', 'MIG-1'),
  alloc('mig-y', 'GPU-b', 'MIG-2'),
];

describe('podsForScope', () => {
  it('resolves a whole-card selection to its pods', () => {
    expect(podsForScope(ROWS, { kind: 'device', gpuUuid: 'GPU-a' })).toEqual(['train-a']);
  });

  it('includes a card\'s MIG pods when the card itself is selected', () => {
    // A pod on an instance is still running on that physical card.
    expect(podsForScope(ROWS, { kind: 'device', gpuUuid: 'GPU-b' }).sort())
      .toEqual(['mig-x', 'mig-y', 'train-b']);
  });

  it('resolves an instance selection to only that instance\'s pods', () => {
    expect(podsForScope(ROWS, { kind: 'mig', migUuid: 'MIG-1' })).toEqual(['mig-x']);
  });

  it('returns empty rather than everything when nothing matches', () => {
    // Degrading to "all pods" would silently show another GPU's workload as this one's.
    expect(podsForScope(ROWS, { kind: 'mig', migUuid: 'MIG-absent' })).toEqual([]);
  });

  it('returns empty when an instance selection carries no mig_uuid bridge', () => {
    expect(podsForScope(ROWS, { kind: 'mig', migUuid: '' })).toEqual([]);
  });

  it('de-duplicates a pod that appears on several rows', () => {
    expect(podsForScope([alloc('p', 'GPU-a'), alloc('p', 'GPU-a')],
                        { kind: 'device', gpuUuid: 'GPU-a' })).toEqual(['p']);
  });

  it('resolves the union for a multi-select', () => {
    expect(podsForScope(ROWS, { kind: 'device', gpuUuid: ['GPU-a', 'GPU-b'] }).length).toBe(4);
  });
});

describe('unattributed', () => {
  it('names the eBPF pods with no allocation record', () => {
    // Measured: coverage moved from 43/43 to 41/43 within hours, because the two
    // exporters' series have different lifetimes inside the same window. The UI states
    // the gap rather than quietly narrowing.
    expect(unattributed(['train-a', 'gpu-burn-a'], ROWS)).toEqual(['gpu-burn-a']);
  });

  it('is empty when every pod is attributable', () => {
    expect(unattributed(['train-a', 'train-b'], ROWS)).toEqual([]);
  });
});

describe('ambiguousNames', () => {
  it('flags a pod name present in more than one namespace', () => {
    // Substitution filters on k8s_pod_name alone, so a cross-namespace collision would
    // over-match into a namespace that is not on the selected device.
    const rows = [
      { metric: { pod: 'web-0', namespace: 'a', gpu_uuid: 'GPU-a' } },
      { metric: { pod: 'web-0', namespace: 'b', gpu_uuid: 'GPU-b' } },
    ];
    expect(ambiguousNames(rows)).toEqual(['web-0']);
  });

  it('is empty for the current cluster shape', () => {
    expect(ambiguousNames(ROWS)).toEqual([]);
  });
});

describe('podsForScope size cap', () => {
  it('returns a capped flag rather than a truncated regex', () => {
    // A truncated alternation plots a subset while looking complete.
    const many = Array.from({ length: 250 }, (_, i) => alloc(`p-${i}`, 'GPU-a'));
    expect(podsForScope(many, { kind: 'device', gpuUuid: 'GPU-a' }).length).toBe(250);
    expect(exceedsCap(podsForScope(many, { kind: 'device', gpuUuid: 'GPU-a' }))).toBe(true);
    expect(exceedsCap(podsForScope(ROWS, { kind: 'device', gpuUuid: 'GPU-a' }))).toBe(false);
  });
});
