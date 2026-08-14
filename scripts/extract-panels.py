#!/usr/bin/env python3
"""Turn checker-verified Grafana dashboards into the UI's panel spec.

The Grafana JSON is the input because scripts/check-dashboards.py already proves it
matches docs-internal/02-metric-catalog.md. Deriving from it means the native UI and
Grafana cannot disagree.

Usage: extract-panels.py <dashboard.json>... -o <panels.json>
"""
import argparse, json, pathlib

# fieldConfig.defaults keys worth carrying to the UI. Anything Grafana-specific
# (custom draw styles, thresholds steps' Grafana colour names) is deliberately dropped.
CARRY = ("unit", "min", "max", "decimals")


def panel_spec(p):
    d = p.get("fieldConfig", {}).get("defaults", {})
    spec = {
        "id": p.get("id"),
        "type": p["type"],
        "title": p.get("title", ""),
        "description": p.get("description", ""),
        "gridPos": p.get("gridPos", {}),
        "targets": [{"expr": t.get("expr", ""), "legendFormat": t.get("legendFormat", "")}
                    for t in p.get("targets", []) if t.get("expr")],
    }
    for k in CARRY:
        if k in d:
            spec[k] = d[k]
    if "transformations" in p:
        spec["transformations"] = p["transformations"]
    if d.get("mappings"):
        spec["mappings"] = d["mappings"]
    return spec


def rows_of(dash):
    """Grafana stores an EXPANDED row's panels as siblings after the row, and a
    COLLAPSED row's panels nested inside it. Normalise both to nested."""
    rows, current = [], None
    for p in dash["panels"]:
        if p.get("type") == "row":
            current = {"title": p.get("title", ""), "collapsed": bool(p.get("collapsed")),
                       "panels": [panel_spec(c) for c in p.get("panels", []) if c.get("targets")]}
            rows.append(current)
        elif current is not None and p.get("targets"):
            current["panels"].append(panel_spec(p))
    return rows


def variables_of(dash):
    """A dashboard's own template variables, in declaration order. The global list is
    deduped across dashboards and so cannot say which dashboard owns which variable."""
    return [{"name": v.get("name"), "query": v.get("query", ""),
             "includeAll": bool(v.get("includeAll")), "multi": bool(v.get("multi"))}
            for v in dash.get("templating", {}).get("list", [])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    dashboards, variables = [], []
    for src in args.sources:
        dash = json.loads(pathlib.Path(src).read_text())
        dashboards.append({"uid": dash.get("uid", ""), "title": dash.get("title", ""),
                           "description": dash.get("description", ""),
                           "variables": variables_of(dash),
                           "rows": rows_of(dash)})
        for v in dash.get("templating", {}).get("list", []):
            if not any(x["name"] == v.get("name") for x in variables):
                variables.append({"name": v.get("name"), "query": v.get("query", ""),
                                  "includeAll": bool(v.get("includeAll")),
                                  "multi": bool(v.get("multi"))})

    out = {"dashboards": dashboards, "variables": variables}
    pathlib.Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False))
    n = sum(len(r["panels"]) for d in dashboards for r in d["rows"])
    print(f"wrote {args.out}: {len(dashboards)} dashboards, {n} panels")


if __name__ == "__main__":
    main()
