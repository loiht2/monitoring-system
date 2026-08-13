# Advanced Monitoring UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commit policy.** `CLAUDE.md` states *"Do not automatically commit until I approve."* Each "Commit" step
> means stage, show the diff, and ask. Messages carry no AI co-author trailer.

**Goal:** A native web UI for this system's GPU metrics, so operators no longer need Grafana, deployable
later into the ML Platform as two microservices.

**Architecture:** Panels are data. An extractor turns the checker-verified Grafana JSON into `panels.json`; a
FastAPI service serves that spec and proxies Prometheus; a Next.js UI renders it with seven generic
renderers. Adding a metric stays a catalog edit.

**Tech Stack:** FastAPI + httpx + pytest; Next.js 15 + React 19 + Chart.js + vitest; python3 for the
extractor.

**Spec:** [12 — Advanced monitoring UI](../12-monitoring-ui.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/extract-panels.py` | Grafana JSON → `panels.json`. Pure transform, no I/O beyond read/write |
| `services/advanced-monitoring-api/app/prometheus.py` | httpx calls to Prometheus. No FastAPI types |
| `services/advanced-monitoring-api/app/catalog.py` | Loads and serves `panels.json` |
| `services/advanced-monitoring-api/app/main.py` | FastAPI app, routes, error mapping |
| `services/advanced-monitoring-api/tests/` | pytest suite |
| `services/advanced-monitoring-ui/lib/promql.ts` | `$gpu` substitution, step derivation. Pure |
| `services/advanced-monitoring-ui/lib/api.ts` | Fetch wrapper against the API service |
| `services/advanced-monitoring-ui/components/panels/*.tsx` | One file per renderer |
| `services/advanced-monitoring-ui/app/page.tsx` | Overview page |
| `deploy/a30-node/70-advanced-monitoring.yaml` | Both Deployments + ClusterIP Services |

`panels.json` is generated into `services/advanced-monitoring-api/app/panels.json` so the API image carries
it — the same way `quota_api` embeds its `monitoring_assets/`.

---

### Task 1: The panel extractor

**Files:**
- Create: `scripts/extract-panels.py`
- Create: `scripts/test_extract_panels.py`

- [ ] **Step 1: Write the failing test**

`scripts/test_extract_panels.py`:

```python
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
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /home/ubuntu/loiht2/my-projects/monitoring-system/.worktrees/phase-4-mig
python3 -m pytest scripts/test_extract_panels.py -q
```

Expected: FAIL — `scripts/extract-panels.py` does not exist, so `subprocess.run(..., check=True)` raises.

- [ ] **Step 3: Write the extractor**

`scripts/extract-panels.py`:

```python
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sources", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    dashboards, variables = [], []
    for src in args.sources:
        dash = json.loads(pathlib.Path(src).read_text())
        dashboards.append({"uid": dash.get("uid", ""), "title": dash.get("title", ""),
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
```

- [ ] **Step 4: Run the test to see it pass**

```bash
python3 -m pytest scripts/test_extract_panels.py -q
```

Expected: `5 passed`.

- [ ] **Step 5: Generate the real spec and check the count**

```bash
mkdir -p services/advanced-monitoring-api/app
python3 scripts/extract-panels.py dashboards/gpu-hardware-device.json \
  dashboards/gpu-hardware-mig.json dashboards/gpu-software.json \
  -o services/advanced-monitoring-api/app/panels.json
```

Expected: `wrote …: 3 dashboards, 58 panels`. **58 is the number the checker verifies against the catalog.**
Anything less means a row was missed — most likely the expanded/collapsed asymmetry.

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-panels.py scripts/test_extract_panels.py services/advanced-monitoring-api/app/panels.json
# suggested message: "extract a ui panel spec from the grafana dashboards"
```

---

### Task 2: Prometheus client

**Files:**
- Create: `services/advanced-monitoring-api/app/prometheus.py`
- Create: `services/advanced-monitoring-api/tests/test_prometheus.py`
- Create: `services/advanced-monitoring-api/requirements.txt`

- [ ] **Step 1: Write requirements**

`services/advanced-monitoring-api/requirements.txt`:

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
httpx==0.28.1
pytest==8.3.4
pytest-asyncio==0.25.0
```

- [ ] **Step 2: Write the failing test**

`services/advanced-monitoring-api/tests/test_prometheus.py`:

```python
import httpx, pytest
from app import prometheus


def client_returning(payload, status=200):
    def handler(request):
        return httpx.Response(status, json=payload)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_instant_query_returns_result_vector():
    async with client_returning({"status": "success",
                                 "data": {"resultType": "vector",
                                          "result": [{"metric": {"gpu": "0"}, "value": [1, "0.5"]}]}}) as c:
        got = await prometheus.query(c, "http://p:9090", "up")
        assert got["result"][0]["value"][1] == "0.5"


@pytest.mark.asyncio
async def test_range_query_serializes_step_with_seconds_suffix():
    """Prometheus rejects a bare integer step on some versions; quota_api learned this
    the hard way and formats it as '<n>s'."""
    seen = {}

    def handler(request):
        seen["step"] = request.url.params.get("step")
        return httpx.Response(200, json={"status": "success", "data": {"result": []}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        await prometheus.query_range(c, "http://p:9090", "up", 100, 200, 30)
    assert seen["step"] == "30s"


@pytest.mark.asyncio
async def test_upstream_error_status_raises_upstream_error():
    async with client_returning({"status": "error", "error": "bad query"}, status=400) as c:
        with pytest.raises(prometheus.UpstreamError):
            await prometheus.query(c, "http://p:9090", "((")


@pytest.mark.asyncio
async def test_connect_failure_raises_upstream_error():
    def handler(request):
        raise httpx.ConnectError("refused")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(prometheus.UpstreamError):
            await prometheus.query(c, "http://p:9090", "up")


@pytest.mark.asyncio
async def test_label_values_returns_list():
    async with client_returning({"status": "success", "data": ["GPU-a", "GPU-b"]}) as c:
        assert await prometheus.label_values(c, "http://p:9090", "gpu_uuid") == ["GPU-a", "GPU-b"]
```

- [ ] **Step 3: Run it to see it fail**

```bash
cd services/advanced-monitoring-api
python3 -m pytest tests/test_prometheus.py -q
```

Expected: FAIL — `ModuleNotFoundError: No module named 'app'`.

- [ ] **Step 4: Write the client**

`services/advanced-monitoring-api/app/prometheus.py`:

```python
"""Thin async wrapper over the Prometheus HTTP API.

Deliberately free of FastAPI types so it is testable with httpx.MockTransport and
reusable if this service is ever folded into another app.
"""
import httpx


class UpstreamError(Exception):
    """Prometheus was unreachable, or answered with an error."""


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict:
    try:
        r = await client.get(url, params=params, timeout=30.0)
    except httpx.HTTPError as exc:
        raise UpstreamError(f"Prometheus unreachable: {exc}") from exc
    if r.status_code >= 400:
        raise UpstreamError(f"Prometheus returned {r.status_code}: {r.text[:200]}")
    body = r.json()
    if body.get("status") != "success":
        raise UpstreamError(body.get("error", "unknown Prometheus error"))
    return body.get("data", {})


async def query(client, base: str, q: str, time: float | None = None) -> dict:
    params = {"query": q}
    if time is not None:
        params["time"] = time
    return await _get(client, f"{base}/api/v1/query", params)


async def query_range(client, base: str, q: str, start: float, end: float, step: int) -> dict:
    # step MUST carry the unit suffix — a bare integer is rejected by some versions.
    return await _get(client, f"{base}/api/v1/query_range",
                      {"query": q, "start": start, "end": end, "step": f"{step}s"})


async def label_values(client, base: str, label: str,
                       start: float | None = None, end: float | None = None) -> list:
    """Values seen for a label, optionally scoped to a time window.

    Unscoped, Prometheus answers from the whole retention window, so a device removed
    days ago is still listed.
    """
    params: dict = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    data = await _get(client, f"{base}/api/v1/label/{label}/values", params)
    return data if isinstance(data, list) else []
```

- [ ] **Step 5: Run the test to see it pass**

```bash
python3 -m pytest tests/test_prometheus.py -q
```

Expected: `5 passed`.

- [ ] **Step 6: Commit**

```bash
git add services/advanced-monitoring-api/
# suggested message: "add prometheus client for the monitoring api"
```

---

### Task 3: API routes

**Files:**
- Create: `services/advanced-monitoring-api/app/catalog.py`
- Create: `services/advanced-monitoring-api/app/main.py`
- Create: `services/advanced-monitoring-api/tests/test_routes.py`

- [ ] **Step 1: Write the failing test**

`services/advanced-monitoring-api/tests/test_routes.py`:

```python
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
```

- [ ] **Step 2: Run it to see it fail**

```bash
python3 -m pytest tests/test_routes.py -q
```

Expected: FAIL — `No module named 'app.main'`.

- [ ] **Step 3: Write the catalog loader**

`services/advanced-monitoring-api/app/catalog.py`:

```python
"""Serves the panel spec generated by scripts/extract-panels.py.

Loaded once at import. The spec is baked into the image, so a change means a rebuild —
the same trade quota_api makes with its monitoring_assets/.
"""
import json, pathlib

_PATH = pathlib.Path(__file__).parent / "panels.json"


def load() -> dict:
    if not _PATH.exists():
        return {"dashboards": [], "variables": [], "error": "panels.json missing from image"}
    return json.loads(_PATH.read_text())


SPEC = load()
```

- [ ] **Step 4: Write the app**

`services/advanced-monitoring-api/app/main.py`:

```python
"""advanced-monitoring-api — Prometheus proxy + panel spec for the native GPU UI.

Route error policy, copied from the ML Platform's quota_api on purpose:
  /query, /query_range  RAISE on upstream failure — the user asked for this data.
  /catalog, /label/...  DEGRADE to an empty payload with HTTP 200 — a failed sidebar
                        lookup should render an empty control, not break the page.
"""
import os
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app import catalog, prometheus

PROMETHEUS_URL = os.environ.get(
    "PROMETHEUS_URL", "http://prometheus-operated.gpu-monitoring.svc.cluster.local:9090")

app = FastAPI(title="advanced-monitoring-api")

# The UI is a separate origin during local development (3002 vs 8000). In-cluster the
# UI proxies server-side, so this is a dev convenience, not the production path.
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:3002"], allow_methods=["GET"],
    allow_headers=["*"])

_client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def _startup():
    global _client
    _client = httpx.AsyncClient()


@app.on_event("shutdown")
async def _shutdown():
    if _client:
        await _client.aclose()


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/catalog")
async def get_catalog():
    return catalog.SPEC


@app.get("/query")
async def get_query(q: str = Query(...), time: float | None = None):
    try:
        return await prometheus.query(_client, PROMETHEUS_URL, q, time)
    except prometheus.UpstreamError as exc:
        raise HTTPException(503, str(exc))


@app.get("/query_range")
async def get_query_range(q: str = Query(...), start: float = Query(...),
                          end: float = Query(...), step: int = 60):
    try:
        return await prometheus.query_range(_client, PROMETHEUS_URL, q, start, end, step)
    except prometheus.UpstreamError as exc:
        raise HTTPException(503, str(exc))


@app.get("/label/{name}/values")
async def get_label_values(name: str, start: float | None = None, end: float | None = None):
    try:
        return {"values": await prometheus.label_values(
            _client, PROMETHEUS_URL, name, start=start, end=end)}
    except prometheus.UpstreamError as exc:
        return {"values": [], "error": str(exc)}
```

- [ ] **Step 5: Run the tests to see them pass**

```bash
python3 -m pytest tests/ -q
```

Expected: `10 passed`. If `test_catalog_reports_the_full_panel_count` fails, re-run Task 1 Step 5 — the
image's `panels.json` is stale.

- [ ] **Step 6: Run it against the real cluster**

```bash
kubectl -n gpu-monitoring port-forward svc/prometheus-operated 9090:9090 &
PROMETHEUS_URL=http://127.0.0.1:9090 python3 -m uvicorn app.main:app --port 8000 &
sleep 3
curl -s 'http://127.0.0.1:8000/query?q=count(DCGM_FI_DEV_FB_USED)' | head -c 200; echo
curl -s 'http://127.0.0.1:8000/label/gpu_uuid/values'
```

Expected: a real vector result, and two GPU UUIDs.

- [ ] **Step 7: Commit**

```bash
git add services/advanced-monitoring-api/
# suggested message: "add the monitoring api service"
```

---

### Task 4: PromQL helpers in the UI

The two pure functions the whole UI depends on. Tested first because everything else builds on them.

**Files:**
- Create: `services/advanced-monitoring-ui/lib/promql.ts`
- Create: `services/advanced-monitoring-ui/lib/promql.test.ts`
- Create: `services/advanced-monitoring-ui/package.json`

- [ ] **Step 1: Write package.json**

`services/advanced-monitoring-ui/package.json`:

```json
{
  "name": "advanced-monitoring-ui",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3002",
    "build": "next build",
    "start": "next start -p 3002",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "chart.js": "^4.4.0",
    "next": "^15.5.18",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

`services/advanced-monitoring-ui/lib/promql.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { substituteVars, deriveStep } from './promql';

describe('substituteVars', () => {
  it('replaces $gpu with a regex alternation of the selection', () => {
    expect(substituteVars('DCGM_FI_DEV_FB_USED{gpu_uuid=~"$gpu"}', { gpu: ['GPU-a', 'GPU-b'] }))
      .toBe('DCGM_FI_DEV_FB_USED{gpu_uuid=~"GPU-a|GPU-b"}');
  });

  it('replaces an empty or All selection with .* so the panel shows everything', () => {
    expect(substituteVars('x{gpu_uuid=~"$gpu"}', { gpu: [] })).toBe('x{gpu_uuid=~".*"}');
    expect(substituteVars('x{gpu_uuid=~"$gpu"}', { gpu: ['All'] })).toBe('x{gpu_uuid=~".*"}');
  });

  it('escapes regex metacharacters in values so a UUID cannot alter the query', () => {
    expect(substituteVars('x{u=~"$gpu"}', { gpu: ['a.b+c'] })).toBe('x{u=~"a\\.b\\+c"}');
  });

  it('leaves an expression with no variable untouched', () => {
    expect(substituteVars('up', { gpu: ['GPU-a'] })).toBe('up');
  });

  it('replaces every occurrence, not just the first', () => {
    expect(substituteVars('a{u=~"$gpu"} + b{u=~"$gpu"}', { gpu: ['g'] }))
      .toBe('a{u=~"g"} + b{u=~"g"}');
  });
});

describe('deriveStep', () => {
  it('keeps a range near 200 points', () => {
    expect(deriveStep(3600)).toBe(18);      // 1h  -> 200 points
    expect(deriveStep(300)).toBe(1);        // 5m  -> floor is 1s
    expect(deriveStep(604800)).toBe(3024);  // 7d
  });

  it('never returns zero, which Prometheus rejects', () => {
    expect(deriveStep(1)).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
cd services/advanced-monitoring-ui && npm install && npm test
```

Expected: FAIL — cannot resolve `./promql`.

- [ ] **Step 4: Write the helpers**

`services/advanced-monitoring-ui/lib/promql.ts`:

```ts
/** Template-variable substitution and range-step derivation.
 *
 * The panel spec stores Grafana's expressions verbatim, including `$gpu`. Substituting
 * here — immediately before the request — keeps the stored spec byte-identical to the
 * Grafana source it was extracted from.
 */

/** Escape a label value so it cannot change the meaning of the surrounding regex. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function substituteVars(expr: string, vars: Record<string, string[]>): string {
  let out = expr;
  for (const [name, values] of Object.entries(vars)) {
    const selected = values.filter((v) => v !== 'All');
    // Empty or "All" means every series — `.*` rather than an empty alternation,
    // which would match only the empty string and silently blank the panel.
    const repl = selected.length ? selected.map(escapeRe).join('|') : '.*';
    out = out.split(`$${name}`).join(repl);
  }
  return out;
}

/** Pick a step that keeps a range query near 200 points, so wide ranges stay cheap. */
export function deriveStep(rangeSeconds: number, targetPoints = 200): number {
  return Math.max(1, Math.floor(rangeSeconds / targetPoints));
}
```

- [ ] **Step 5: Run the test to see it pass**

```bash
npm test
```

Expected: `7 passed`.

- [ ] **Step 6: Commit**

```bash
git add services/advanced-monitoring-ui/
# suggested message: "add promql helpers for the monitoring ui"
```

---

### Task 5: UI scaffold and API client

**Files:**
- Create: `services/advanced-monitoring-ui/tsconfig.json`, `next.config.js`, `app/layout.tsx`, `app/globals.css`
- Create: `services/advanced-monitoring-ui/lib/api.ts`

- [ ] **Step 1: Write the config files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "ES2022"], "allowJs": false,
    "skipLibCheck": true, "strict": true, "noEmit": true, "esModuleInterop": true,
    "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true,
    "isolatedModules": true, "jsx": "preserve", "incremental": true,
    "plugins": [{ "name": "next" }], "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.js`:

```js
/** @type {import('next').NextConfig} */
module.exports = { output: 'standalone' };
```

- [ ] **Step 2: Write the theme**

`app/globals.css` — the ML Platform admin vocabulary, so a later merge is a file move:

```css
:root {
  --bg-dark: #0f1219;
  --bg-panel: #161b22;
  --bg-panel-light: #1f2530;
  --border-color: #30363d;
  --text-main: #f0f6fc;
  --text-muted: #8b949e;
  --accent: #6c8ef5;
  --green: #22c55e;
  --amber: #f59e0b;
  --red: #ef4444;
}
body { margin: 0; background: var(--bg-dark); color: var(--text-main);
       font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
```

`app/layout.tsx`:

```tsx
import './globals.css';

export const metadata = { title: 'GPU Monitoring' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
```

- [ ] **Step 3: Write the API client**

`lib/api.ts`:

```ts
/** Fetch wrapper against advanced-monitoring-api.
 *
 * Runtime-configured, never build-time: the ML Platform bakes NEXT_PUBLIC_* into its
 * image and then has to rebuild per cluster. window.__ENV is written at container start.
 */
declare global { interface Window { __ENV?: Record<string, string> } }

export function apiBase(): string {
  if (typeof window !== 'undefined' && window.__ENV?.MONITORING_API)
    return window.__ENV.MONITORING_API;
  return process.env.NEXT_PUBLIC_MONITORING_API || 'http://127.0.0.1:8000';
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail ?? detail; } catch { /* non-JSON body */ }
    throw new ApiError(detail, r.status);
  }
  return r.json();
}

export interface PanelSpec {
  id: number; type: string; title: string; description: string;
  gridPos: { h: number; w: number; x: number; y: number };
  targets: { expr: string; legendFormat: string }[];
  unit?: string; min?: number; max?: number;
}
export interface RowSpec { title: string; collapsed: boolean; panels: PanelSpec[] }
export interface DashboardSpec { uid: string; title: string; rows: RowSpec[] }
export interface Catalog {
  dashboards: DashboardSpec[];
  variables: { name: string; query: string; includeAll: boolean; multi: boolean }[];
}

export const api = {
  getCatalog: () => get<Catalog>('/catalog'),
  query: (q: string) => get<{ resultType: string; result: any[] }>(
    `/query?q=${encodeURIComponent(q)}`),
  queryRange: (q: string, start: number, end: number, step: number) => get<{ result: any[] }>(
    `/query_range?q=${encodeURIComponent(q)}&start=${start}&end=${end}&step=${step}`),
  labelValues: (name: string, start: number, end: number) => get<{ values: string[]; error?: string }>(
    `/label/${encodeURIComponent(name)}/values?start=${start}&end=${end}`),
};
```

- [ ] **Step 4: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/
# suggested message: "scaffold the monitoring ui"
```

---

### Task 6: The timeseries renderer

42 of 58 panels. Build this one well and most of the UI exists.

**Files:**
- Create: `services/advanced-monitoring-ui/components/panels/TimeSeriesPanel.tsx`
- Create: `services/advanced-monitoring-ui/components/PanelFrame.tsx`

- [ ] **Step 1: Write the shared frame**

`components/PanelFrame.tsx` — the ML Platform's admin panel wrapper, which it copy-pastes ~20 times:

```tsx
'use client';

export type PanelState = 'ok' | 'loading' | 'nodata' | 'unsupported' | 'down';

const MESSAGE: Record<Exclude<PanelState, 'ok' | 'loading'>, string> = {
  // The three causes an empty panel can have. Collapsing them into one "No data" is
  // exactly the ambiguity gpu_metric_supported exists to remove.
  nodata: 'No data in this range',
  unsupported: 'Not supported on this GPU',
  down: 'Prometheus unreachable',
};

export function PanelFrame({ title, description, state, children }: {
  title: string; description?: string; state: PanelState; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-panel,#161b22)', border: '1px solid var(--border-color,#30363d)',
      borderRadius: 10, padding: '1rem', height: '100%', display: 'flex', flexDirection: 'column',
    }}>
      <div title={description} style={{
        fontSize: '0.82rem', color: 'var(--text-muted)', fontWeight: 500, marginBottom: '0.6rem',
      }}>{title}</div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state === 'ok' ? children : (
          <div style={{
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: '0.85rem',
          }}>{state === 'loading' ? '…' : MESSAGE[state]}</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the renderer**

`components/panels/TimeSeriesPanel.tsx`:

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
                       '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

export function TimeSeriesPanel({ spec, vars, rangeSeconds, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<any>(null);
  const [state, setState] = useState<PanelState>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = Math.floor(Date.now() / 1000);
      const start = end - rangeSeconds;
      const step = deriveStep(rangeSeconds);
      const results = await Promise.allSettled(spec.targets.map((t) =>
        api.queryRange(substituteVars(t.expr, vars), start, end, step)));
      if (cancelled) return;

      // One dead target must not blank a panel whose other targets returned.
      if (results.every((r) => r.status === 'rejected')) {
        const first = results[0];
        const down = first.status === 'rejected' && first.reason instanceof ApiError
                     && first.reason.status >= 500;
        setState(down ? 'down' : 'nodata');
        return;
      }

      const datasets: any[] = [];
      results.forEach((r, ti) => {
        if (r.status !== 'fulfilled') return;
        r.value.result.forEach((s: any) => {
          const legend = (spec.targets[ti].legendFormat || '').replace(
            /\{\{(\w+)\}\}/g, (_m, k) => s.metric[k] ?? '');
          datasets.push({
            label: legend || Object.values(s.metric).join(' '),
            data: s.values.map(([t, v]: [number, string]) => ({ x: t * 1000, y: Number(v) })),
            borderColor: SERIES_COLORS[datasets.length % SERIES_COLORS.length],
            borderWidth: 2, pointRadius: 0, tension: 0.25,
          });
        });
      });
      if (!datasets.length) { setState('nodata'); return; }
      setState('ok');

      const { default: Chart } = await import('chart.js/auto');
      if (cancelled) return;
      if (chart.current) {
        // Update in place. Destroying and recreating flickers the canvas on every refresh.
        chart.current.data.datasets = datasets;
        chart.current.update();
        return;
      }
      if (!canvas.current) return;
      chart.current = new Chart(canvas.current, {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { type: 'time', ticks: { color: '#8b949e', maxTicksLimit: 6 },
                 grid: { color: '#30363d' } },
            y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' },
                 min: spec.min, max: spec.max },
          },
          plugins: { legend: { labels: { color: '#8b949e', boxWidth: 10 } } },
        },
      });
    })();
    return () => { cancelled = true; };
  }, [spec, vars, rangeSeconds, tick]);

  useEffect(() => () => { chart.current?.destroy(); }, []);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <canvas ref={canvas} />
    </PanelFrame>
  );
}
```

- [ ] **Step 3: Verify it compiles**

```bash
npm run typecheck
```

Expected: no errors. Chart.js time scale needs an adapter — if `type: 'time'` errors at runtime, install
`chartjs-adapter-date-fns` and `date-fns` and import the adapter in this file. Verify in Step 4 before
moving on.

- [ ] **Step 4: See it render against real data**

```bash
# API on :8000 from Task 3 Step 6, Prometheus port-forwarded
npm run dev
# open http://127.0.0.1:3002 after Task 8 builds the page
```

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/components/
# suggested message: "add the timeseries panel renderer"
```

---

### Task 7: Stat, gauge and bargauge renderers

Nine panels between them, all reductions of an instant query.

**Files:**
- Create: `components/panels/StatPanel.tsx`, `GaugePanel.tsx`, `BarGaugePanel.tsx`
- Create: `lib/format.ts`

- [ ] **Step 1: Write the unit formatter and its test**

`lib/format.ts`:

```ts
/** Grafana unit ids the panel spec carries, rendered the way Grafana renders them. */
export function formatValue(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'percentunit': return `${(v * 100).toFixed(1)}%`;
    case 'percent':     return `${v.toFixed(1)}%`;
    case 'watt':        return `${v.toFixed(0)} W`;
    case 'celsius':     return `${v.toFixed(0)} °C`;
    case 'hertz':       return si(v, 'Hz');
    case 'bytes':       return bytes(v);
    case 'Bps':         return `${bytes(v)}/s`;
    default:            return si(v, '');
  }
}

function bytes(v: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function si(v: number, suffix: string): string {
  const u = ['', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (Math.abs(v) >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  const n = Math.abs(v) < 10 && i === 0 ? v.toFixed(2) : v.toFixed(i ? 1 : 0);
  return `${n}${u[i]}${suffix ? ' ' + suffix : ''}`;
}
```

`lib/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatValue } from './format';

describe('formatValue', () => {
  it('renders a ratio as a percentage', () => {
    expect(formatValue(0.921, 'percentunit')).toBe('92.1%');
  });
  it('renders bytes in binary units, matching Grafana', () => {
    expect(formatValue(6241124352, 'bytes')).toBe('5.8 GiB');
  });
  it('renders throughput with a per-second suffix', () => {
    expect(formatValue(1048576, 'Bps')).toBe('1.0 MiB/s');
  });
  it('renders a non-finite value as a dash rather than NaN', () => {
    expect(formatValue(NaN, 'watt')).toBe('—');
  });
});
```

- [ ] **Step 2: Run it to see it fail, then pass**

```bash
npm test -- format
```

Expected: FAIL (`Cannot find module './format'`), then `4 passed` once written.

- [ ] **Step 3: Write StatPanel**

`components/panels/StatPanel.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { formatValue } from '@/lib/format';
import { PanelFrame, PanelState } from '../PanelFrame';

export function StatPanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setValue(Number(r.result[0].value[1]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ height: '100%', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: '2.2rem', fontWeight: 700 }}>
        {value === null ? '—' : formatValue(value, spec.unit)}
      </div>
    </PanelFrame>
  );
}
```

- [ ] **Step 4: Write GaugePanel**

`components/panels/GaugePanel.tsx` — an SVG arc, the shape the ML Platform's `SemiGauge` uses:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { formatValue } from '@/lib/format';
import { PanelFrame, PanelState } from '../PanelFrame';

function arc(cx: number, cy: number, r: number, frac: number): string {
  const a = Math.PI * (1 - Math.min(1, Math.max(0, frac)));
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  return `M ${cx - r} ${cy} A ${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

export function GaugePanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [value, setValue] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setValue(Number(r.result[0].value[1]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const frac = max > min ? (value - min) / (max - min) : 0;

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center', height: '100%' }}>
        <svg viewBox="0 0 120 66" style={{ width: '100%', maxWidth: 200 }}>
          <path d={arc(60, 60, 50, 1)} fill="none" stroke="var(--border-color,#30363d)"
                strokeWidth={10} strokeLinecap="round" />
          <path d={arc(60, 60, 50, frac)} fill="none" stroke="#2a78d6"
                strokeWidth={10} strokeLinecap="round" />
        </svg>
        <div style={{ fontSize: '1.4rem', fontWeight: 700, marginTop: '-0.4rem' }}>
          {formatValue(value, spec.unit)}
        </div>
      </div>
    </PanelFrame>
  );
}
```

- [ ] **Step 5: Write BarGaugePanel**

`components/panels/BarGaugePanel.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { formatValue } from '@/lib/format';
import { PanelFrame, PanelState } from '../PanelFrame';

export function BarGaugePanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [bars, setBars] = useState<{ label: string; value: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setBars(r.result.map((s: any) => ({
          label: (spec.targets[0].legendFormat || '').replace(
            /\{\{(\w+)\}\}/g, (_m, k) => s.metric[k] ?? '') || Object.values(s.metric).join(' '),
          value: Number(s.value[1]),
        })));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  const min = spec.min ?? 0, max = spec.max ?? 1;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem',
                    justifyContent: 'center', height: '100%' }}>
        {bars.map((b) => (
          <div key={b.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span>{b.label}</span><span>{formatValue(b.value, spec.unit)}</span>
            </div>
            <div style={{ height: 8, background: 'var(--border-color,#30363d)', borderRadius: 4 }}>
              <div style={{
                width: `${Math.min(100, Math.max(0, ((b.value - min) / (max - min)) * 100))}%`,
                height: '100%', background: '#2a78d6', borderRadius: 4,
              }} />
            </div>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add services/advanced-monitoring-ui/
# suggested message: "add stat, gauge and bargauge renderers"
```

---

### Task 8: Table renderer and the dashboard page

**Files:**
- Create: `components/panels/TablePanel.tsx`
- Create: `components/PanelGrid.tsx`
- Create: `app/page.tsx`

- [ ] **Step 1: Write TablePanel**

`components/panels/TablePanel.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

// Labels that identify the scrape target rather than the measured entity. Grafana hides
// them via an organize transformation; showing them buries the useful columns.
const HIDE = new Set(['__name__', 'job', 'instance', 'namespace', 'pod', 'service',
                      'container', 'endpoint', 'node', 'Hostname', 'UUID', 'device',
                      'modelName', 'pci_bus_id', 'DCGM_FI_DRIVER_VERSION']);

export function TablePanel({ spec, vars, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cols, setCols] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.query(substituteVars(spec.targets[0].expr, vars));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        const keys = [...new Set(r.result.flatMap((s: any) => Object.keys(s.metric)))]
          .filter((k) => !HIDE.has(k)).sort();
        setCols([...keys, 'Value']);
        setRows(r.result.map((s: any) => [...keys.map((k) => s.metric[k] ?? ''), s.value[1]]));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, tick]);

  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ overflow: 'auto', height: '100%' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead><tr>{cols.map((c) => (
            <th key={c} style={{
              textAlign: 'left', padding: '0.35rem 0.5rem', position: 'sticky', top: 0,
              background: 'var(--bg-panel,#161b22)', color: 'var(--text-muted)',
              textTransform: 'uppercase', fontSize: '0.7rem', letterSpacing: '0.04em',
              borderBottom: '1px solid var(--border-color,#30363d)',
            }}>{c}</th>))}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (
              <td key={j} style={{ padding: '0.35rem 0.5rem',
                                   borderBottom: '1px solid var(--border-color,#30363d)' }}>{c}</td>
            ))}</tr>))}</tbody>
        </table>
      </div>
    </PanelFrame>
  );
}
```

- [ ] **Step 2: Write the grid dispatcher**

`components/PanelGrid.tsx`:

```tsx
'use client';
import { PanelSpec } from '@/lib/api';
import { TimeSeriesPanel } from './panels/TimeSeriesPanel';
import { StatPanel } from './panels/StatPanel';
import { GaugePanel } from './panels/GaugePanel';
import { BarGaugePanel } from './panels/BarGaugePanel';
import { TablePanel } from './panels/TablePanel';
import { PanelFrame } from './PanelFrame';

export function PanelGrid({ panels, vars, rangeSeconds, tick }: {
  panels: PanelSpec[]; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  return (
    // Grafana's 24-column grid, reproduced so gridPos from the spec lays out unchanged.
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: '0.75rem' }}>
      {panels.map((p) => (
        <div key={p.id} style={{ gridColumn: `span ${p.gridPos.w}`, height: p.gridPos.h * 34 }}>
          {render(p, vars, rangeSeconds, tick)}
        </div>
      ))}
    </div>
  );
}

function render(p: PanelSpec, vars: Record<string, string[]>, rangeSeconds: number, tick: number) {
  switch (p.type) {
    case 'timeseries': return <TimeSeriesPanel spec={p} vars={vars} rangeSeconds={rangeSeconds} tick={tick} />;
    case 'stat':       return <StatPanel spec={p} vars={vars} tick={tick} />;
    case 'gauge':      return <GaugePanel spec={p} vars={vars} tick={tick} />;
    case 'bargauge':   return <BarGaugePanel spec={p} vars={vars} tick={tick} />;
    case 'table':      return <TablePanel spec={p} vars={vars} tick={tick} />;
    default:
      // state-timeline and heatmap arrive in Task 9. Say so rather than render blank.
      return <PanelFrame title={p.title} description={p.description} state="nodata">
        <div /></PanelFrame>;
  }
}
```

- [ ] **Step 3: Write the page**

`app/page.tsx`:

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, Catalog } from '@/lib/api';
import { PanelGrid } from '@/components/PanelGrid';

const RANGES = [
  { label: '5m', s: 300 }, { label: '15m', s: 900 }, { label: '1h', s: 3600 },
  { label: '6h', s: 21600 }, { label: '24h', s: 86400 }, { label: '7d', s: 604800 },
];
const REFRESH = [
  { label: 'Off', v: 0 }, { label: '10s', v: 10 }, { label: '30s', v: 30 },
  { label: '1m', v: 60 }, { label: '5m', v: 300 },
];

export default function Page() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [dash, setDash] = useState(0);
  const [gpus, setGpus] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [range, setRange] = useState(3600);
  const [tick, setTick] = useState(0);
  const [refresh, setRefresh] = useState(() => {
    if (typeof window === 'undefined') return 0;          // SSR guard
    return Number(localStorage.getItem('adv_mon_refresh') ?? 0) || 0;
  });

  useEffect(() => { api.getCatalog().then(setCat).catch(() => setCat(null)); }, []);
  useEffect(() => {
    // Scoped to the selected range: unscoped, a deleted device still appears.
    const end = Math.floor(Date.now() / 1000);
    api.labelValues('gpu_uuid', end - range, end).then((r) => setGpus(r.values)).catch(() => {});
  }, [range, tick]);
  useEffect(() => { localStorage.setItem('adv_mon_refresh', String(refresh)); }, [refresh]);
  useEffect(() => {
    if (!refresh) return;
    const t = setInterval(() => setTick((n) => n + 1), refresh * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const vars = { gpu: sel };
  const sx = { background: 'var(--bg-panel,#161b22)', color: 'var(--text-main)',
               border: '1px solid var(--border-color,#30363d)', borderRadius: 6,
               padding: '0.35rem 0.5rem' };

  if (!cat) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading…</div>;
  const d = cat.dashboards[dash];

  return (
    <div style={{ padding: '1.25rem', maxWidth: 1800, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap',
                    marginBottom: '1rem' }}>
        <select value={dash} onChange={(e) => setDash(Number(e.target.value))} style={sx}>
          {cat.dashboards.map((x, i) => <option key={x.uid} value={i}>{x.title}</option>)}
        </select>
        <select multiple value={sel} style={{ ...sx, minWidth: 220, height: 34 }}
                onChange={(e) => setSel([...e.target.selectedOptions].map((o) => o.value))}>
          {gpus.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} style={sx}>
          {RANGES.map((r) => <option key={r.s} value={r.s}>{r.label}</option>)}
        </select>
        <select value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} style={sx}>
          {REFRESH.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
        </select>
        <button onClick={() => setTick((n) => n + 1)} style={{ ...sx, cursor: 'pointer' }}>↻</button>
      </div>

      {d.rows.map((row) => (
        <details key={row.title} open={!row.collapsed} style={{ marginBottom: '1rem' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.85rem',
                            marginBottom: '0.6rem' }}>{row.title}</summary>
          <PanelGrid panels={row.panels} vars={vars} rangeSeconds={range} tick={tick} />
        </details>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Verify against the live cluster**

```bash
npm run typecheck && npm run dev
```

Open `http://127.0.0.1:3002`. Expected: the dashboard selector lists three dashboards; Performance renders
with real lines; the GPU selector lists two UUIDs; switching range re-queries.

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/
# suggested message: "add the table renderer and dashboard page"
```

---

### Task 9: State-timeline and heatmap

The two panels with no Chart.js equivalent. Both are custom SVG.

**Files:**
- Create: `components/panels/StateTimelinePanel.tsx`, `HeatmapPanel.tsx`
- Modify: `components/PanelGrid.tsx` — add the two cases

- [ ] **Step 1: Write StateTimelinePanel**

`components/panels/StateTimelinePanel.tsx` — one row per series, coloured bands where the value is non-zero:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

export function StateTimelinePanel({ spec, vars, rangeSeconds, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [series, setSeries] = useState<{ label: string; pts: [number, number][] }[]>([]);
  const [span, setSpan] = useState<[number, number]>([0, 1]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = Math.floor(Date.now() / 1000), start = end - rangeSeconds;
      try {
        const r = await api.queryRange(substituteVars(spec.targets[0].expr, vars),
                                       start, end, deriveStep(rangeSeconds));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        setSpan([start, end]);
        setSeries(r.result.map((s: any) => ({
          label: (spec.targets[0].legendFormat || '').replace(
            /\{\{(\w+)\}\}/g, (_m, k) => s.metric[k] ?? '') || Object.values(s.metric).join(' '),
          pts: s.values.map(([t, v]: [number, string]) => [Number(t), Number(v)]),
        })));
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, rangeSeconds, tick]);

  const [t0, t1] = span, w = Math.max(1, t1 - t0), rowH = 22;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <div style={{ overflow: 'auto', height: '100%' }}>
        {series.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                                marginBottom: 3 }}>
            <div style={{ width: 190, flexShrink: 0, fontSize: '0.7rem',
                          color: 'var(--text-muted)', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
            <svg width="100%" height={rowH} style={{ display: 'block' }}>
              <rect x={0} y={4} width="100%" height={rowH - 8}
                    fill="var(--border-color,#30363d)" rx={3} />
              {s.pts.map(([t, v], j) => v === 0 ? null : (
                // Each sample paints one step-wide band; adjacent bands merge visually.
                <rect key={j} x={`${((t - t0) / w) * 100}%`} y={4}
                      width={`${(1 / (s.pts.length || 1)) * 100}%`} height={rowH - 8}
                      fill="#eb6834" />
              ))}
            </svg>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}
```

- [ ] **Step 2: Write HeatmapPanel**

`components/panels/HeatmapPanel.tsx` — buckets on Y, time on X, count as opacity:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, PanelSpec } from '@/lib/api';
import { substituteVars, deriveStep } from '@/lib/promql';
import { PanelFrame, PanelState } from '../PanelFrame';

export function HeatmapPanel({ spec, vars, rangeSeconds, tick }: {
  spec: PanelSpec; vars: Record<string, string[]>; rangeSeconds: number; tick: number;
}) {
  const [state, setState] = useState<PanelState>('loading');
  const [cells, setCells] = useState<{ le: string; pts: [number, number][] }[]>([]);
  const [span, setSpan] = useState<[number, number]>([0, 1]);
  const [peak, setPeak] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const end = Math.floor(Date.now() / 1000), start = end - rangeSeconds;
      try {
        const r = await api.queryRange(substituteVars(spec.targets[0].expr, vars),
                                       start, end, deriveStep(rangeSeconds));
        if (cancelled) return;
        if (!r.result.length) { setState('nodata'); return; }
        const rows = r.result
          .map((s: any) => ({ le: s.metric.le ?? '', pts: s.values.map(
            ([t, v]: [number, string]) => [Number(t), Number(v)] as [number, number]) }))
          .sort((a: any, b: any) => Number(a.le) - Number(b.le));
        setSpan([start, end]);
        setPeak(Math.max(1, ...rows.flatMap((x: any) => x.pts.map((p: any) => p[1]))));
        setCells(rows);
        setState('ok');
      } catch (e) {
        if (!cancelled) setState(e instanceof ApiError && e.status >= 500 ? 'down' : 'nodata');
      }
    })();
    return () => { cancelled = true; };
  }, [spec, vars, rangeSeconds, tick]);

  const [t0, t1] = span, w = Math.max(1, t1 - t0);
  const h = cells.length ? 100 / cells.length : 100;
  return (
    <PanelFrame title={spec.title} description={spec.description} state={state}>
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
        {cells.map((row, i) => row.pts.map(([t, v], j) => (
          <rect key={`${i}-${j}`} x={((t - t0) / w) * 100} y={100 - (i + 1) * h}
                width={100 / (row.pts.length || 1)} height={h}
                fill="#2a78d6" opacity={v / peak} />
        )))}
      </svg>
    </PanelFrame>
  );
}
```

- [ ] **Step 3: Wire them into the grid**

In `components/PanelGrid.tsx`, add the imports and two cases before `default:`:

```tsx
    case 'state-timeline': return <StateTimelinePanel spec={p} vars={vars} rangeSeconds={rangeSeconds} tick={tick} />;
    case 'heatmap':        return <HeatmapPanel spec={p} vars={vars} rangeSeconds={rangeSeconds} tick={tick} />;
```

- [ ] **Step 4: Verify every panel type now renders**

```bash
npm run typecheck
```

Then in the browser, confirm no panel falls through to the `default:` placeholder:

```bash
python3 - <<'PY'
import json
spec = json.load(open('services/advanced-monitoring-api/app/panels.json'))
handled = {'timeseries','stat','gauge','bargauge','table','state-timeline','heatmap'}
missing = {p['type'] for d in spec['dashboards'] for r in d['rows'] for p in r['panels']} - handled
print("unhandled panel types:", missing or "none")
PY
```

Expected: `none`.

- [ ] **Step 5: Commit**

```bash
git add services/advanced-monitoring-ui/components/
# suggested message: "add state-timeline and heatmap renderers"
```

---

### Task 10: Containers and deployment

**Files:**
- Create: `services/advanced-monitoring-api/Dockerfile`
- Create: `services/advanced-monitoring-ui/Dockerfile`, `docker-entrypoint.sh`
- Create: `deploy/a30-node/70-advanced-monitoring.yaml`

- [ ] **Step 1: Write the API Dockerfile**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 2: Write the UI Dockerfile and entrypoint**

`services/advanced-monitoring-ui/Dockerfile`:

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
USER node
EXPOSE 3002
ENTRYPOINT ["./docker-entrypoint.sh"]
```

`services/advanced-monitoring-ui/docker-entrypoint.sh` — runtime config, so one image works on any cluster:

```sh
#!/bin/sh
# Write window.__ENV at container start. Baking NEXT_PUBLIC_* at build time would mean
# rebuilding the image per cluster, which is the trap the ML Platform's entrypoint avoids.
cat > /app/public/env.js <<EOF
window.__ENV = { MONITORING_API: "${MONITORING_API:-}" };
EOF
exec node server.js
```

Add to `app/layout.tsx`'s `<head>`: `<script src="/env.js" />`.

- [ ] **Step 3: Write the manifests**

`deploy/a30-node/70-advanced-monitoring.yaml`:

```yaml
# Advanced monitoring: a native UI over this system's metrics.
#
# Both Services are ClusterIP and stay that way in this phase. The API proxies ARBITRARY
# PromQL with no authentication, so anything that can reach it can read every metric in
# the cluster. Reach it with `kubectl port-forward`, exactly as Prometheus and Grafana
# are reached here. Keycloak is a prerequisite for ML Platform integration
# (docs-internal/12 § 5), not a later nicety.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: advanced-monitoring-api
  namespace: gpu-monitoring
spec:
  replicas: 1
  selector:
    matchLabels: { app: advanced-monitoring-api }
  template:
    metadata:
      labels: { app: advanced-monitoring-api }
    spec:
      imagePullSecrets:
        - name: harbor-pull-secret
      containers:
        - name: api
          image: REPLACE_ME_API
          ports: [{ name: http, containerPort: 8000 }]
          env:
            - name: PROMETHEUS_URL
              value: http://prometheus-operated.gpu-monitoring.svc.cluster.local:9090
          readinessProbe:
            httpGet: { path: /healthz, port: http }
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { memory: 256Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: advanced-monitoring-api
  namespace: gpu-monitoring
spec:
  selector: { app: advanced-monitoring-api }
  ports: [{ name: http, port: 8000, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: advanced-monitoring-ui
  namespace: gpu-monitoring
spec:
  replicas: 1
  selector:
    matchLabels: { app: advanced-monitoring-ui }
  template:
    metadata:
      labels: { app: advanced-monitoring-ui }
    spec:
      imagePullSecrets:
        - name: harbor-pull-secret
      containers:
        - name: ui
          image: REPLACE_ME_UI
          ports: [{ name: http, containerPort: 3002 }]
          env:
            # Browser-reachable address. With port-forward this is the forwarded API port.
            - name: MONITORING_API
              value: http://127.0.0.1:8000
          readinessProbe:
            httpGet: { path: /, port: http }
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: advanced-monitoring-ui
  namespace: gpu-monitoring
spec:
  selector: { app: advanced-monitoring-ui }
  ports: [{ name: http, port: 3002, targetPort: http }]
```

- [ ] **Step 4: Build, push and deploy**

```bash
SHA=$(git rev-parse --short HEAD)
REG=192.168.6.123:30080/library
docker build -t $REG/advanced-monitoring-api:$SHA services/advanced-monitoring-api
docker build -t $REG/advanced-monitoring-ui:$SHA  services/advanced-monitoring-ui
docker push $REG/advanced-monitoring-api:$SHA
docker push $REG/advanced-monitoring-ui:$SHA
sed -e "s|REPLACE_ME_API|$REG/advanced-monitoring-api:$SHA|" \
    -e "s|REPLACE_ME_UI|$REG/advanced-monitoring-ui:$SHA|" \
    deploy/a30-node/70-advanced-monitoring.yaml | kubectl apply -f -
kubectl -n gpu-monitoring rollout status deploy/advanced-monitoring-api --timeout=180s
kubectl -n gpu-monitoring rollout status deploy/advanced-monitoring-ui  --timeout=180s
```

- [ ] **Step 5: Verify in the cluster**

```bash
kubectl -n gpu-monitoring exec deploy/advanced-monitoring-ui -- wget -qO- http://advanced-monitoring-api:8000/healthz
kubectl -n gpu-monitoring exec deploy/advanced-monitoring-ui -- \
  wget -qO- 'http://advanced-monitoring-api:8000/catalog' | head -c 120
```

Expected: `{"status":"ok"}`, then the start of the spec.

Then, from a workstation:

```bash
kubectl -n gpu-monitoring port-forward svc/advanced-monitoring-api 8000:8000 &
kubectl -n gpu-monitoring port-forward svc/advanced-monitoring-ui  3002:3002 &
```

Open `http://127.0.0.1:3002` under load (`kubectl apply -f deploy/a30-node/90-loadgen-gpu-burn.yaml`) and
confirm real lines in Performance, then tear the load down.

- [ ] **Step 6: Commit**

```bash
git add services/ deploy/a30-node/70-advanced-monitoring.yaml
# suggested message: "deploy the advanced monitoring api and ui"
```

---

### Task 11: Keep the spec from drifting

The extractor's output is generated, so it can silently go stale. Make that a test failure.

**Files:**
- Modify: `scripts/check-dashboards.py`

- [ ] **Step 1: Add the staleness check**

Append to `scripts/check-dashboards.py`'s `check()`, before `return fail`:

```python
    # (h) panels.json must match the dashboards it was generated from. It is a build
    # artifact committed into the API image, so nothing else would notice it going stale.
    spec_path = pathlib.Path("services/advanced-monitoring-api/app/panels.json")
    if spec_path.exists():
        spec = json.loads(spec_path.read_text())
        in_spec = sum(len(r["panels"]) for d in spec["dashboards"] for r in d["rows"])
        in_dash = sum(1 for d in dashes.values() for p in leaves(d["panels"]) if p.get("targets"))
        if in_spec != in_dash:
            fail.append(f"panels.json has {in_spec} panels, dashboards have {in_dash} — "
                        f"re-run scripts/extract-panels.py")
```

Add `import pathlib` at the top.

- [ ] **Step 2: Prove it catches staleness**

```bash
python3 -c "
import json,pathlib
p=pathlib.Path('services/advanced-monitoring-api/app/panels.json')
s=json.loads(p.read_text()); s['dashboards'][0]['rows'][0]['panels'].pop()
p.write_text(json.dumps(s,indent=2))"
python3 scripts/check-dashboards.py dashboards/*.json
```

Expected: FAIL naming the count mismatch.

- [ ] **Step 3: Regenerate and confirm it passes**

```bash
python3 scripts/extract-panels.py dashboards/gpu-hardware-device.json \
  dashboards/gpu-hardware-mig.json dashboards/gpu-software.json \
  -o services/advanced-monitoring-api/app/panels.json
python3 scripts/check-dashboards.py dashboards/*.json
```

Expected: `0 problem(s)`.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-dashboards.py services/advanced-monitoring-api/app/panels.json
# suggested message: "fail the checker when the panel spec goes stale"
```

---

## Self-review

**Spec coverage.** §1 panels-as-data → Tasks 1, 8, 11. §1.1 PromQL in the spec → Task 1 Step 3, Task 4.
§1.2 seven renderers → Tasks 6, 7, 8, 9. §2 data flow and endpoints → Tasks 2, 3. §2.2 `$gpu` → Task 4.
§3 carried behaviour → Task 6 (`allSettled`, in-place update), Task 8 (localStorage, SSR guard).
§3.1 three-way empty state → `PanelFrame` in Task 6 Step 1. §3.2 time-range picker → Task 8 Step 3.
§4 styling → Task 5 Step 2 and every renderer. §5 exposure → Task 10 Step 3's manifest comment.
§6 Grafana retained → Task 11 makes deleting the dashboards break the build.

**One gap accepted deliberately.** §3.1's *unsupported* state needs `gpu_metric_supported`, which no task
wires in — `PanelFrame` supports the state but nothing sets it. Doing it properly means a per-panel support
lookup keyed by the metric name in the panel's expression, which is its own task and depends on all
renderers existing first. It is listed here rather than left implied, and should be Task 12 once the UI is
running.

**Type consistency.** `PanelSpec`, `RowSpec`, `DashboardSpec`, `Catalog` are defined once in `lib/api.ts`
(Task 5) and imported everywhere after. `PanelState` is defined in `PanelFrame.tsx` (Task 6) and imported by
every renderer. `substituteVars`/`deriveStep` keep the names given in Task 4. `prometheus.query`,
`query_range` and `label_values` keep the signatures given in Task 2 and are called with those names in
Task 3.

**Placeholder scan.** No TBDs. `REPLACE_ME_API`/`REPLACE_ME_UI` in the manifest are substituted by the `sed`
in Task 10 Step 4 — the same pattern the existing `40-nvml-exporter.yaml` uses.
