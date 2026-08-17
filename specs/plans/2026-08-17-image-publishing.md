# Image Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the four container images this repository builds to GHCR as public packages, so `deploy/` needs no registry credential.

**Architecture:** Implements [specs/15-image-publishing.md](../15-image-publishing.md). A new checker script (`scripts/check-images.py`) encodes the contract — no placeholder image tokens, no `imagePullSecrets`, every locally-built image pinned immutably and backed by a publishing workflow — following the existing `scripts/check-dashboards.py` pattern exactly. The checker is written first and fails against the current tree; the workflow and manifest changes make it pass.

**Tech Stack:** GitHub Actions (`docker/metadata-action`, `docker/build-push-action`), GHCR, Python 3 + PyYAML for the checker, pytest for its tests.

---

## Amendment to the spec

Spec §3 says `deploy/` manifests consume `:<sha>`. Pinning a commit sha creates a chicken-and-egg problem: the sha of the commit that edits the manifest is unknown until after it is committed, and the exporter workflows only trigger on pushes touching their own paths — so a manifest-only commit produces no image for its own sha.

**This plan pins `:v1.0.0` instead**, produced on demand. A release tag is equally immutable by convention and deterministic to write down. The checker accepts a digest, a `vX.Y.Z` tag, or a 40-hex commit sha, so pinning by sha later remains valid.

The release tag is published via `workflow_dispatch` with a `release_tag` input, **not** a `tags: ["v*"]` push trigger. GitHub applies `paths` filters to tag pushes as well, so a workflow with both `paths` and `tags` runs only when *both* match — and a tag push introduces no path change, so it would never fire. Every workflow here is path-filtered, so `workflow_dispatch` is the only trigger that reliably produces a release build.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/check-images.py` (create) | The contract. `check(paths) -> list[str]` of failure strings, matching `check-dashboards.py`'s shape |
| `test/test_check_images.py` (create) | Tests the checker against temp fixtures, matching `test_check_dashboards.py`'s shape |
| `.github/workflows/build-services.yml` (create) | Builds and pushes the two service images |
| `.github/workflows/build-nvml-exporter.yml` (modify) | Add the release/latest tag set + source label |
| `.github/workflows/build-ebpf-exporter.yml` (modify) | Same, via `docker tag`/`docker push` — it does not use `build-push-action` |
| `deploy/40-nvml-exporter.yaml` (modify) | Real image ref; drop `imagePullSecrets` |
| `deploy/40-ebpf-exporter.yaml` (modify) | Real image ref; drop `imagePullSecrets` |
| `deploy/70-advanced-monitoring.yaml` (modify) | Two real image refs; drop both `imagePullSecrets` blocks |
| `deploy/README.md` (modify) | Drop the pull-secret substitution row |

---

## Task 1: The image contract checker

**Files:**
- Create: `scripts/check-images.py`
- Test: `test/test_check_images.py`

- [ ] **Step 1: Write the failing test**

Create `test/test_check_images.py`:

```python
import importlib.util, pathlib, tempfile

# Anchored to the repo root rather than the working directory — see test_check_dashboards.
ROOT = pathlib.Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "check_images", ROOT / "scripts/check-images.py")
check_images = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_images)


def manifest(image, pull_secret=False):
    secrets = "      imagePullSecrets:\n        - name: harbor-pull-secret\n" if pull_secret else ""
    return (
        "apiVersion: apps/v1\n"
        "kind: DaemonSet\n"
        "metadata:\n"
        "  name: sample\n"
        "spec:\n"
        "  template:\n"
        "    spec:\n"
        f"{secrets}"
        "      containers:\n"
        "        - name: agent\n"
        f"          image: {image}\n"
    )


def run(image, pull_secret=False):
    with tempfile.TemporaryDirectory() as tmp:
        p = pathlib.Path(tmp) / "40-sample.yaml"
        p.write_text(manifest(image, pull_secret))
        return check_images.check([str(p)])


def test_placeholder_token_is_rejected():
    """REPLACE_ME means the manifest cannot be applied without an out-of-band
    edit — the exact friction this change removes."""
    assert any("placeholder" in f for f in run("REPLACE_ME"))


def test_mutable_tag_on_a_published_image_is_rejected():
    """build-nvml-exporter.yml records that a manifest must never reference a
    mutable tag: :latest silently changes what a deployed cluster is running."""
    assert any("not pinned" in f for f in run("ghcr.io/loiht2/nvml-exporter:latest"))


def test_release_tag_is_accepted():
    assert not run("ghcr.io/loiht2/nvml-exporter:v1.0.0")


def test_commit_sha_tag_is_accepted():
    assert not run("ghcr.io/loiht2/nvml-exporter:" + "a" * 40)


def test_digest_is_accepted():
    assert not run("ghcr.io/loiht2/nvml-exporter@sha256:" + "b" * 64)


def test_third_party_image_is_not_subject_to_the_pin_rule():
    """Pinning upstream images is not this contract's business — grafana:11.6.1
    carries no `v` prefix and must not be reported."""
    assert not run("grafana/grafana:11.6.1")


def test_pull_secret_is_rejected():
    """A public image needs no credential; a leftover imagePullSecrets makes the
    manifest fail on any cluster that lacks that secret."""
    assert any("imagePullSecrets" in f for f in run("ghcr.io/loiht2/nvml-exporter:v1.0.0",
                                                    pull_secret=True))


def test_every_published_image_has_a_publishing_workflow():
    """The set the spec promises to publish, checked against the workflows that
    actually push. A name in one and not the other is a broken promise."""
    assert not check_images.check_workflows()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest test/test_check_images.py -q`

Expected: collection error — `FileNotFoundError` / `No such file or directory: 'scripts/check-images.py'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/check-images.py`:

```python
#!/usr/bin/env python3
"""Enforce the published-image contract on deployment manifests.
Usage: check-images.py <file>..."""
import re, sys, pathlib, yaml

# The images this repository builds and publishes (15 §1). The pin rule applies
# only to these: pinning an upstream image like grafana:11.6.1 is not this
# contract's business, and the evaluation exercisers are deliberately excluded.
PUBLISHED = ("nvml-exporter", "ebpf-gpu-exporter",
             "advanced-monitoring-api", "advanced-monitoring-ui")

# A digest, a vX.Y.Z release tag, or a 40-hex commit sha. Anything else can move
# underneath a running cluster.
PINNED = re.compile(r"^[^:@\s]+(?::(?:v\d+\.\d+\.\d+|[0-9a-f]{40})|@sha256:[0-9a-f]{64})$")

WORKFLOWS = pathlib.Path(__file__).resolve().parent.parent / ".github/workflows"


def _walk(node, key):
    """Every value stored under `key` at any depth. Manifests nest images under
    containers and initContainers alike, so a fixed path would miss some."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            else:
                yield from _walk(v, key)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item, key)


def is_published(image):
    return any(f"/{name}:" in image or f"/{name}@" in image or image.endswith(f"/{name}")
               for name in PUBLISHED)


def check(paths):
    fail = []
    for path in paths:
        for doc in yaml.safe_load_all(pathlib.Path(path).read_text()):
            if not doc:
                continue
            for image in _walk(doc, "image"):
                if not isinstance(image, str):
                    continue
                if "REPLACE_ME" in image:
                    fail.append(f"{path}: image '{image}' is still a placeholder")
                elif is_published(image) and not PINNED.match(image):
                    fail.append(f"{path}: image '{image}' is not pinned to a digest, "
                                f"release tag or commit sha")
            for _ in _walk(doc, "imagePullSecrets"):
                fail.append(f"{path}: declares imagePullSecrets — published images "
                            f"are public and need no credential")
    return fail


def check_workflows():
    """Every published image must be pushed by some workflow. Without this the
    manifests can reference a package that nothing ever builds."""
    text = "\n".join(p.read_text() for p in sorted(WORKFLOWS.glob("*.yml")))
    return [f"no workflow publishes '{name}'" for name in PUBLISHED if name not in text]


if __name__ == "__main__":
    problems = check(sys.argv[1:]) + check_workflows()
    for p in problems:
        print("FAIL:", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest test/test_check_images.py -q`

Expected: 7 passed, 1 failed — `test_every_published_image_has_a_publishing_workflow` fails, because no workflow publishes `advanced-monitoring-api` or `advanced-monitoring-ui` yet. That failure is the point; Task 2 clears it.

- [ ] **Step 5: Record the current state of the real manifests**

Run: `python scripts/check-images.py deploy/*.yaml`

Expected: non-zero exit listing the placeholder images in `40-nvml-exporter.yaml`, `40-ebpf-exporter.yaml`, `70-advanced-monitoring.yaml`, the three `imagePullSecrets` declarations, and the two missing workflows. Paste this output into the commit message body — it is the baseline the rest of the plan closes.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-images.py test/test_check_images.py
git commit -m "add the image contract checker"
```

---

## Task 2: Publish the two service images

**Files:**
- Create: `.github/workflows/build-services.yml`
- Test: `test/test_check_images.py::test_every_published_image_has_a_publishing_workflow`

- [ ] **Step 1: Run the failing test**

Run: `python -m pytest test/test_check_images.py::test_every_published_image_has_a_publishing_workflow -q`

Expected: FAIL, with `no workflow publishes 'advanced-monitoring-api'` and `no workflow publishes 'advanced-monitoring-ui'`.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/build-services.yml`:

```yaml
name: build-services

on:
  push:
    paths:
      - "services/**"
      - ".github/workflows/build-services.yml"
  workflow_dispatch:
    inputs:
      release_tag:
        description: "Immutable release tag to publish, e.g. v1.0.0. Leave empty for a plain rebuild."
        required: false
        default: ""

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      # One job per service. The two contexts differ only by directory, image
      # name and how they are tested, so a matrix beats two near-identical files.
      fail-fast: false
      matrix:
        include:
          - name: advanced-monitoring-api
            context: services/advanced-monitoring-api
          - name: advanced-monitoring-ui
            context: services/advanced-monitoring-ui
    steps:
      - uses: actions/checkout@v4

      - name: Test the API
        if: matrix.name == 'advanced-monitoring-api'
        run: |
          cd ${{ matrix.context }}
          pip install -r requirements.txt
          python -m pytest tests/ -q

      - name: Type-check the UI
        if: matrix.name == 'advanced-monitoring-ui'
        run: |
          cd ${{ matrix.context }}
          npm ci
          npx tsc --noEmit

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/${{ matrix.name }}
          # The commit and release tags are what a manifest may reference;
          # latest is for people, and never enters deploy/. release_tag is empty
          # on a push event, which disables that line.
          tags: |
            type=sha,format=long,prefix=
            type=raw,value=latest,enable={{is_default_branch}}
            type=raw,value=${{ inputs.release_tag }},enable=${{ inputs.release_tag != '' }}
          # Links the GHCR package back to this repository — without it the
          # package page shows no source.
          labels: |
            org.opencontainers.image.source=https://github.com/${{ github.repository }}

      - uses: docker/build-push-action@v5
        with:
          context: ${{ matrix.context }}
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `python -m pytest test/test_check_images.py -q`

Expected: 8 passed.

- [ ] **Step 4: Verify the workflow parses as YAML**

Run: `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-services.yml')); print('ok')"`

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build-services.yml
git commit -m "publish the two monitoring service images to ghcr"
```

---

## Task 3: Add the release tag set to the NVML exporter workflow

**Files:**
- Modify: `.github/workflows/build-nvml-exporter.yml:31-36`

- [ ] **Step 1: Replace the tags block**

The file currently ends with:

```yaml
      - uses: docker/build-push-action@v5
        with:
          context: exporters/nvml
          push: true
          # Tag by commit: a manifest must never reference a mutable tag.
          tags: ghcr.io/${{ github.repository_owner }}/nvml-exporter:${{ github.sha }}
```

Replace those six lines with:

```yaml
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/nvml-exporter
          # Tag by commit: a manifest must never reference a mutable tag. latest
          # is for people reading the README. release_tag is empty on a push
          # event, which disables that line.
          tags: |
            type=sha,format=long,prefix=
            type=raw,value=latest,enable={{is_default_branch}}
            type=raw,value=${{ inputs.release_tag }},enable=${{ inputs.release_tag != '' }}
          labels: |
            org.opencontainers.image.source=https://github.com/${{ github.repository }}

      - uses: docker/build-push-action@v5
        with:
          context: exporters/nvml
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 2: Add the release trigger**

The `on:` block currently reads:

```yaml
on:
  push:
    paths:
      - "exporters/nvml/**"
      - ".github/workflows/build-nvml-exporter.yml"
```

Add `workflow_dispatch` so a release build can be produced on demand:

```yaml
on:
  push:
    paths:
      - "exporters/nvml/**"
      - ".github/workflows/build-nvml-exporter.yml"
  workflow_dispatch:
    inputs:
      release_tag:
        description: "Immutable release tag to publish, e.g. v1.0.0. Leave empty for a plain rebuild."
        required: false
        default: ""
```

- [ ] **Step 3: Verify it parses and the sha tag survived**

Run:
```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/build-nvml-exporter.yml')); print('ok')"
grep -c "type=sha" .github/workflows/build-nvml-exporter.yml
```

Expected: `ok` then `1`.

- [ ] **Step 4: Run the suite**

Run: `python -m pytest test/test_check_images.py -q`

Expected: 8 passed (unchanged — this task adds tags, it does not change which images are published).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build-nvml-exporter.yml
git commit -m "tag the nvml exporter image with latest and the release version"
```

---

## Task 4: Add the release tag set to the eBPF exporter workflow

**Files:**
- Modify: `.github/workflows/build-ebpf-exporter.yml:27-36`

This workflow does **not** use `build-push-action` — it calls the submodule Makefile's `image-build` target, so `metadata-action`'s tag list is applied with `docker tag` rather than consumed by a build action.

- [ ] **Step 1: Add the release trigger**

The `on:` block currently reads:

```yaml
on:
  push:
    paths:
      - "exporters/ebpf/**"
      - ".github/workflows/build-ebpf-exporter.yml"
```

Replace with:

```yaml
on:
  push:
    paths:
      - "exporters/ebpf/**"
      - ".github/workflows/build-ebpf-exporter.yml"
  workflow_dispatch:
    inputs:
      release_tag:
        description: "Immutable release tag to publish, e.g. v1.0.0. Leave empty for a plain rebuild."
        required: false
        default: ""
```

- [ ] **Step 2: Replace the build step**

The file currently ends with:

```yaml
      - name: Build and push
        env:
          IMG: ghcr.io/${{ github.repository_owner }}/ebpf-gpu-exporter:${{ github.sha }}
        run: |
          cd exporters/ebpf/eBPF-Lens
          # image-build, not docker-build: the upstream Makefile defines no
          # docker-build target. IMG_ORG is asserted by check_defined, so it
          # must be set even though IMG is given in full.
          make image-build IMG="$IMG" IMG_ORG=${{ github.repository_owner }}
          docker push "$IMG"
```

Replace with:

```yaml
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/ebpf-gpu-exporter
          tags: |
            type=sha,format=long,prefix=
            type=raw,value=latest,enable={{is_default_branch}}
            type=raw,value=${{ inputs.release_tag }},enable=${{ inputs.release_tag != '' }}
          labels: |
            org.opencontainers.image.source=https://github.com/${{ github.repository }}

      - name: Build and push
        env:
          IMG: ghcr.io/${{ github.repository_owner }}/ebpf-gpu-exporter:${{ github.sha }}
          TAGS: ${{ steps.meta.outputs.tags }}
        run: |
          cd exporters/ebpf/eBPF-Lens
          # image-build, not docker-build: the upstream Makefile defines no
          # docker-build target. IMG_ORG is asserted by check_defined, so it
          # must be set even though IMG is given in full.
          make image-build IMG="$IMG" IMG_ORG=${{ github.repository_owner }}
          # The Makefile builds exactly one tag, so the rest are aliases of it.
          # metadata-action emits one tag per line.
          echo "$TAGS" | while read -r tag; do
            [ -z "$tag" ] && continue
            docker tag "$IMG" "$tag"
            docker push "$tag"
          done
```

- [ ] **Step 3: Verify it parses**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/build-ebpf-exporter.yml')); print('ok')"`

Expected: `ok`

- [ ] **Step 4: Run the suite**

Run: `python -m pytest test/test_check_images.py -q`

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build-ebpf-exporter.yml
git commit -m "tag the ebpf exporter image with latest and the release version"
```

---

## Task 5: Point the manifests at the published images

**Files:**
- Modify: `deploy/40-nvml-exporter.yaml:23-24,33`
- Modify: `deploy/40-ebpf-exporter.yaml:59-60,63`
- Modify: `deploy/70-advanced-monitoring.yaml:29-30,33,69-70,73`
- Test: `test/test_check_images.py` (unchanged) plus `scripts/check-images.py` against the real tree

- [ ] **Step 1: Confirm the checker is red against the real manifests**

Run: `python scripts/check-images.py deploy/*.yaml`

Expected: non-zero exit, reporting three placeholder images and three `imagePullSecrets` declarations.

- [ ] **Step 2: Fix the NVML exporter manifest**

In `deploy/40-nvml-exporter.yaml`, delete these two lines:

```yaml
      imagePullSecrets:
        - name: harbor-pull-secret
```

and change:

```yaml
          image: REPLACE_ME
```

to:

```yaml
          image: ghcr.io/loiht2/nvml-exporter:v1.0.0
```

- [ ] **Step 3: Fix the eBPF exporter manifest**

In `deploy/40-ebpf-exporter.yaml`, delete these two lines:

```yaml
      imagePullSecrets:
        - name: harbor-pull-secret
```

and change:

```yaml
          image: REPLACE_ME
```

to:

```yaml
          image: ghcr.io/loiht2/ebpf-gpu-exporter:v1.0.0
```

- [ ] **Step 4: Fix the advanced monitoring manifest**

In `deploy/70-advanced-monitoring.yaml`, delete **both** occurrences of:

```yaml
      imagePullSecrets:
        - name: harbor-pull-secret
```

and change:

```yaml
          image: REPLACE_ME_API
```

to:

```yaml
          image: ghcr.io/loiht2/advanced-monitoring-api:v1.0.0
```

and:

```yaml
          image: REPLACE_ME_UI
```

to:

```yaml
          image: ghcr.io/loiht2/advanced-monitoring-ui:v1.0.0
```

- [ ] **Step 5: Verify the checker is green**

Run: `python scripts/check-images.py deploy/*.yaml`

Expected: `0 problem(s)` and exit code 0.

- [ ] **Step 6: Verify the manifests still parse and no placeholder survives**

Run:
```bash
for f in deploy/*.yaml; do python -c "import yaml,sys; list(yaml.safe_load_all(open('$f')))" || echo "BAD $f"; done
grep -rn "REPLACE_ME\|harbor-pull-secret" deploy/ || echo "clean"
```

Expected: no `BAD` lines, then `clean`.

- [ ] **Step 7: Commit**

```bash
git add deploy/40-nvml-exporter.yaml deploy/40-ebpf-exporter.yaml deploy/70-advanced-monitoring.yaml
git commit -m "point the manifests at the public ghcr images"
```

---

## Task 6: Update the deployment README

**Files:**
- Modify: `deploy/README.md:25-31`

- [ ] **Step 1: Remove the pull-secret substitution row**

The substitution table currently reads:

```markdown
| Token | Replace with |
|---|---|
| `REPLACE_WITH_PULL_SECRET` | An image-pull secret in `gpu-monitoring` for the registry holding the images |
| `REPLACE_WITH_HAMI_NAMESPACE` | The namespace HAMi's device-plugin runs in |
| `REPLACE_WITH_NODE_NAME` (storage manifest) | The node the Prometheus PV is pinned to |
| `ghcr.io/loiht2/...` | Your registry, if not GHCR |
```

Delete the `REPLACE_WITH_PULL_SECRET` row, leaving:

```markdown
| Token | Replace with |
|---|---|
| `REPLACE_WITH_HAMI_NAMESPACE` | The namespace HAMi's device-plugin runs in |
| `REPLACE_WITH_NODE_NAME` (storage manifest) | The node the Prometheus PV is pinned to |
| `ghcr.io/loiht2/...` | Your registry, if not GHCR |
```

- [ ] **Step 2: State that the images are public**

Immediately after the substitution table, replace this paragraph:

```markdown
Images are built by CI from the repository root. **CI cannot build the eBPF image until the two
`rename-gpu-metrics-to-ebpf` submodule branches are pushed** — a fresh `checkout --recurse-submodules` cannot
resolve pointers that exist only on a laptop.
```

with:

```markdown
Images are built by CI from the repository root and published to GHCR as **public** packages, so no pull
secret is needed. Verify with `docker logout ghcr.io && docker pull ghcr.io/loiht2/nvml-exporter:v1.0.0` —
a green CI run proves only that the package exists, not that anyone else can read it.

**CI cannot build the eBPF image until the two `rename-gpu-metrics-to-ebpf` submodule branches are pushed** —
a fresh `checkout --recurse-submodules` cannot resolve pointers that exist only on a laptop.
```

- [ ] **Step 3: Verify no stale reference survives**

Run: `grep -rn "REPLACE_WITH_PULL_SECRET" deploy/ || echo "clean"`

Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git add deploy/README.md
git commit -m "drop the pull secret from the deployment instructions"
```

---

## Task 7: Run the full suite and record what remains manual

**Files:**
- None modified.

- [ ] **Step 1: Run the whole Python suite**

Run: `python -m pytest test/ test/evaluation/ -q`

Expected: all tests pass, including the 8 in `test_check_images.py`. If any pre-existing test fails, report it rather than fixing it — it is outside this plan's scope.

- [ ] **Step 2: Run both checkers against the real tree**

Run:
```bash
python scripts/check-images.py deploy/*.yaml
python scripts/check-dashboards.py dashboards/*.json
```

Expected: `0 problem(s)` from the image checker. The dashboard checker's result must be unchanged from before this plan — this plan touches no dashboard.

- [ ] **Step 3: Report the manual steps**

These cannot be automated and are **not** done by this plan. Report them to the user verbatim:

1. **Publish the `v1.0.0` images** — the manifests reference that tag and nothing builds it until you say so.
   Run each of the three workflows (`build-nvml-exporter`, `build-ebpf-exporter`, `build-services`) from the
   Actions tab via *Run workflow*, entering `v1.0.0` as `release_tag`. Or with the `gh` CLI:
   ```bash
   for w in build-nvml-exporter build-ebpf-exporter build-services; do
     gh workflow run "$w.yml" -f release_tag=v1.0.0
   done
   ```
2. **Flip the four GHCR packages to public** — repository → Packages → each of `nvml-exporter`,
   `ebpf-gpu-exporter`, `advanced-monitoring-api`, `advanced-monitoring-ui` → Package settings → Change
   visibility → Public. GHCR creates packages private and no workflow can change this. **Until this is done,
   an outside puller still gets `denied` and nothing else in this plan matters.**
3. **Check `ghcr.io/loiht2/gpu-burn`** — referenced by `deploy/90-loadgen-gpu-burn.yaml` but built outside
   this repository, so its visibility must be set by hand too.
4. **Verify from outside**: `docker logout ghcr.io` then `docker pull` each of the four images.

---

## Out of scope

Docker Hub mirroring; multi-arch builds; signing, SBOM and provenance; publishing `pipe-exerciser` and
`api-exerciser` (deferred — they are evaluation fixtures, not deployment components); wiring
`check-images.py` into CI (`check-dashboards.py` is not wired in either, and matching that is the smaller change).
