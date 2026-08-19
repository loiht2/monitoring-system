"""Guards that `kubectl apply -f deploy/` produces a working stack from an empty namespace.

The gap these tests exist for was found by tearing the stack down and reinstalling:
deploy/22-grafana.yaml mounted three dashboard ConfigMaps that no manifest created.
Because the volumes are `optional: true`, Grafana rolled out healthy and served zero
dashboards — nothing in the rollout reported a problem.
"""
import json, pathlib, subprocess, sys

import pytest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"
DASHBOARDS = ROOT / "dashboards"
GRAFANA = DEPLOY / "22-grafana.yaml"


def manifests():
    """Every document in deploy/, excluding optional/ — which `kubectl apply -f deploy/` skips."""
    for path in sorted(DEPLOY.glob("*.yaml")):
        for doc in yaml.safe_load_all(path.read_text()):
            if doc:
                yield path, doc


def defined_configmaps():
    return {d["metadata"]["name"] for _, d in manifests() if d.get("kind") == "ConfigMap"}


def referenced_configmaps():
    """ConfigMaps that pod volumes mount, with the manifest that references each."""
    found = []
    for path, doc in manifests():
        if doc.get("kind") not in ("Deployment", "DaemonSet", "StatefulSet"):
            continue
        for vol in doc["spec"]["template"]["spec"].get("volumes", []):
            cm = vol.get("configMap")
            if cm and cm.get("name"):
                found.append((cm["name"], path.name, cm.get("optional", False)))
    return found


class TestSelfSufficiency:
    def test_every_mounted_configmap_is_created_by_deploy(self):
        """A volume referencing a ConfigMap no manifest creates is the bug this suite exists for.

        `optional: true` makes it silent rather than loud, so only a check like this
        catches it before a cluster does.
        """
        defined = defined_configmaps()
        missing = [(name, src, opt) for name, src, opt in referenced_configmaps()
                   if name not in defined]
        assert not missing, "ConfigMaps mounted but never created by deploy/: " + ", ".join(
            f"{name} (mounted by {src}, optional={opt})" for name, src, opt in missing)

    def test_grafana_mounts_one_configmap_per_dashboard(self):
        """Adding a dashboard without wiring its volume would leave it invisible in Grafana."""
        mounted = {n for n, _, _ in referenced_configmaps() if n.startswith("grafana-dashboard-gpu")}
        expected = {f"grafana-dashboard-{p.stem}" for p in DASHBOARDS.glob("*.json")}
        assert mounted == expected, f"mounted {sorted(mounted)} != dashboards {sorted(expected)}"


class TestGeneratedDashboardsInSync:
    """The dashboard ConfigMaps are spliced into 22-grafana.yaml below a generated marker."""

    def test_spliced_region_matches_dashboards(self, tmp_path):
        """The committed manifest must equal a fresh splice from dashboards/*.json."""
        copy = tmp_path / "22-grafana.yaml"
        copy.write_text(GRAFANA.read_text())
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/gen-dashboard-configmaps.py"),
             *[str(p) for p in sorted(DASHBOARDS.glob("*.json"))], "--into", str(copy)],
            check=True, capture_output=True)
        assert copy.read_text() == GRAFANA.read_text(), (
            "deploy/22-grafana.yaml is stale — regenerate it:\n"
            "  python3 scripts/gen-dashboard-configmaps.py dashboards/*.json "
            "--into deploy/22-grafana.yaml")

    def test_splicing_is_idempotent(self, tmp_path):
        """A second run must replace the generated region, never append a second copy."""
        copy = tmp_path / "22-grafana.yaml"
        copy.write_text(GRAFANA.read_text())
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/gen-dashboard-configmaps.py"),
             *[str(p) for p in sorted(DASHBOARDS.glob("*.json"))], "--into", str(copy)],
            check=True, capture_output=True)
        once = copy.read_text()
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/gen-dashboard-configmaps.py"),
             *[str(p) for p in sorted(DASHBOARDS.glob("*.json"))], "--into", str(copy)],
            check=True, capture_output=True)
        # Byte equality, not document count: a stray `---` left behind each run parses as
        # an empty document, so counting kinds would not have caught the file growing.
        assert copy.read_text() == once, "re-splicing changed the file; the generator is not idempotent"
        docs = [(d["kind"], d["metadata"]["name"]) for d in yaml.safe_load_all(once) if d]
        assert len(docs) == len(set(docs)), f"duplicated documents: {docs}"

    def test_each_configmap_holds_parseable_dashboard_json(self):
        """A ConfigMap whose payload is not valid JSON leaves Grafana with an empty folder."""
        found = 0
        for doc in yaml.safe_load_all(GRAFANA.read_text()):
            if not doc or not doc["metadata"]["name"].startswith("grafana-dashboard-gpu"):
                continue
            for key, body in doc["data"].items():
                panels = json.loads(body)
                assert key.endswith(".json")
                assert panels.get("panels"), f"{key} has no panels"
                found += 1
        assert found == len(list(DASHBOARDS.glob("*.json"))), f"only {found} dashboards spliced"


class TestPrometheusUniqueness:
    def test_applied_directory_defines_one_prometheus(self):
        """Two Prometheus objects of the same name in one directory: the later silently wins.

        optional/prometheus-storage.yaml is the storage variant and is applied instead of
        21-prometheus.yaml, which is why `kubectl apply -f deploy/` must not be recursive.
        """
        names = [d["metadata"]["name"] for _, d in manifests() if d.get("kind") == "Prometheus"]
        assert len(names) == len(set(names)) and len(names) == 1, f"Prometheus objects: {names}"
