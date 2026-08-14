import { describe, it, expect } from 'vitest';
import { unsupportedTargets, emptyState } from './panelSupport';

const TARGETS = [
  { expr: 'DCGM_FI_PROF_PIPE_FP64_ACTIVE{gpu_uuid=~"$gpu"}', legendFormat: '{{node}} · FP64' },
  { expr: 'DCGM_FI_PROF_PIPE_INT_ACTIVE{gpu_uuid=~"$gpu"}', legendFormat: '{{node}} · integer' },
];

describe('unsupportedTargets', () => {
  it('names a target whose metric is known unsupported', () => {
    const r = unsupportedTargets(TARGETS, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false });
    expect(r).toEqual(['integer']);
  });

  it('says nothing when support is merely unknown', () => {
    // Absent is Unverified, not Unsupported. Claiming "not supported" without a verdict
    // is the fabrication 10 §1 forbids.
    expect(unsupportedTargets(TARGETS, {})).toEqual([]);
  });

  it('says nothing when the metric is supported', () => {
    expect(unsupportedTargets(TARGETS, { DCGM_FI_PROF_PIPE_INT_ACTIVE: true })).toEqual([]);
  });

  it('uses the legend suffix after the separator, not the whole format string', () => {
    // "{{node}} gpu{{gpu}} · integer" -> "integer": the template vars cannot be resolved
    // without a series, and the suffix is the part that names the pipe.
    const t = [{ expr: 'DCGM_FI_PROF_PIPE_INT_ACTIVE', legendFormat: '{{node}} gpu{{gpu}} · integer' }];
    expect(unsupportedTargets(t, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false })).toEqual(['integer']);
  });

  it('falls back to the metric name when there is no legend format', () => {
    const t = [{ expr: 'DCGM_FI_PROF_PIPE_INT_ACTIVE', legendFormat: '' }];
    expect(unsupportedTargets(t, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false }))
      .toEqual(['DCGM_FI_PROF_PIPE_INT_ACTIVE']);
  });

  it('reports each unsupported target once even if it appears twice', () => {
    const t = [...TARGETS, TARGETS[1]];
    expect(unsupportedTargets(t, { DCGM_FI_PROF_PIPE_INT_ACTIVE: false })).toEqual(['integer']);
  });
});

describe('emptyState', () => {
  const partitioned = new Set(['GPU-mig-card']);

  it('reports a device-scope panel on a partitioned card as partitioned', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-mig-card'], partitioned,
                        allUnsupported: false })).toBe('partitioned');
  });

  it('does not claim partitioned when any selected card is whole', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-mig-card', 'GPU-whole'],
                        partitioned, allUnsupported: false })).toBe('nodata');
  });

  it('does not claim partitioned for a MIG-scope panel', () => {
    // The MIG tab's panels are exactly the ones that DO report on a partitioned card.
    expect(emptyState({ deviceScope: false, selected: ['GPU-mig-card'], partitioned,
                        allUnsupported: false })).toBe('nodata');
  });

  it('prefers partitioned over unsupported, being the more precise statement', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-mig-card'], partitioned,
                        allUnsupported: true })).toBe('partitioned');
  });

  it('falls back to unsupported, then nodata', () => {
    expect(emptyState({ deviceScope: true, selected: ['GPU-whole'], partitioned,
                        allUnsupported: true })).toBe('unsupported');
    expect(emptyState({ deviceScope: true, selected: ['GPU-whole'], partitioned,
                        allUnsupported: false })).toBe('nodata');
  });

  it('treats an empty selection as not-all-partitioned', () => {
    // "All GPUs" includes whole cards; claiming partitioned would be wrong.
    expect(emptyState({ deviceScope: true, selected: [], partitioned,
                        allUnsupported: false })).toBe('nodata');
  });
});
