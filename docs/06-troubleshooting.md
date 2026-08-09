# Troubleshooting

Each of these failures produces a **healthy-looking deployment**: pods running, endpoints serving, no errors in
the logs. Symptom first.

---

## No metrics in Prometheus at all

**Check the Prometheus Operator controller is running**, not just its CRDs. CRDs are frequently installed by
another chart without the controller. In that state a `ServiceMonitor` applies successfully, appears in
`kubectl get servicemonitor`, and is never scraped.

If the controller is running, check the target list in the Prometheus UI. A `ServiceMonitor` whose selector
matches no service produces no target and no error.

## Per-pod metrics are empty, device metrics are fine

`nvml_process_*` empty while `nvml_gpu_*` works, with a GPU workload running.

**Almost always a missing `hostPID: true` on the NVML exporter.** Without it the exporter sees a private
process namespace, every process lookup misses, and it emits device metrics normally while silently producing
nothing per pod.

If `hostPID` is set, check next:

| Cause | Check |
|---|---|
| GPU is in MIG mode | Per-process utilization is unavailable under MIG by design. `nvml_process_gpu_memory_bytes` should still be present |
| Pods appear with empty `namespace`/`pod` labels | The cgroup path format was not recognized. The measurement is still emitted, just unattributed |
| The workload has no live CUDA context | A pod that holds a GPU but never initializes CUDA correctly produces no process metrics. Confirm with `gpu_alloc_device_pod_info` |

## No CUDA metrics, eBPF exporter healthy

`ebpf_cuda_*` absent while the agent is running and its endpoint serves other metrics. Four causes, in order of
likelihood:

1. **GPU instrumentation not enabled in the export configuration.** The agent serves its framework's own
   metrics regardless, so the endpoint looks fine.
2. **Discovery does not match the workload.** The agent must be told which containers to instrument; a default
   matching nothing produces silence.
3. **The workload links a CUDA library the probes did not attach to.** Probes attach to a resolved library path
   inside the container.
4. **The workload never called those functions.** Some probes are optional by design — an absent family can
   legitimately mean "this workload does no peer copies".

## CUDA metrics appear and disappear

Series present, then gone, then back. Counters look like they reset and `rate()` over long windows breaks.

The agent expires a series after a period of inactivity. Continuous training is unaffected; bursty or
interactive workloads hit this. Keep the scrape interval well below the expiry, and prefer short windows with
explicit handling for absent series in dashboards.

## A metric is missing entirely for some GPUs

Expected. A metric the hardware cannot supply is **not emitted**, rather than emitted as zero — a zero would be
indistinguishable from a real measurement. Check the hardware requirement in
[05 — Limitations](05-limitations.md).

## A panel shows "No data" after adding a join

A `group_left` join against a metric that is absent removes **every** series, not just the unmatched ones.
Write joins so un-joined series survive:

```promql
(<expr> * on(namespace,pod) group_left(<labels>) <join metric>) or <expr>
```

## Cluster GPU memory reads about double

A second DCGM exporter is running. Two exporters on the same GPUs emit two series per metric name, and any
consumer that sums across series double-counts.

Consumers that read *the first* returned series are worse: which series is first is non-deterministic, so a
query filtered to a busy pod can return the other exporter's idle series. Run exactly one DCGM exporter and
extend its field list through configuration.

## An alert or a division stopped producing results

An expression that divides one metric by another **without an explicit `on()` clause** matches on the complete
label set. If the two metrics' labels diverge, the result is an empty vector — Prometheus does not error, the
expression simply returns nothing.

This system only ever *adds* labels and never renames or removes one, so it should not be the cause. If it
appears after a change here, compare the label sets of the two metrics involved.

## Grafana lost a datasource, or a dashboard reverted

Where several components provision Grafana, two things collide: provisioning scripts can delete datasources
they do not recognize, and two components writing dashboard ConfigMaps with the same name or UID will
overwrite each other on every reconcile. Use distinct names and never reuse an existing dashboard's UID.

## Prometheus is being OOM-killed

Almost certainly the eBPF exporter's cardinality. It produces roughly an order of magnitude more series than
every other source combined.

Reduce **label dimensions** rather than removing metric families — aggregating over CUDA function name, for
example, keeps the capability while cutting series count sharply. Then re-measure: sizing estimates made before
the eBPF exporter was running do not hold afterwards.
