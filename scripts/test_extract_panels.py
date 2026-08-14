import json, subprocess, sys, tempfile, pathlib

SAMPLE = {
    "uid": "gpu-hardware-device", "title": "GPU Hardware — Device",
    "templating": {"list": [{"name": "gpu", "query": "label_values(gpu_uuid)",
                             "includeAll": True, "multi": True}]},
    "panels": [
        {"type": "row", "title": "Performance", "collapsed": False,
         "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0}, "panels": []},
        {"id": 3, "type": "timeseries", "title": "SM Activity",
         "description": "Percent of cycles where an SM had at least one warp resident.",
         "gridPos": {"h": 8, "w": 9, "x": 15, "y": 1},
         "fieldConfig": {"defaults": {"unit": "percentunit"}},
         "targets": [{"expr": 'DCGM_FI_PROF_SM_ACTIVE{gpu_uuid=~"$gpu"}',
                      "legendFormat": "{{node}} gpu{{gpu}}"}]},
        {"type": "row", "title": "Memory", "collapsed": True,
         "gridPos": {"h": 1, "w": 24, "x": 0, "y": 1},
         "panels": [
             {"id": 9, "type": "gauge", "title": "Memory Used vs Total",
              "description": "Memory in use, against the memory installed on the card.",
              "gridPos": {"h": 8, "w": 8, "x": 0, "y": 0},
              "fieldConfig": {"defaults": {"unit": "percentunit", "min": 0, "max": 1}},
              "targets": [{"expr": "DCGM_FI_DEV_FB_USED", "legendFormat": "gpu{{gpu}}"}]}]},
    ],
}

def run(tmp):
    src = pathlib.Path(tmp) / "d.json"
    src.write_text(json.dumps(SAMPLE))
    out = pathlib.Path(tmp) / "panels.json"
    subprocess.run([sys.executable, "scripts/extract-panels.py", str(src), "-o", str(out)],
                   check=True)
    return json.loads(out.read_text())

def run_real(tmp):
    """Run the extractor over the checked-in dashboards. Per-dashboard variable ownership
    can only be asserted against the real set, where `pod` exists on one dashboard only."""
    out = pathlib.Path(tmp) / "panels.json"
    sources = sorted(str(p) for p in pathlib.Path("dashboards").glob("*.json"))
    subprocess.run([sys.executable, "scripts/extract-panels.py", *sources, "-o", str(out)],
                   check=True)
    return json.loads(out.read_text())

def test_extracts_dashboard_identity():
    with tempfile.TemporaryDirectory() as tmp:
        got = run(tmp)
        assert got["dashboards"][0]["uid"] == "gpu-hardware-device"
        assert got["dashboards"][0]["title"] == "GPU Hardware — Device"

def test_flattens_collapsed_rows_keeping_row_membership():
    """A collapsed row nests its panels; an expanded row leaves them at top level.
    Both must come out as the same shape, or half the UI silently loses its panels."""
    with tempfile.TemporaryDirectory() as tmp:
        rows = run(tmp)["dashboards"][0]["rows"]
        assert [r["title"] for r in rows] == ["Performance", "Memory"]
        assert [p["title"] for p in rows[0]["panels"]] == ["SM Activity"]
        assert [p["title"] for p in rows[1]["panels"]] == ["Memory Used vs Total"]

def test_carries_query_unit_and_description():
    with tempfile.TemporaryDirectory() as tmp:
        p = run(tmp)["dashboards"][0]["rows"][0]["panels"][0]
        assert p["targets"][0]["expr"] == 'DCGM_FI_PROF_SM_ACTIVE{gpu_uuid=~"$gpu"}'
        assert p["targets"][0]["legendFormat"] == "{{node}} gpu{{gpu}}"
        assert p["unit"] == "percentunit"
        assert p["description"].startswith("Percent of cycles")
        assert p["type"] == "timeseries"

def test_carries_variables():
    with tempfile.TemporaryDirectory() as tmp:
        v = run(tmp)["variables"]
        assert v[0]["name"] == "gpu"
        assert v[0]["query"] == "label_values(gpu_uuid)"

def test_panel_without_targets_is_dropped():
    """A row header or text panel has no query and must not reach the UI as an empty chart."""
    with tempfile.TemporaryDirectory() as tmp:
        for r in run(tmp)["dashboards"][0]["rows"]:
            for p in r["panels"]:
                assert p["targets"], f"{p['title']} has no targets but was kept"

def test_dashboard_carries_its_description():
    """The context banner text is the dashboard's own description; nothing else has it."""
    with tempfile.TemporaryDirectory() as tmp:
        for dash in run_real(tmp)["dashboards"]:
            assert dash["description"], f"{dash['uid']} has no description"

def test_dashboard_carries_its_own_variables():
    """A global list cannot say that `pod` belongs only to the software dashboard,
    which is what decides whether the Pod control renders on a tab."""
    with tempfile.TemporaryDirectory() as tmp:
        out = run_real(tmp)
        by_uid = {d["uid"]: {v["name"] for v in d["variables"]} for d in out["dashboards"]}
        assert by_uid["gpu-software"] == {"pod", "gpu"}
        assert by_uid["gpu-hardware-device"] == {"gpu"}
        assert by_uid["gpu-hardware-mig"] == {"gpu", "migid"}

def test_variable_query_is_preserved_verbatim():
    """`pod` is metric-scoped: label_values(<metric>, k8s_pod_name). Dropping the metric
    offers pods that can never appear in an eBPF panel."""
    with tempfile.TemporaryDirectory() as tmp:
        out = run_real(tmp)
        soft = next(d for d in out["dashboards"] if d["uid"] == "gpu-software")
        pod = next(v for v in soft["variables"] if v["name"] == "pod")
        assert pod["query"] == "label_values(ebpf_cuda_kernel_launch_calls_total, k8s_pod_name)"
