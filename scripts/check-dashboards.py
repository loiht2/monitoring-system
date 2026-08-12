#!/usr/bin/env python3
"""Enforce the catalog contract on dashboard JSON. Usage: check-dashboards.py <file>..."""
import json, re, sys, itertools

def leaves(panels):
    for p in panels:
        if p.get("type") == "row":
            yield from leaves(p.get("panels", []))
        else:
            yield p

def metric_names(dash):
    names = set()
    for p in leaves(dash["panels"]):
        for t in p.get("targets", []):
            names |= set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*(?:_total|_bytes|_seconds|_ratio|_active|"
                                    r"_hertz|_watts|_celsius|_info|_supported)\b", t.get("expr", "")))
            names |= set(re.findall(r"\bDCGM_FI_[A-Z0-9_]+\b", t.get("expr", "")))
    return names

def check(paths):
    fail = []
    dashes = {p: json.load(open(p)) for p in paths}
    shared = {}
    for path, d in dashes.items():
        ls = list(leaves(d["panels"]))
        for p in ls:
            if not p.get("title"):
                fail.append(f"{path}: panel id={p.get('id')} has no title")
            if not p.get("description"):
                fail.append(f"{path}: '{p.get('title')}' has no description")
        # (b) no title is a metric name
        for p in ls:
            if p.get("title") in metric_names(d):
                fail.append(f"{path}: title '{p['title']}' is a metric name")
        # (d) no overlapping panels, per layer
        layers = [d["panels"]] + [r.get("panels", []) for r in d["panels"] if r.get("type") == "row"]
        for layer in layers:
            for a, b in itertools.combinations([p for p in layer if p.get("type") != "row"], 2):
                ga, gb = a["gridPos"], b["gridPos"]
                if (ga["x"] < gb["x"] + gb["w"] and gb["x"] < ga["x"] + ga["w"]
                        and ga["y"] < gb["y"] + gb["h"] and gb["y"] < ga["y"] + ga["h"]):
                    fail.append(f"{path}: '{a['title']}' overlaps '{b['title']}'")
        # (c) collect shared descriptions, keyed by title AND the metrics behind it.
        # Two panels may share a title while querying different fields -- MIG's
        # "GPU Utilization" is GR_ENGINE_ACTIVE, the device's is NVML's utilization
        # rate. Forcing those to match would make one description describe a metric
        # its panel does not query, so only same-metric panels are compared.
        for p in ls:
            key = (p["title"], frozenset(
                itertools.chain.from_iterable(
                    re.findall(r"\bDCGM_FI_[A-Z0-9_]+\b|\bnvml_[a-z0-9_]+\b|\bgpu_[a-z0-9_]+\b",
                               t.get("expr", "")) for t in p.get("targets", []))))
            shared.setdefault(key, {})[path] = p["description"]
        # (e) MIG panels must filter to instances
        if "mig" in path:
            for p in ls:
                exprs = " ".join(t.get("expr", "") for t in p.get("targets", []))
                if exprs and 'GPU_I_ID!=""' not in exprs and 'mig_uuid!=""' not in exprs:
                    fail.append(f"{path}: '{p['title']}' is not filtered to MIG instances")
        # (g) NVML is retired from the hardware dashboards except for the three
        # panels the catalog keeps on it, because DCGM has no equivalent field.
        NVML_OK = {"GPU Utilization per Pod", "Memory Held by Each Pod", "Clocks Throttle Reasons"}
        if "hardware" in path:
            for p in ls:
                exprs = " ".join(t.get("expr", "") for t in p.get("targets", []))
                if "nvml_" in exprs and p["title"] not in NVML_OK:
                    fail.append(f"{path}: '{p['title']}' uses nvml_* but is not one of the three "
                                f"panels DCGM cannot supply")
        # (f) no HAMi metrics anywhere
        for p in ls:
            for t in p.get("targets", []):
                if "GPUDevice" in t.get("expr", ""):
                    fail.append(f"{path}: '{p['title']}' references a GPUDevice* metric")
    # (c) shared titles must have identical descriptions
    for (title, _metrics), byfile in shared.items():
        if len(byfile) > 1 and len(set(byfile.values())) > 1:
            fail.append(f"description for '{title}' differs across dashboards")
    return fail

if __name__ == "__main__":
    problems = check(sys.argv[1:])
    for p in problems:
        print("FAIL:", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)
