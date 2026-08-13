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

# The UI runs on a different origin to this API, so every browser call is cross-origin.
# The allowlist is configurable because the right value depends on how the UI is reached:
# loopback under port-forward, the node address under NodePort. A browser treats
# localhost, 127.0.0.1 and the node IP as three different origins, so an origin missing
# here leaves the page stuck on "Loading…" with the reason only in the browser console.
CORS_ORIGINS = [o.strip() for o in os.environ.get(
    "CORS_ORIGINS", "http://localhost:3002,http://127.0.0.1:3002").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET"], allow_headers=["*"])

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
    # start/end are optional but the UI always sends them: unscoped, this lists every
    # value in the retention window, including devices that no longer exist.
    try:
        return {"values": await prometheus.label_values(
            _client, PROMETHEUS_URL, name, start=start, end=end)}
    except prometheus.UpstreamError as exc:
        return {"values": [], "error": str(exc)}
