from __future__ import annotations

import aiohttp
import pytest

from token_tap.analysis import estimates
from token_tap.server.app import LiveViewerServer


class _FakeEncoding:
    def encode(self, text: str, disallowed_special=()) -> list[str]:
        return text.split()


def test_estimate_token_counts_counts_each_text_and_caches_by_content(monkeypatch) -> None:
    calls = []

    class CountingEncoding(_FakeEncoding):
        def encode(self, text: str, disallowed_special=()) -> list[str]:
            calls.append(text)
            return super().encode(text)

    monkeypatch.setattr(estimates, "_encoding", CountingEncoding())
    monkeypatch.setattr(estimates, "_counts", {})

    assert estimates.estimate_token_counts(["a b c", "<rules> x </rules>", "a b c"]) == [3, 3, 3]
    assert calls == ["a b c", "<rules> x </rules>"]


@pytest.mark.asyncio
async def test_token_estimates_endpoint_validates_and_counts(trace_db, monkeypatch) -> None:
    monkeypatch.setattr(estimates, "_encoding", _FakeEncoding())
    monkeypatch.setattr(estimates, "_counts", {})
    server = LiveViewerServer(port=0, dashboard_mode=True)
    port = await server.start()
    try:
        async with aiohttp.ClientSession() as session:
            url = f"http://127.0.0.1:{port}/api/token-estimates"
            async with session.post(url, json={"texts": ["one two", "three"]}) as resp:
                assert resp.status == 200
                assert await resp.json() == {"encoding": "o200k_base", "counts": [2, 1]}
            async with session.post(url, json={"texts": "not a list"}) as resp:
                assert resp.status == 400
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_token_estimates_endpoint_reports_missing_tokenizer(trace_db, monkeypatch) -> None:
    def unavailable():
        raise estimates.EstimatesUnavailable("tiktoken is not installed")

    monkeypatch.setattr(estimates, "_get_encoding", unavailable)
    server = LiveViewerServer(port=0, dashboard_mode=True)
    port = await server.start()
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(f"http://127.0.0.1:{port}/api/token-estimates", json={"texts": ["x"]}) as resp:
                assert resp.status == 501
                assert "tiktoken" in (await resp.json())["error"]
    finally:
        await server.stop()
