# 15 — Image publishing

The manifests in `deploy/` carry `REPLACE_ME` image tokens and an `imagePullSecrets` reference to a private
Harbor. Nobody outside this cluster can deploy the stack. This document specifies publishing the images this
repository builds to GHCR as **public** packages, so a deployment needs no registry credential.

---

## 1. Scope

| Image | Built from | Workflow today |
|---|---|---|
| `nvml-exporter` | `exporters/nvml` | [build-nvml-exporter.yml](../.github/workflows/build-nvml-exporter.yml) |
| `ebpf-gpu-exporter` | `exporters/ebpf/eBPF-Lens` (submodule) | [build-ebpf-exporter.yml](../.github/workflows/build-ebpf-exporter.yml) |
| `advanced-monitoring-api` | `services/advanced-monitoring-api` | **none** |
| `advanced-monitoring-ui` | `services/advanced-monitoring-ui` | **none** |

**Deferred: `pipe-exerciser` and `api-exerciser`.** They are evaluation fixtures for [14](14-metric-evaluation.md),
not components of a deployment. Consequence: `run.sh`'s claim that CI publishes them stays false, and whoever
runs the harness builds and pushes them by hand, overriding `REGISTRY`.

**Not ours.** `grafana` and `prometheus-operator` come from public upstreams. `ghcr.io/loiht2/gpu-burn` has no
Dockerfile in this repository — it is built elsewhere, and its package visibility must be checked by hand.

---

## 2. GHCR only

`GITHUB_TOKEN` already authenticates against GHCR, so publishing costs no new secret and no new login step —
both existing workflows already do exactly this. Docker Hub would add two organisation secrets and a second
push per image, for reach this project does not need.

---

## 3. Tags

| Tag | Emitted on | Consumer |
|---|---|---|
| `:<sha>` | every build | a build-exact reference |
| `:latest` | push to `main` | someone trying the stack |
| `:vX.Y.Z` | a manual `workflow_dispatch` with a `release_tag` input | `deploy/` manifests |

**A manifest must never reference a mutable tag** — `build-nvml-exporter.yml` already records this, and
`:latest` never enters `deploy/`. What the manifests pin is the release tag, currently `:v1.0.0`.

The release tag is cut **on demand**, not by pushing a `v*` git tag: GitHub applies a workflow's `paths`
filter to tag pushes as well as branch pushes, so a `tags: ["v*"]` trigger sitting alongside the existing
`paths` filter would simply never fire. Each workflow therefore takes a free-text `release_tag`
`workflow_dispatch` input, empty on push events, which disables the tag line.

The cost of that choice: a free-text `release_tag` is immutable **by convention only** — a second dispatch
with the same value moves it. A digest or the commit sha remains the stronger pin if that ever matters.

---

## 4. Workflow changes

**New `.github/workflows/build-services.yml`** — a matrix over the two service contexts. One file rather than
two, because the contexts differ only by directory and image name.

**All three workflows gain `docker/metadata-action`** for the tag set above, plus the
`org.opencontainers.image.source` label. That label is what links a GHCR package back to this repository; without
it the package page shows no source and inherits no repository README.

**The eBPF workflow is the exception.** It does not use `build-push-action` — it calls the submodule Makefile's
`image-build` target and pushes manually ([build-ebpf-exporter.yml:35](../.github/workflows/build-ebpf-exporter.yml#L35)).
Its extra tags are applied with `docker tag` + `docker push` against `metadata-action`'s computed tag list. Its
existing sha tag and `IMG_ORG` argument are unchanged.

---

## 5. Package visibility is manual

GHCR packages are created **private**, and no workflow can change that — it is a per-package setting, applied
once, for each of the four packages. Until it is done, every step above still leaves an outside puller with
`denied`. This is the single change that makes the images public; the rest only makes them exist.

---

## 6. Manifest changes

| File | Change |
|---|---|
| [deploy/40-nvml-exporter.yaml](../deploy/40-nvml-exporter.yaml) | `REPLACE_ME` → `ghcr.io/loiht2/nvml-exporter:v1.0.0`; drop `imagePullSecrets` |
| [deploy/40-ebpf-exporter.yaml](../deploy/40-ebpf-exporter.yaml) | `REPLACE_ME` → `ghcr.io/loiht2/ebpf-gpu-exporter:v1.0.0`; drop `imagePullSecrets` |
| [deploy/70-advanced-monitoring.yaml](../deploy/70-advanced-monitoring.yaml) | `REPLACE_ME_API` / `REPLACE_ME_UI` → the two service images; drop both `imagePullSecrets` blocks |
| [deploy/README.md](../deploy/README.md) | drop the `REPLACE_WITH_PULL_SECRET` substitution row |

All four manifests pin the release tag `:v1.0.0`, published by the `workflow_dispatch` route in
[3](#3-tags) — a concrete value written into the manifest, not a literal token: the point of this change is to
remove the `REPLACE_ME` step, not rename it. A commit sha would pin harder, but it differs per image and per
build, so the shared release tag is what keeps the four manifests readable and bumpable together.
`ghcr.io/loiht2/...` stays listed as a substitution for anyone republishing under a different owner.

---

## 7. Verification

Publishing is not proven by a green workflow — a private package pushes fine and pulls only for its owner.

1. `docker logout ghcr.io`, then `docker pull` each of the four images. This is the only check that
   distinguishes public from private.
2. `kubectl apply` the manifests on a cluster holding no `harbor-pull-secret`; every pod reaches `Running`.

---

## 8. Out of scope

Docker Hub mirroring; multi-arch builds (the existing workflows build a single architecture on
`ubuntu-latest`, matching the GPU nodes); image signing, SBOM, and provenance attestation; the two evaluation
exercisers.
