# Querying

Worked answers to the questions the system exists to answer.

---

## Which pod is using this GPU?

On a whole GPU, per-pod utilization comes straight from NVML:

```promql
sum by (namespace, pod, gpu_uuid) (nvml_process_sm_utilization_ratio)
```

Under MIG, per-process sampling is unavailable — but a MIG instance belongs to exactly one pod, so the
instance's hardware metrics *are* that pod's:

```promql
DCGM_FI_PROF_SM_ACTIVE
  * on(mig_uuid) group_left(namespace, pod) gpu_alloc_device_pod_info{mig_uuid!=""}
```

Because the source differs by GPU mode, a dashboard panel covering both must combine the two rather than pick
one.

## Who is sharing this GPU?

```promql
count by (gpu_uuid) (gpu_alloc_device_pod_info) > 1
```

To see the tenants and what each is consuming:

```promql
sum by (gpu_uuid, namespace, pod) (nvml_process_sm_utilization_ratio)
```

## Is anyone holding a GPU without using it?

Allocation and use are different facts. A pod can hold a GPU with no CUDA context at all — it produces
`gpu_alloc_device_pod_info` and no `nvml_process_*`:

```promql
gpu_alloc_device_pod_info
  unless on(namespace, pod) (sum by (namespace, pod) (nvml_process_gpu_memory_bytes) > 0)
```

For "allocated, has memory, but doing no work", cross-check the kernel launch rate:

```promql
gpu_alloc_device_pod_info
  unless on(namespace, pod) (
    sum by (namespace, pod) (rate(ebpf_cuda_kernel_launch_calls_total[10m])) > 0
  )
```

Three independent idle signals exist — absent NVML process metrics, a flat kernel launch rate, and HAMi's
time-since-last-kernel. Requiring agreement between them is what makes acting on "idle" safe.

## Is this workload actually using the accelerator?

Tensor pipe activity separates a job that is training from a job that is merely busy:

```promql
DCGM_FI_PROF_PIPE_TENSOR_ACTIVE
```

High `PIPE_FP32_ACTIVE` with near-zero tensor activity in a training job usually means mixed precision is not
engaged.

## Is this GPU compute-bound or memory-bound?

```promql
DCGM_FI_PROF_DRAM_ACTIVE / DCGM_FI_PROF_SM_ACTIVE
```

High DRAM activity with low SM activity means the workload is waiting on memory, not compute. A common cause
is an input pipeline that cannot keep up — confirm with transfer volume:

```promql
rate(ebpf_cuda_memory_copies_bytes_total[5m])
```

## Why did this GPU slow down?

Start with the throttle reasons, which name the cause directly — one series per reason, so a non-zero value
identifies the cause without decoding anything:

```promql
nvml_gpu_clocks_event_reason_active == 1
```

If the reasons are clear but a pod is still slow, check whether HAMi is throttling it:

```promql
rate(ebpf_hami_compute_throttle_duration_seconds_sum[5m]) > 0
```

**Throttled but not busy** — HAMi limiting a workload that has not saturated its own share, which usually
means the share is set too low:

```promql
  rate(ebpf_hami_compute_throttle_duration_seconds_sum[5m]) > 0
and on(namespace, pod)
  (sum by (namespace, pod) (nvml_process_sm_utilization_ratio) < 0.5)
```

## Is this pod stalled?

A GPU workload that has stopped launching kernels while still holding its allocation:

```promql
sum by (namespace, pod) (rate(ebpf_cuda_kernel_launch_calls_total[5m])) == 0
```

Then check whether it is blocked waiting rather than dead:

```promql
rate(ebpf_cuda_stream_sync_duration_seconds_sum[5m])
```

## Is a workload leaking GPU memory?

Allocation persistently outrunning frees:

```promql
  rate(ebpf_cuda_memory_allocations_bytes_total[30m])
- rate(ebpf_cuda_memory_frees_bytes_total[30m])
```

## Is HAMi enforcing the limit it thinks it is?

HAMi reports what it counted; NVML reports what the driver sees. A non-zero difference is memory on the card
that HAMi is not counting toward the pod's quota:

```promql
nvml_gpu_memory_used_bytes - on(gpu_uuid) sum by (gpu_uuid) (hami_vgpu_memory_used_bytes)
```

The same check for utilization:

```promql
  hami_container_device_utilization_ratio
- on(namespace, pod) sum by (namespace, pod) (nvml_process_sm_utilization_ratio)
```

These two metrics overlapping is deliberate. They come from different places and are expected to differ
slightly; a *large* divergence means HAMi is making throttling decisions on a number that does not match the
hardware.

---

## Writing dashboard panels

Three rules that prevent the common failures:

1. **Ratios are 0-1.** Format as a percentage in the panel, not in the query.
2. **A join against a metric that may be absent must not delete the un-joined series.** Written naively, a
   `group_left` join drops everything when the joined metric is missing. Write it so unmatched series survive:
   `(<expr> * on(namespace,pod) group_left(<labels>) <join metric>) or <expr>`
3. **Do not build panels on metrics that exist only on some hardware** unless the panel is scoped to it. An
   empty panel is indistinguishable from a broken one.
