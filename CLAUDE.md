# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace layout

This directory is a VS Code multi-root workspace ([monitoring-system.code-workspace](monitoring-system.code-workspace)); it contains no source of its own. The two folders it aggregates are siblings:

| Folder | What it is |
|---|---|
| `../ml-platform` | The codebase — CNLab.ai ML Platform (git repo, `origin` = `github.com/loiht2/ml-platform`, default branch `main`) |
| `../metrics` | Research/documentation only — GPU hardware metric catalogs (CSV + Markdown), no code. Has its own [CLAUDE.md](../metrics/CLAUDE.md) with always-on engineering constraints that apply to work in that folder |

Everything below concerns `../ml-platform` unless stated otherwise.

## Commands

All backend commands run from `ml-platform/quota_api/`; a venv already exists at `quota_api/.venv`.

```bash
# Backend dev server (hot reload) — http://localhost:9000, docs at /docs
source .venv/bin/activate && fastapi dev --host 0.0.0.0 --port 9000

# Tests — pytest is NOT installed in .venv yet; install it first
pip install -r requirements-dev.txt
python -m pytest -q                                  # whole suite (pytest.ini sets testpaths=tests)
python -m pytest tests/test_gpu_alloc.py -v          # one file
python -m pytest tests/test_quota_gpu_count_ceiling.py::TestGpuCountCeiling -v   # one class
python -m pytest -k gpu_count -v                     # by name
```

Run pytest from `quota_api/`, not the repo root — `tests/conftest.py` inserts `quota_api/` onto `sys.path` relative to itself and stubs the env vars `config.py` reads at import time.

Frontend, from `ml-platform/frontend/`:

```bash
npm run dev      # Next.js dev server on :3001
npm run build    # production build (output: 'standalone')
npx tsc --noEmit # the real correctness gate — passes clean today
```

`npm run lint` (`next lint`) is declared but no ESLint config is checked in, so it is not a usable gate. Use `tsc --noEmit`.

The root `ml-platform/package.json` only proxies into `frontend/` (`npm run dev|build|start`).

JupyterLab extensions (`jupyterlab-missed-output-replay/`, `jupyterlab-pod-pending-notice/`) are standard copier-templated `jupyter-builder` projects: `jlpm build`, `jlpm build:prod`, `jlpm watch`, `jlpm lint`.

Deployment: `kubectl apply -f deploy/k8s/` — files are numbered in dependency order. Images are built by GitHub Actions on pushes touching `frontend/**` or `quota_api/**` and pushed to GHCR. See [deploy/k8s/README.md](../ml-platform/deploy/k8s/README.md).

## Architecture

Two deployable components (`quota_api/` and `frontend/`) sitting alongside a stack that is deployed separately and configured through YAML in this repo: JupyterHub + KubeSpawner, Jupyter Enterprise Gateway (EG), Keycloak, HAMi (fractional GPU), and kube-prometheus-stack/DCGM.

**quota-api** (FastAPI + SQLite) is the control plane. It owns users/roles/permissions, GPU quotas, GPU profiles, the image catalogue, checkpoint/restore policy, idle-GPU reclamation, and node inventory. `main.py` registers 22 routers and runs a startup sequence of idempotent, fail-safe reconciliations (schema migrations, GPU-profile fixups, Keycloak group sync, Harbor seeding, stale-row cleanup) — every step logs a warning and continues on failure rather than aborting boot.

**frontend** (Next.js 15 App Router + React 19 + Tailwind) has three surfaces: `app/portal` (users), `app/admin` (operators), `app/lab`. All server state goes through `lib/api.ts`'s `apiFetch`, which handles Keycloak token refresh and normalizes FastAPI error bodies into `ApiError` with a human-readable `.message`.

**The spawn path is the load-bearing integration.** A JupyterHub `pre_spawn_hook` and `post_stop_hook`, written inline in `quota_api/jh-config.yaml` (a Helm values file), call back into quota-api on every server spawn to fetch the user's allowed kernels (`KERNEL_WHITELIST`) and GPU sizing, and to enforce quota. Kernels themselves run as separate pods created by EG in its own namespace, sized by HAMi extended resources. Consequences:

- Changing what a spawn needs in its environment means editing **both** the Python that computes it and the hook in `jh-config.yaml`, which is deployed as Helm values, not as application code.
- The hooks are deliberately fail-open: a quota-api outage logs a warning and allows the spawn (falling back to `python3`) rather than blocking all users.
- A JupyterHub *server* outliving its EG *kernel* is normal, which is why `server_gpu_profiles` rows are cross-referenced against JupyterHub's live server list instead of trusted directly.

**Pure logic is deliberately separated from I/O** so it is unit-testable without Kubernetes or FastAPI: `gpu_alloc.py` (fraction → HAMi resource values), `reclamation_logic.py` (idle-signal AND-gate + grace state machine), `restore_policy.py` (restore destination decisions), and most of `quota.py`. Routers own all I/O and call in with already-fetched data. Keep that split when adding logic.

**Registry integrations** go behind `registries/base.py`'s `RegistryProvider` ABC, selected via `registries/factory.py`. Harbor is the only implementation. Never branch on registry vendor inside `image_service.py`, `sync_service.py`, or a router — add a provider class.

### Invariants worth knowing before you change things

- **quota-api is single-replica by design.** SQLite on a `ReadWriteOnce` PVC, plus per-user in-process `asyncio.Lock`s in `quota.py` to serialize spawn check-and-act. `deploy/k8s/06-deployment-quota-api.yaml` pins `replicas: 1` / `maxUnavailable: 0`. Do not introduce code that assumes multiple replicas without first migrating off SQLite and off in-process locking.
- **No migration framework.** `database.py:init_db()` is `CREATE TABLE IF NOT EXISTS` plus additive column-adds guarded by `PRAGMA table_info` checks. New columns must be nullable/defaulted and added the same way; never rewrite or drop a table.
- **GPU VRAM is discovered live, never hardcoded.** `k8s.get_gpu_capacity()` sizes against the *smallest* GPU in the fleet because a kernel pod's nodeSelector only pins it to some GPU node. `GPU_VRAM_MB` is an explicit opt-in escape hatch for clusters where discovery is impossible. Failure to discover raises `GpuCapacityError` → 503, on purpose. Relatedly: `nvidia.com/gpumem-percentage` is a trap — HAMi's DRA driver ignores it and grants the whole card; use `nvidia.com/gpumem` (MiB) + `nvidia.com/gpucores` (0-100).
- **Quota rule.** A user's server limit comes from the *highest-`gpu_fraction`* profile they hold, while the physical-GPU-count ceiling comes independently from the *highest `gpu_count`* among their profiles. These two dimensions do not scale together — see `quota.py`'s module docstring before touching either.
- **Auth has three entry points**, all in `auth.py`: `require_auth` (admin-only — Keycloak `platform-admin` realm role/group, or the static `QUOTA_API_TOKEN` service bypass), `extract_user` (any provisioned+enabled user, enriched with role permissions and kernel slugs from SQLite), and `require_permission("...")` for a specific permission from `ALL_PERMISSIONS`.
- **`quota_api/.env.local` is loaded with `override=True`** — it beats shell env. If a value looks wrong at runtime, check that file first.
- **`quota_api/*.py` are flat top-level modules, not a package.** Imports are `from config import ...`, and circular deps are broken with function-local imports (`from database import record` inside a function). Follow the existing pattern.
- **Frontend runtime config, not build-time.** `NEXT_PUBLIC_*` would bake URLs into the image, so `docker-entrypoint.sh` writes `/env.js` (`window.__ENV`) at container start and `lib/runtimeEnv.ts` prefers it. Read deployment URLs through those getters, never `process.env` directly. Similarly, `lib/uiConfig.ts` holds compiled defaults that `GET /ui-config` deep-merges per-deployment overrides onto — unknown/mistyped keys are ignored by design.

### Documentation state

`docs/` is extensive (user/admin/technical/developer/api guides, plus `docs/requirements/` design specs that the code cites by section number) and worth reading for domain context. But parts predate the current code:

- `docs/developer/01-local-setup.md`, `02-repository-structure.md`, `04-frontend-development.md` and `technical/01-architecture-overview.md` describe the frontend as static HTML. **That is now legacy.** The live UI is `frontend/` (Next.js); the root `index.html`, `admin.html`, `portal.html`, `styles.css`, `script.js` are the superseded originals, and `admin.html` is a 250 KB single file. Edit `frontend/`.
- `docs/developer/05-testing.md` describes test files (`test_auth.py`, `test_users.py`, `test_roles.py`, `test_quotas.py`) and a `conftest.py` that do not exist. The real suite is 8 files / ~98 tests, mostly class-grouped, covering `gpu_alloc`, GPU-profile endpoints, quota GPU-count ceilings, pod-pending reasons, pending-kernel discovery, workload-kernel auth, and monitoring recovery.
- Docstrings occasionally cite tests that were never added (e.g. `reclamation_logic.py` cites `tests/test_reclamation_logic.py`). Verify a referenced file exists before relying on it.

The `docs/build_doc.py` / `build_ppt.py` scripts generate the checked-in `.docx`/`.pptx` from `python-docx`/`python-pptx` and are not part of any build pipeline.

### Secrets

`quota_api/.env.local`, `quota_api/.credential.key`, `quota_api/quota.db*`, and `frontend/.env.local` are present locally and gitignored.

Two things `.gitignore` does *not* cover, despite documentation implying otherwise:

- `deploy/k8s/README.md` instructs you to `cp 01-secrets.example.yaml 01-secrets.yaml` and calls that file gitignored. It is not — `git check-ignore` confirms nothing matches it. Keep filled-in secrets outside the tree or add the ignore rule before creating it.
- `quota_api/jh-config.yaml` and several files under `docs/jhub_eg_keycloak/` already have real cluster IPs, a JupyterHub `secretToken`/`apiToken`, and Keycloak client secrets committed. Treat them as known-exposed rather than as a place to add more.

# Project Instructions

## Communication
- Keep conversational replies concise and focused on key decisions, results,
blockers, and next actions.
- Do not restate the request or provide unnecessary explanation.
Avoid pasting long code excerpts or entire files into chat; reference file paths
and relevant lines instead.
- Provide additional detail when required for design approval, implementation
plans, debugging evidence, security, or production safety.

## Existing-system changes
Before proposing changes:
- Inspect the relevant architecture, entry points, existing patterns, tests,
configuration, data model and migrations, authentication and authorization,
deployment path, and upstream or licensing constraints.
- Establish a clean baseline by running the relevant existing checks.
- Prefer an existing, supported extension point when it is stable and simpler
than modifying core. Do not invent a new abstraction merely to avoid a
small localized core change.

## Coding constraints
- State material assumptions and ambiguities before coding.
- Present trade-offs when more than one materially different approach exists.
- Implement the smallest solution that satisfies the approved success criteria.
- Make surgical changes: every changed line must serve the requested task.
- Match existing project style, structure, naming, and error-handling patterns.
- Do not perform unrelated refactoring, reformatting, renaming, dependency
upgrades, or dead-code cleanup.
- Remove only artifacts made unused by the current change.
- Do not add speculative abstractions, configuration options, compatibility
  layers, or future features.

## Documentation Guidelines
When writing documentation:
- Keep it concise, focused, and practical.
- Cover the main points, required actions, and important considerations.
- Do not restate the user's request.
- Avoid unnecessary background, repetition, or overly long explanations.
- Explain only what is needed for the reader to understand and act.
- Prefer short, clear explanations over exhaustive detail.

## Contribution Rules
- Do not add AI co-author trailers to commits. No Co-Authored-By: Claude, assisted-by, or similar. AI-generated commit messages must be briefly, concise, and understandable with human.
- Do not automatically commit until I approve.