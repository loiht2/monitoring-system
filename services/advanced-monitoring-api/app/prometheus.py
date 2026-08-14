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
                       start: float | None = None, end: float | None = None,
                       match: str | None = None) -> list:
    """Values seen for a label, optionally scoped to a time window and to a metric.

    Unscoped in time, Prometheus answers from the whole retention window, so a device that
    was removed days ago is still listed. Measured on the validation cluster: a MIG
    instance deleted hours earlier still appeared, which would put a dead entry in the GPU
    selector that matches no current series.

    Unscoped by metric, every pod in the cluster is offered for a variable whose Grafana
    query is metric-scoped — including this monitoring stack's own pods, which can never
    appear in an eBPF panel.
    """
    params: dict = {}
    if start is not None:
        params["start"] = start
    if end is not None:
        params["end"] = end
    if match is not None:
        params["match[]"] = match
    data = await _get(client, f"{base}/api/v1/label/{label}/values", params)
    return data if isinstance(data, list) else []
