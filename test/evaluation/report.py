"""Metric inventory and the evaluation report.

Derives the inventory from panels.json so it cannot drift from the dashboards, then
classifies every (metric, entity) against the phase windows recorded by run.sh.
See 14 §1 for the three outcomes and 14 §5 for the harness contract.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

METRIC_RE = re.compile(r'\b(ebpf_[a-z0-9_]+|DCGM_FI_[A-Z0-9_]+|nvml_[a-z0-9_]+|gpu_alloc_[a-z0-9_]+)\b')

HERE = Path(__file__).resolve().parent


def _repo_root(start: Path) -> Path:
    """Walk up to the directory that owns `dashboards/`.

    Resolved by marker rather than by a fixed number of `.parent` hops: this file has
    already moved once (test/evaluation/ -> test/evaluation/), and a hop count silently
    resolves to the wrong directory when that happens.
    """
    for d in (start, *start.parents):
        if (d / "dashboards").is_dir():
            return d
    return start.parent


ROOT = _repo_root(HERE)
PANELS_PATH = ROOT / "services" / "advanced-monitoring-api" / "app" / "panels.json"
METRICS_PATH = HERE / "metrics.json"
PHASES_PATH = HERE / "phases.jsonl"
REPORT_JSON = HERE / "report.json"

# A phase whose Job never reached Running has no window at all; its verdict would be a
# statement about the harness, not about the metric. 14 §5.1.
USABLE_STATUSES = ("COMPLETE", "FAILED")


def metrics_from_panels(panels: dict) -> dict:
    """{metric_name: [dashboard_uid, ...]} for every metric any panel plots."""
    out: dict = {}
    for dash in panels["dashboards"]:
        for row in dash["rows"]:
            for panel in row["panels"]:
                for target in panel.get("targets", []):
                    for name in METRIC_RE.findall(target["expr"]):
                        out.setdefault(name, set()).add(dash["uid"])
    return {k: sorted(v) for k, v in sorted(out.items())}


def classify(samples: list, support: float | None) -> tuple[str, float | None]:
    """One (metric, entity) verdict. See 14 §1.

    UNSUPPORTED requires an explicit 0 verdict. A missing verdict is UNVERIFIED, never
    UNSUPPORTED — the whole point is to separate "cannot" from "did not", and guessing
    re-creates the ambiguity. support==1 with no sample is also UNVERIFIED: the metric
    can produce data and did not, which is unexplained.
    """
    if samples:
        return "OBSERVED", max(float(v) for _, v in samples)
    if support == 0.0:
        return "UNSUPPORTED", None
    return "UNVERIFIED", None


# --------------------------------------------------------------------------- queries

class Prom:
    """The Prometheus HTTP API, kept to the two calls the classification needs."""

    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def _get(self, path: str, params: dict) -> list:
        query = urllib.parse.urlencode(params)
        with urllib.request.urlopen(f"{self.url}{path}?{query}", timeout=60) as fh:
            body = json.load(fh)
        if body.get("status") != "success":
            raise RuntimeError(f"prometheus {path}: {body.get('error')}")
        return body["data"]["result"]

    def query(self, expr: str, at: int | None = None) -> list:
        params = {"query": expr}
        if at is not None:
            params["time"] = at
        return self._get("/api/v1/query", params)

    def query_range(self, expr: str, start: int, end: int, step: int) -> list:
        return self._get("/api/v1/query_range",
                         {"query": expr, "start": start, "end": end, "step": step})


def discover_prometheus() -> str:
    """PROM_URL if set, else the prometheus pod's IP. There is no stable Service here:
    `prometheus-operated` is headless, so a ClusterIP name does not resolve off-cluster."""
    if os.environ.get("PROM_URL"):
        return os.environ["PROM_URL"]
    ip = subprocess.run(
        ["kubectl", "get", "pod", "-n", "gpu-monitoring",
         "-l", "app.kubernetes.io/name=prometheus",
         "-o", "jsonpath={.items[0].status.podIP}"],
        capture_output=True, text=True, check=True).stdout.strip()
    if not ip:
        raise RuntimeError("no prometheus pod found; set PROM_URL")
    return f"http://{ip}:9090"


# --------------------------------------------------------------------------- entities

def entity_key(labels: dict) -> tuple[str, str]:
    """An entity is (gpu_uuid, GPU_I_ID) — 10 §2. A whole card and a MIG instance are
    different things to ask about. Metrics that carry neither label (the eBPF families
    are per-process, not per-device) collapse into one nameless entity, which is the
    honest shape: there is no per-GPU claim to make about them."""
    return (labels.get("gpu_uuid", "") or labels.get("UUID", ""), labels.get("GPU_I_ID", ""))


def entity_label(key: tuple[str, str]) -> str:
    uuid, inst = key
    if not uuid:
        return "(no entity labels)"
    short = uuid[:12] + "…"
    return f"{short} GPU_I_ID={inst}" if inst else f"{short} (device)"


# --------------------------------------------------------------------------- evaluation

def support_verdicts(prom: Prom, at: int | None) -> dict:
    """{metric: {entity: 0.0|1.0}} from one query. Absent means no verdict — which is
    UNVERIFIED, never UNSUPPORTED (10 §1)."""
    out: dict = {}
    for series in prom.query("gpu_metric_supported", at):
        name = series["metric"].get("metric")
        if name:
            out.setdefault(name, {})[entity_key(series["metric"])] = float(series["value"][1])
    return out


def evaluate(prom: Prom, metrics: list, phases: list, step: int = 15) -> dict:
    """Classify every (metric, entity) over every recorded phase window."""
    windows = [p for p in phases if p["status"] in USABLE_STATUSES]
    latest = max((p["t1"] for p in windows), default=None)
    support = support_verdicts(prom, latest)

    results = {}
    for metric in metrics:
        seen: dict = {}      # entity -> [(ts, value), ...]
        where: dict = {}     # entity -> [phase, ...]
        for phase in windows:
            try:
                series = prom.query_range(metric, phase["t0"], phase["t1"], step)
            except Exception as exc:                      # noqa: BLE001 - reported, not raised
                results.setdefault("_errors", []).append(f"{metric} @ {phase['phase']}: {exc}")
                continue
            for s in series:
                key = entity_key(s["metric"])
                if s["values"]:
                    seen.setdefault(key, []).extend(s["values"])
                    if phase["phase"] not in where.setdefault(key, []):
                        where[key].append(phase["phase"])

        sup = support.get(metric, {})
        entities = sorted(set(seen) | set(sup)) or [("", "")]
        rows = []
        for key in entities:
            verdict, peak = classify(seen.get(key, []), sup.get(key))
            rows.append({"entity": entity_label(key), "gpu_uuid": key[0], "gpu_i_id": key[1],
                         "verdict": verdict, "peak": peak,
                         "phases": where.get(key, []),
                         "supported": sup.get(key)})
        verdicts = {r["verdict"] for r in rows}
        # A metric OBSERVED on any entity in any phase is OBSERVED overall; the claim is
        # that it responds to a workload built to drive it, not that every entity ran one.
        if "OBSERVED" in verdicts:
            overall = "OBSERVED"
        elif verdicts == {"UNSUPPORTED"}:
            overall = "UNSUPPORTED"
        else:
            overall = "UNVERIFIED"
        results[metric] = {"verdict": overall, "entities": rows}
    return results


# --------------------------------------------------------------------------- rendering

def render_markdown(results: dict, phases: list, mig_note: str) -> str:
    errors = results.get("_errors", [])
    metrics = {k: v for k, v in results.items() if not k.startswith("_")}
    tally = {v: 0 for v in ("OBSERVED", "UNSUPPORTED", "UNVERIFIED")}
    for r in metrics.values():
        tally[r["verdict"]] += 1

    ran = [p for p in phases if p["status"] in USABLE_STATUSES]
    failed = [p for p in phases if p["status"] == "ERROR"]

    out = ["# Metric evaluation report", ""]
    out += [f"{len(metrics)} metrics classified over {len(ran)} phase windows "
            f"({len(failed)} phases could not run).", ""]
    out += ["| Verdict | Count |", "|---|---|"]
    for v in ("OBSERVED", "UNSUPPORTED", "UNVERIFIED"):
        out.append(f"| {v} | {tally[v]} |")
    out += ["",
            "UNSUPPORTED is a pass: the system correctly knows it cannot produce the metric.",
            "UNVERIFIED is the defect class — no sample and no support verdict, so a hardware",
            "limit cannot be told from a broken exporter (14 §1).", ""]

    out += ["## Coverage limits", "", mig_note, "",
            "No expected value is asserted anywhere below. The claim is that a metric responds",
            "to a workload built to drive it, not that it reaches a number (14 §5.1).", ""]

    if failed:
        out += ["## Phases that could not run", "",
                "| Phase | Status | Why |", "|---|---|---|"]
        out += [f"| {p['phase']} | {p['status']} | {p.get('note', '')} |" for p in failed]
        out.append("")

    nonzero = [p for p in phases if p["status"] == "FAILED"]
    if nonzero:
        out += ["## Phases that ran and exited non-zero", "",
                "These have real windows and their samples count. Recorded, not retried.", "",
                "| Phase | Exit | Note |", "|---|---|---|"]
        out += [f"| {p['phase']} | {p.get('exit_code')} | {p.get('note', '')} |" for p in nonzero]
        out.append("")

    if errors:
        out += ["## Query failures", ""] + [f"- `{e}`" for e in errors] + [""]

    out += ["## Verdicts", ""]
    for name, r in sorted(metrics.items()):
        out.append(f"### {name} — {r['verdict']}")
        out.append("")
        for e in r["entities"]:
            bits = [f"`{e['entity']}`", f"**{e['verdict']}**"]
            if e["peak"] is not None:
                bits.append(f"peak {e['peak']:.6g}")
            if e["verdict"] == "UNSUPPORTED":
                bits.append("gpu_metric_supported=0")
            if e["verdict"] == "UNVERIFIED":
                bits.append("no sample" +
                            (", support=1" if e["supported"] == 1.0 else ", no support verdict"))
            if e["phases"]:
                bits.append("phases: " + ", ".join(e["phases"][:6]))
            out.append("- " + " · ".join(bits))
        out.append("")
    return "\n".join(out)


def load_phases(path: Path, only: str | None) -> list:
    phases = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if only:
        phases = [p for p in phases if p["phase"] == only or p["mode"] == only]
    return phases


def mig_coverage_note(phases: list) -> str:
    """What MIG coverage the recorded phases actually bought. Derived, not asserted:
    the layout changes under `--repartition`, and a hardcoded sentence about "the one
    instance" silently becomes false the moment it does."""
    mig = [p for p in phases if p["target"].startswith("mig")]
    usable = [p for p in mig if p["status"] in USABLE_STATUSES]
    per_inst: dict = {}
    for p in usable:
        per_inst.setdefault(p.get("gpu_i_id") or "unattributed", set()).add(p["mode"])
    if not per_inst:
        return ("No MIG phase in this run produced a usable window, so every per-instance "
                f"verdict below rests on earlier runs. {len(mig)} MIG phases were attempted.")
    breakdown = ", ".join(f"GPU_I_ID={k}: {len(v)} modes"
                          for k, v in sorted(per_inst.items()))
    return (f"MIG phases ran against {len(per_inst)} instance(s) — {breakdown}. A single "
            "instance cannot distinguish a per-instance metric from one aggregated over the "
            "card (14 §4.5); coverage is only as wide as the instances listed here. "
            f"{len(usable)} of {len(mig)} MIG phases produced a usable window.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit-inventory", action="store_true",
                        help="write the metric inventory derived from panels.json as JSON to stdout")
    parser.add_argument("--panels", type=Path, default=PANELS_PATH,
                        help=f"path to panels.json (default: {PANELS_PATH})")
    parser.add_argument("--metrics", type=Path, default=METRICS_PATH)
    parser.add_argument("--phases", type=Path, default=PHASES_PATH)
    parser.add_argument("--phase", default=None,
                        help="classify against one phase (or one mode) only")
    parser.add_argument("--json-out", type=Path, default=REPORT_JSON)
    parser.add_argument("--step", type=int, default=15, help="query_range step, seconds")
    args = parser.parse_args()

    if args.emit_inventory:
        with args.panels.open() as fh:
            panels = json.load(fh)
        print(json.dumps(metrics_from_panels(panels), indent=2))
        return

    metrics = json.loads(args.metrics.read_text())
    if isinstance(metrics, dict):
        metrics = sorted(metrics)
    phases = load_phases(args.phases, args.phase)
    if not phases:
        parser.error(f"no phases in {args.phases}"
                     + (f" matching {args.phase}" if args.phase else ""))

    prom = Prom(discover_prometheus())
    results = evaluate(prom, metrics, phases, args.step)
    args.json_out.write_text(json.dumps(
        {"phases": phases, "metrics": {k: v for k, v in results.items()
                                       if not k.startswith("_")},
         "query_errors": results.get("_errors", [])}, indent=2) + "\n")
    print(render_markdown(results, phases, mig_coverage_note(phases)))

    # A run that leaves any metric UNVERIFIED fails: that is precisely the state that can
    # hide for months behind a blank panel (14 §5).
    unverified = [m for m, r in results.items()
                  if not m.startswith("_") and r["verdict"] == "UNVERIFIED"]
    if unverified:
        print(f"\n{len(unverified)} metric(s) UNVERIFIED: {', '.join(unverified)}",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
