import httpx, pytest
from fastapi.testclient import TestClient
from app import main, prometheus


@pytest.fixture
def client(monkeypatch):
    return TestClient(main.app)


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_catalog_reports_the_full_panel_count(client):
    """58 is what scripts/check-dashboards.py verifies against the catalog. If this
    drops, the extractor lost panels and the UI is silently incomplete."""
    body = client.get("/catalog").json()
    n = sum(len(r["panels"]) for d in body["dashboards"] for r in d["rows"])
    assert n == 58, f"expected 58 panels, spec has {n}"
    assert any(v["name"] == "gpu" for v in body["variables"])


def test_query_raises_503_when_prometheus_is_down(client, monkeypatch):
    async def boom(*a, **k):
        raise prometheus.UpstreamError("refused")
    monkeypatch.setattr(prometheus, "query", boom)
    r = client.get("/query", params={"q": "up"})
    assert r.status_code == 503
    assert "unreachable" in r.json()["detail"].lower() or "refused" in r.json()["detail"]


def test_label_values_degrades_to_empty_list_on_failure(client, monkeypatch):
    """A failed sidebar lookup must not 500 the page — quota_api's own split between
    raising and degrading, copied deliberately."""
    async def boom(*a, **k):
        raise prometheus.UpstreamError("refused")
    monkeypatch.setattr(prometheus, "label_values", boom)
    r = client.get("/label/gpu_uuid/values")
    assert r.status_code == 200
    assert r.json() == {"values": [], "error": "refused"}


def test_query_passes_through_result(client, monkeypatch):
    async def ok(*a, **k):
        return {"resultType": "vector", "result": [{"metric": {}, "value": [1, "2"]}]}
    monkeypatch.setattr(prometheus, "query", ok)
    assert client.get("/query", params={"q": "up"}).json()["result"][0]["value"][1] == "2"


def test_label_values_forwards_match_selector(client, monkeypatch):
    """Prometheus scopes a label lookup with match[]; without it the picker offers
    values that no panel on that dashboard can ever produce."""
    seen = {}

    async def fake_get(_client, url, params):
        seen["url"], seen["params"] = url, params
        return ["pod-a"]

    monkeypatch.setattr(prometheus, "_get", fake_get)
    r = client.get("/label/k8s_pod_name/values",
                   params={"match": "ebpf_cuda_kernel_launch_calls_total",
                           "start": 1, "end": 2})
    assert r.status_code == 200
    assert r.json()["values"] == ["pod-a"]
    assert seen["params"]["match[]"] == "ebpf_cuda_kernel_launch_calls_total"


def test_label_values_omits_match_when_absent(client, monkeypatch):
    seen = {}

    async def fake_get(_client, url, params):
        seen["params"] = params
        return []

    monkeypatch.setattr(prometheus, "_get", fake_get)
    client.get("/label/gpu_uuid/values", params={"start": 1, "end": 2})
    assert "match[]" not in seen["params"]
