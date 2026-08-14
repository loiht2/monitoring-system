# Metric evaluation report

53 metrics classified over 176 phase windows (0 phases could not run).

| Verdict | Count |
|---|---|
| OBSERVED | 43 |
| UNSUPPORTED | 8 |
| UNVERIFIED | 2 |

UNSUPPORTED is a pass: the system correctly knows it cannot produce the metric.
UNVERIFIED is the defect class — no sample and no support verdict, so a hardware
limit cannot be told from a broken exporter (14 §1).

## Coverage limits

MIG phases ran against 4 instance(s) — GPU_I_ID=1: 28 modes, GPU_I_ID=5: 28 modes, GPU_I_ID=6: 28 modes, GPU_I_ID=unattributed: 28 modes. A single instance cannot distinguish a per-instance metric from one aggregated over the card (14 §4.5); coverage is only as wide as the instances listed here. 120 of 120 MIG phases produced a usable window.

No expected value is asserted anywhere below. The claim is that a metric responds
to a workload built to drive it, not that it reaches a number (14 §5.1).

## Phases that ran and exited non-zero

These have real windows and their samples count. Recorded, not retried.

| Phase | Exit | Note |
|---|---|---|
| gpu0/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| mig/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| gpu0/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| mig/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| gpu0/memcpy-peer | 1 | non-zero by design on this host: peer access is unavailable |
| mig/memcpy-peer | 1 | non-zero by design on this host: peer access is unavailable |
| gpu0/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| mig/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| gpu0/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| mig/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| gpu0/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| mig:1/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| mig:5/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| mig:6/peer-copy | 1 | non-zero by design on this host: peer access is unavailable |
| gpu0/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| mig:1/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| mig:5/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| mig:6/peermem | 1 | non-zero by design on this host: peer access is unavailable |
| mig:1/memcpy-h2d | None | timed out while Running after 330s |
| mig:1/memcpy-peer | 1 | non-zero by design on this host: peer access is unavailable |
| mig:5/memcpy-peer | 1 | non-zero by design on this host: peer access is unavailable |
| mig:6/memcpy-peer | 1 | non-zero by design on this host: peer access is unavailable |

## Verdicts

### DCGM_FI_DEV_FB_FREE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 24164 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 11981 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 5916 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 5926 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 5926 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_DEV_FB_USED — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1782 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 1732 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 1666 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 1656 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 1656 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_DEV_GPU_TEMP — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 52 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 52 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 42 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 52 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 52 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_DEV_GPU_UTIL — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 100 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16

### DCGM_FI_DEV_MEM_CLOCK — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1215 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 1215 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 1215 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 1215 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 1215 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_DEV_POWER_USAGE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 168.619 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 145.742 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 95.245 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 145.742 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 145.742 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_DEV_SM_CLOCK — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1440 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 1440 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 1440 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 1440 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 1440 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_C2C_RX_ALL_BYTES — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_C2C_TX_ALL_BYTES — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_DRAM_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.952757 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.985143 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.994171 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.900397 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.900309 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_GR_ENGINE_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.999802 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.499929 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.999945 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.999939 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.999951 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_HOSTMEM_CACHE_HIT — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_HOSTMEM_CACHE_MISS — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_NVLINK_RX_BYTES — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0 · phases: gpu0/peer-copy, mig/peer-copy, gpu0/hostmem, mig/hostmem, gpu0/peermem, mig/peermem
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_NVLINK_TX_BYTES — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0 · phases: gpu0/peer-copy, mig/peer-copy, gpu0/hostmem, mig/hostmem, gpu0/peermem, mig/peermem
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PCIE_RX_BYTES — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 2.06209e+10 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PCIE_TX_BYTES — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1.69958e+10 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PEERMEM_CACHE_HIT — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PEERMEM_CACHE_MISS — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PIPE_FP16_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.983884 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.487185 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.977747 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.968141 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.965415 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_PIPE_FP32_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.973512 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.487848 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.973538 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.974442 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.973949 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_PIPE_FP64_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.946488 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.477531 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.959332 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.959279 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.959248 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_PIPE_INT_ACTIVE — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PIPE_TENSOR_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.993866 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.497286 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.9889 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.990225 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.98707 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_PIPE_TENSOR_DFMA_ACTIVE — UNSUPPORTED

- `GPU-26e02ca7… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

### DCGM_FI_PROF_PIPE_TENSOR_HMMA_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.919994 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.449352 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.876544 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.883618 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.877224 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_PIPE_TENSOR_IMMA_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_SM_ACTIVE — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.998748 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.499556 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.999725 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.999302 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.999451 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### DCGM_FI_PROF_SM_OCCUPANCY — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 0.984665 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 0.493717 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 0.997777 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 0.997733 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 0.997765 · phases: gpu0/fp32, mig:1/fp32, mig:5/fp32, gpu0/fp64, mig:1/fp64, mig:5/fp64

### ebpf_cuda_device_sync_duration_seconds_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 827212 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 500 · phases: hami/sustained, hami/malloc-free

### ebpf_cuda_errors_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 108298 · phases: gpu0/errors, mig/errors, hami/errors, hami/sustained, hami/malloc-free, mig:1/errors

### ebpf_cuda_event_elapsed_seconds_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 737282 · phases: gpu0/event-elapsed, mig/event-elapsed, gpu0/graph-launch, mig/graph-launch, gpu0/kernel-dims, mig/kernel-dims

### ebpf_cuda_event_sync_duration_seconds_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 821621 · phases: gpu0/event-sync, mig/event-sync, gpu0/event-elapsed, mig/event-elapsed, gpu0/graph-launch, mig/graph-launch

### ebpf_cuda_graph_launch_calls_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 315977 · phases: gpu0/graph-launch, mig/graph-launch, gpu0/kernel-dims, mig/kernel-dims, gpu0/errors, mig/errors

### ebpf_cuda_kernel_block_size_total_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 828962 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 496 · phases: hami/sustained, hami/malloc-free

### ebpf_cuda_kernel_grid_size_total_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 828962 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 496 · phases: hami/sustained, hami/malloc-free

### ebpf_cuda_kernel_launch_calls_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 828962 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 496 · phases: hami/sustained, hami/malloc-free

### ebpf_cuda_kernel_launch_duration_seconds_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 828962 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 496 · phases: hami/sustained, hami/malloc-free

### ebpf_cuda_kernel_shared_memory_bytes_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 828962 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 496 · phases: hami/sustained, hami/malloc-free

### ebpf_cuda_memory_allocations_bytes_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 3.26529e+12 · phases: mig/pcie-h2d, gpu0/pcie-d2h, mig/pcie-d2h, gpu0/peer-copy, mig/peer-copy, gpu0/hostmem
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 3.03021e+12 · phases: gpu0/fp64, mig/fp64, hami/malloc-free

### ebpf_cuda_memory_allocations_calls_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 54843 · phases: mig/pcie-h2d, gpu0/pcie-d2h, mig/pcie-d2h, gpu0/peer-copy, mig/peer-copy, gpu0/hostmem
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 50900 · phases: gpu0/fp64, mig/fp64, hami/malloc-free

### ebpf_cuda_memory_copies_bytes_total_sum — UNVERIFIED

- `(no entity labels)` · **UNVERIFIED** · no sample, no support verdict

### ebpf_cuda_memory_frees_bytes_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 3.26529e+12 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 3.03014e+12 · phases: gpu0/fp64, mig/fp64, hami/sustained, hami/malloc-free

### ebpf_cuda_memory_frees_calls_total — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 54844 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 50900 · phases: gpu0/fp64, mig/fp64, hami/sustained, hami/malloc-free

### ebpf_cuda_memory_memset_bytes_total_sum — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 7.33348e+13 · phases: gpu0/fp16, mig/fp16, gpu0/tensor-hmma, mig/tensor-hmma, gpu0/tensor-imma, gpu0/memset-sync
- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1.51921e+10 · phases: hami/errors, hami/sustained, hami/malloc-free

### ebpf_cuda_memory_peer_copies_bytes_total_sum — UNVERIFIED

- `(no entity labels)` · **UNVERIFIED** · no sample, no support verdict

### ebpf_cuda_stream_sync_duration_seconds_bucket — OBSERVED

- `(no entity labels)` · **OBSERVED** · peak 934895 · phases: gpu0/memset-async, mig/memset-async, gpu0/stream-sync, mig/stream-sync, gpu0/device-sync, mig/device-sync

### ebpf_hami_compute_throttle_duration_seconds_bucket — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 490 · phases: hami/sustained, hami/malloc-free

### ebpf_hami_oom_events_total — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 3.70901e+06 · phases: hami/errors, hami/sustained, hami/malloc-free

### gpu_alloc_device_pod_info — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… (device)` · **OBSERVED** · peak 1 · phases: mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16, mig/tensor-hmma

### nvml_gpu_clocks_event_reason_active — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… (device)` · **OBSERVED** · peak 1 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16

### nvml_process_gpu_memory_bytes — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1.86017e+09 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… GPU_I_ID=1` · **OBSERVED** · peak 1.75532e+09 · phases: mig:1/fp32, mig:1/fp64, mig:5/fp64, mig:5/fp32, mig:1/fp16, mig:5/fp16
- `GPU-a4d27439… GPU_I_ID=3` · **OBSERVED** · peak 1.70289e+09 · phases: mig/fp64, mig/fp32, mig/fp16, mig/tensor-hmma, gpu0/tensor-imma, mig/tensor-imma
- `GPU-a4d27439… GPU_I_ID=5` · **OBSERVED** · peak 1.70289e+09 · phases: mig:5/fp32, mig:5/fp64, mig:6/fp32, mig:5/fp16, mig:6/fp16, mig:5/tensor-hmma
- `GPU-a4d27439… GPU_I_ID=6` · **OBSERVED** · peak 1.70289e+09 · phases: mig:6/fp64, gpu0/fp32, mig:6/fp32, gpu0/fp16, mig:6/fp16, gpu0/tensor-hmma

### nvml_process_sm_utilization_ratio — OBSERVED

- `GPU-26e02ca7… (device)` · **OBSERVED** · peak 1 · phases: gpu0/fp64, mig/fp64, gpu0/fp32, mig/fp32, gpu0/fp16, mig/fp16
- `GPU-a4d27439… (device)` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=1` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=5` · **UNSUPPORTED** · gpu_metric_supported=0
- `GPU-a4d27439… GPU_I_ID=6` · **UNSUPPORTED** · gpu_metric_supported=0

