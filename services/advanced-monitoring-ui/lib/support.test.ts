import { describe, it, expect } from 'vitest';
import { extractMetricNames, buildSupportMap } from './support';

describe('extractMetricNames', () => {
  it('extracts a single DCGM metric', () => {
    expect(extractMetricNames('DCGM_FI_DEV_GPU_UTIL{gpu_uuid=~"$gpu"} / 100'))
      .toEqual(['DCGM_FI_DEV_GPU_UTIL']);
  });

  it('extracts an eBPF metric', () => {
    expect(extractMetricNames('ebpf_cuda_kernel_launch_total{gpu_uuid=~"$gpu"}'))
      .toEqual(['ebpf_cuda_kernel_launch_total']);
  });

  it('extracts two different metric names from a ratio expression', () => {
    expect(extractMetricNames('nvml_fb_used_bytes{gpu_uuid=~"$gpu"} / nvml_fb_total_bytes{gpu_uuid=~"$gpu"}'))
      .toEqual(['nvml_fb_used_bytes', 'nvml_fb_total_bytes']);
  });

  it('returns [] for an expression with no PromQL-shaped identifiers', () => {
    expect(extractMetricNames('1 + 1')).toEqual([]);
  });

  it('de-duplicates a metric referenced twice in one expression', () => {
    expect(extractMetricNames('DCGM_FI_DEV_FB_USED{a="1"} - DCGM_FI_DEV_FB_USED{a="2"} offset 5m'))
      .toEqual(['DCGM_FI_DEV_FB_USED']);
  });
});

describe('buildSupportMap', () => {
  it('marks a metric false when every row for it is "0"', () => {
    const map = buildSupportMap([
      { metric: { metric: 'DCGM_FI_PROF_SM_ACTIVE', gpu_uuid: 'a' }, value: [0, '0'] },
      { metric: { metric: 'DCGM_FI_PROF_SM_ACTIVE', gpu_uuid: 'b' }, value: [0, '0'] },
    ]);
    expect(map['DCGM_FI_PROF_SM_ACTIVE']).toBe(false);
  });

  it('marks a metric true when any entity supports it, even mixed with 0s', () => {
    const map = buildSupportMap([
      { metric: { metric: 'DCGM_FI_DEV_GPU_UTIL', gpu_uuid: 'a' }, value: [0, '0'] },
      { metric: { metric: 'DCGM_FI_DEV_GPU_UTIL', gpu_uuid: 'b' }, value: [0, '1'] },
    ]);
    expect(map['DCGM_FI_DEV_GPU_UTIL']).toBe(true);
  });

  it('omits a metric with no rows at all', () => {
    const map = buildSupportMap([
      { metric: { metric: 'DCGM_FI_DEV_GPU_UTIL', gpu_uuid: 'a' }, value: [0, '1'] },
    ]);
    expect('some_metric' in map).toBe(false);
  });

  it('marks a metric true from a single "1" row', () => {
    const map = buildSupportMap([
      { metric: { metric: 'ebpf_cuda_kernel_launch_total', gpu_uuid: 'a' }, value: [0, '1'] },
    ]);
    expect(map['ebpf_cuda_kernel_launch_total']).toBe(true);
  });
});
