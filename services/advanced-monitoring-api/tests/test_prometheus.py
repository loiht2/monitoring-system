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


@pytest.mark.asyncio
async def test_label_values_scopes_to_a_time_window_when_given_one():
    """Unscoped, Prometheus answers from the whole retention window, so a device that
    existed days ago still appears. Measured on the real cluster: a MIG instance that no
    longer exists was still listed, which would put a dead entry in the GPU selector."""
    seen = {}

    def handler(request):
        seen["start"] = request.url.params.get("start")
        seen["end"] = request.url.params.get("end")
        return httpx.Response(200, json={"status": "success", "data": ["GPU-a"]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        await prometheus.label_values(c, "http://p:9090", "gpu_uuid", start=100, end=200)
    assert seen["start"] == "100" and seen["end"] == "200"


@pytest.mark.asyncio
async def test_label_values_omits_the_window_when_not_given_one():
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"status": "success", "data": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        await prometheus.label_values(c, "http://p:9090", "gpu_uuid")
    assert "start" not in seen["params"] and "end" not in seen["params"]
