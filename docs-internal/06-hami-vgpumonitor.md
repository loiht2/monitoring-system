# 06 — HAMi vGPUmonitor integration

**Deliverable: a ServiceMonitor with deduplication rules. We do not deploy, build or modify this component.**

---

## 1. What it is

A **sidecar container inside HAMi's device-plugin DaemonSet**, exposed through its own service. It is
**unconditional** in the chart template — only image, arguments and security context are configurable, so any
design assuming it can be switched off to avoid overlap is wrong.

Its availability follows the allocation mechanism, not the hardware:

| Environment | Present? |
|---|---|
| HAMi classic device-plugin | **Yes**, always |
| HAMi via DRA | **No** — the DRA driver is a separate component shipping no monitor |
| No HAMi | No |

Because it exists in only some environments, it cannot be a dependency of any shared dashboard panel (§5).

---

## 2. Its two data sources

| Metric group | Source | Nature |
|---|---|---|
| `hami_host_gpu_*` | **NVML directly** | Exactly the API calls our NVML exporter already makes |
| `hami_vgpu_*`, `hami_container_*`, `hami_mig_device_info` | **The interception library's shared memory region**, mapped per container | HAMi's own accounting — the number the limit is enforced against |

The second group is unobtainable anywhere else. NVML reports what the driver sees; the shared region reports
what the library counted. Different facts about the same container.

---

## 3. Deduplication

`hami_*` collides with no name we emit, so the hard invariant holds untouched. The problem is **semantic**: two
differently named metrics that are the same number, leaving no rule for which to believe.

**Dropped at scrape** — these can differ only by scrape skew:

```yaml
metricRelabelConfigs:
  - sourceLabels: [__name__]
    regex: 'hami_host_gpu_(memory_used_bytes|utilization_ratio)'
    action: drop
```

**Legacy metric names must stay disabled.** The upstream chart has a flag — off by default — that emits a
second copy of everything under legacy names. That is duplication *within* HAMi, independent of anything we
do. Assert the flag's value rather than assume it; a change to it is a breaking change for our dashboards.

**Label normalization:** `device_uuid` is copied to `gpu_uuid` and retained, per
[01 § 3.2](01-architecture.md).

---

## 4. What is kept, and why the overlap is deliberate

Everything else is kept — see [02 § 6](02-metric-catalog.md) for the list and the reason each is unobtainable
elsewhere.

Two of them overlap *conceptually* with NVML per-process metrics. That overlap is kept **on purpose**, because
the divergence is the diagnostic:

```promql
# memory the device holds that HAMi is not counting toward the limit
nvml_gpu_memory_used_bytes - on(gpu_uuid) sum by (gpu_uuid) (hami_vgpu_memory_used_bytes)

# HAMi's utilization accounting versus the driver's, per pod
  hami_container_device_utilization_ratio
- on(namespace, pod) sum by (namespace, pod) (nvml_process_sm_utilization_ratio)
```

A non-zero result means HAMi is enforcing against a number that does not match reality. Deduplicating these
would delete the only way to detect it.

The same logic gives three independent views of HAMi that fail differently — the library's self-report
(vGPUmonitor), the delay and refusals actually imposed (eBPF), and what the driver reports (NVML). Any two
agreeing while the third dissents localizes the fault immediately.

---

## 5. Portability requirements

1. **No shared dashboard panel may depend on `hami_*`.** Panels using it are environment-scoped, or written so
   an absent series degrades to empty rather than breaking the panel.
2. **No exporter of ours changes behaviour based on its presence.** The `nvml_*`, `DCGM_FI_*`, `ebpf_*` and
   `gpu_alloc_*` surface is identical everywhere, so panels built on them port without edit.
3. Deploy this ServiceMonitor only where the target exists.
