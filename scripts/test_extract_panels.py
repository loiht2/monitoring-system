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
