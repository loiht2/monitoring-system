# 07 — Backend and deployment

## 1. Repository layout

```
monitoring-system/
  README.md                   project front page
  docs/                       user documentation
  docs-internal/              design specification
  exporters/
    nvml/
      Dockerfile              multi-stage; static binary on a distroless base
      go.mod  go.sum
      cmd/exporter/           entrypoint
      internal/               collectors, cgroup resolver, pod cache — see 04 § 2
      internal/*_test.go      fixture-driven; no GPU or cluster required
    ebpf/
      eBPF-Lens/              git submodule (which tracks the core as its own)
      README.md               build recipe; the refs are the submodule pointers
  deploy/
    <environment-a>/          numbered YAML, dependency order
    <environment-b>/          same shape
  dashboards/                 Grafana JSON, shared
  .github/workflows/          image build and publish
```

One directory per environment (D-5). Duplication is deliberate: the files are short, the differences are
load-bearing, and a reader sees an environment's entire state without resolving an overlay. Environment-specific
content is limited to image references, namespaces, node selectors and storage.

| Range | Contents |
|---|---|
| `00-` | Namespace |
| `10-` | RBAC |
| `20-` | Backend — operator, Prometheus, Grafana, storage |
| `30-` | DCGM configuration |
| `40-` | Exporter DaemonSets and Services |
| `50-` | ServiceMonitors |
| `60-` | Dashboards |

`kubectl apply -f <environment>/` in lexical order must produce a working stack from an empty namespace.

---

## 2. Images

Two images: the NVML exporter and the eBPF agent. **The DCGM exporter is never built** — configuration only.
Both are built in CI and published to GHCR (D-8), referenced by digest, so the image reference is not an
environment-specific value.

- Tag by commit; never reference a mutable tag from a manifest.
- CI checks out with `--recurse-submodules`; the eBPF image's provenance is the submodule pointer pair, so no
  ref needs recording by hand ([05 § 1](05-exporter-ebpf.md)).
- The NVML image must contain the NVML Python binding pinned compatible with the fleet's driver (ABI-coupled,
  [04 § 1.1](04-exporter-nvml.md)) and carry the vendored `LICENSE`/`NOTICE`.

---

## 3. Prometheus

### 3.1 The operator is a dependency, not an assumption

Prometheus Operator CRDs are frequently present **without the controller that reconciles them**. In that state
a `ServiceMonitor` applies cleanly and is never scraped, and a `Prometheus` object is created and never
instantiated. **A successful `kubectl apply` is not evidence of collection** — verify the controller is
running, and make "targets appear in the Prometheus UI" the phase exit criterion.

### 3.2 Configuration

| Setting | Value | Rationale |
|---|---|---|
| Scrape interval | 15s | Matches the platform's convention, so rules and dashboards port unchanged |
| Retention | time-based primary, size-based backstop | Time binds at these volumes; size guards against a cardinality surprise |
| `serviceMonitorSelector` | Selects our label explicitly | Prevents unrelated ServiceMonitors joining the target set |

Discovery uses `ServiceMonitor` objects rather than raw scrape configuration, so scrape definitions port to an
environment already running a Prometheus Operator stack.

### 3.3 Storage and sizing

Prometheus's local storage relies on `mmap` and POSIX locking. **Network filesystems do not provide these
reliably**, and the failure is silent WAL or block corruption after a restart, not a clean error.

1. **Never place the TSDB on a network-filesystem StorageClass**, even the cluster default.
2. Prefer a static `local` PersistentVolume with `volumeBindingMode: WaitForFirstConsumer` — about twenty lines
   of YAML, no controller to install.
3. Check `allowVolumeExpansion` before committing; where `false`, size is a one-way door.
4. Check the reclaim policy; `Delete` with no archive destroys data with the claim.
5. `emptyDir` is acceptable during early build-out, and must be replaced before anyone relies on history.

Series estimates, in the only ratio that matters:

| Source | Order of magnitude |
|---|---|
| DCGM, NVML device, `gpu_alloc` | tens |
| NVML per-pod, vGPUmonitor | low hundreds |
| **eBPF** | **thousands** |

Sizing done before the eBPF agent is deployed is meaningless, which is why it is deployed last. Memory
**requests** must reflect expected usage, not the schedulable minimum: on a node whose request accounting sits
below actual usage, an under-requested Prometheus is admitted and then contends for memory that was never free.

---

## 4. Grafana

Deployed alongside Prometheus with a provisioned datasource and dashboards from ConfigMaps. Where an
environment already runs Grafana, two hazards apply ([09 — R-4](09-risks-and-open-questions.md)):
provisioning scripts can delete datasources they do not recognize, and dashboard ConfigMaps can have several
writers, so a name or UID collision means one silently overwrites another on every reconcile.

### 4.1 Dashboard rules

1. **No panel depends on a source absent in some environment.** Panels using `hami_*` or a pod-metadata join
   are environment-scoped or degrade to empty.
2. **A join that can be absent must not drop un-joined series.** A naive `group_left` against an absent metric
   removes every series; write it as `(<expr> * on(...) group_left(...) <join>) or <expr>`.
3. **"Per-pod GPU busy" is a fallback chain**, since the authoritative source differs between whole-device and
   MIG modes ([01 § 4](01-architecture.md)).
4. **Ratios are 0-1**; percentage formatting is the panel's job.

---

## 5. RBAC

| Component | Permissions |
|---|---|
| NVML exporter | `get`/`list`/`watch` on pods (field-selected to its node), `resourceclaims`, `resourceslices` |
| eBPF agent | As required upstream for pod discovery |
| Prometheus | Standard operator-managed discovery |

**No component in this system has write access to any Kubernetes object.**
