import importlib.util, json, pathlib, tempfile

# Anchored to the repo root rather than the working directory, so the suite runs the
# same from the root, from test/, or from an IDE with an arbitrary cwd.
ROOT = pathlib.Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "check_dashboards", ROOT / "scripts/check-dashboards.py")
check_dashboards = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_dashboards)


def mig_dash(expr):
    return {
        "uid": "gpu-hardware-mig", "title": "GPU Hardware — MIG",
        "panels": [{"id": 1, "type": "timeseries", "title": "SM Efficiency",
                    "description": "Percent of cycles where an SM had at least one warp resident.",
                    "gridPos": {"h": 8, "w": 9, "x": 0, "y": 0},
                    "targets": [{"expr": expr}]}],
    }


def run(expr):
    with tempfile.TemporaryDirectory() as tmp:
        p = pathlib.Path(tmp) / "gpu-hardware-mig.json"
        p.write_text(json.dumps(mig_dash(expr)))
        return [f for f in check_dashboards.check([str(p)]) if "SM Efficiency" in f]


def test_migid_without_nonempty_clause_is_rejected():
    """$migid expands to `.*` for "All", which matches the empty string too, so a
    device-scope row would leak onto the MIG dashboard. GPU_I_ID!="" is load-bearing."""
    assert run('DCGM_FI_PROF_SM_ACTIVE{gpu_uuid=~"$gpu", GPU_I_ID=~"$migid"}')


def test_migid_with_nonempty_clause_is_accepted():
    assert not run('DCGM_FI_PROF_SM_ACTIVE{gpu_uuid=~"$gpu", GPU_I_ID=~"$migid", GPU_I_ID!=""}')


def test_target_with_neither_clause_is_rejected():
    assert run('DCGM_FI_PROF_SM_ACTIVE{gpu_uuid=~"$gpu"}')


def test_same_title_different_scope_may_differ():
    """A field read at device scope and at instance scope is two measurements.

    02 gives them separate definitions ("memory installed on the card" vs "assigned to
    the instance"), so the shared-description rule must not force one to carry the
    other's wording.
    """
    device = {"uid": "gpu-hardware-device", "title": "d", "panels": [
        {"id": 1, "type": "timeseries", "title": "Memory Used Over Time",
         "description": "Memory in use.", "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
         "targets": [{"expr": 'DCGM_FI_DEV_FB_USED{gpu_uuid=~"$gpu", GPU_I_ID=""}'}]}]}
    mig = {"uid": "gpu-hardware-mig", "title": "m", "panels": [
        {"id": 1, "type": "timeseries", "title": "Memory Used Over Time",
         "description": "Memory in use inside the instance.",
         "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
         "targets": [{"expr": 'DCGM_FI_DEV_FB_USED{gpu_uuid=~"$gpu", GPU_I_ID=~"$migid", GPU_I_ID!=""}'}]}]}
    with tempfile.TemporaryDirectory() as tmp:
        a = pathlib.Path(tmp) / "gpu-hardware-device.json"
        b = pathlib.Path(tmp) / "gpu-hardware-mig.json"
        a.write_text(json.dumps(device)); b.write_text(json.dumps(mig))
        fails = check_dashboards.check([str(a), str(b)])
    assert not [f for f in fails if "description for" in f], fails
