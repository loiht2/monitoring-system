# Test fixtures and checks

Everything here exists to *verify* the system, not to run it. Nothing in this directory is part of a
deployment.

| | |
|---|---|
| `test_check_dashboards.py` | Tests the dashboard contract checker (`scripts/check-dashboards.py`) |
| `test_extract_panels.py` | Tests the panel-spec generator (`scripts/extract-panels.py`) |
| `test_deploy_manifests.py` | Proves `kubectl apply -f deploy/` is self-sufficient — every mounted ConfigMap is created, and the generated dashboard manifest matches `dashboards/` |
| `test-helpers.sh` | Smoke test for the PromQL helper scripts |
| `loadgen/` | Deliberate GPU load used to prove metrics respond. Applied by hand during validation, never as part of the stack |

Run the Python suite from anywhere — the tests anchor to the repository root rather than the working
directory:

```bash
python -m pytest test/ -q
```

`test/` recurses, so this covers `evaluation/` too. Do **not** add `test/evaluation/` as a second argument:
passing a subdirectory alongside its parent makes pytest collect only the subdirectory, so the run reports
8 passing tests instead of 37 and looks green while skipping most of the suite.

`loadgen/` manifests are applied only when generating load to validate a metric, and deleted afterwards:

```bash
kubectl apply -f test/loadgen/gpu-burn.yaml   # then delete it when the measurement is taken
```

They live here rather than in `deploy/` because applying `deploy/` should install the monitoring stack and
nothing else — a load generator left running is a GPU that is busy for no reason.
