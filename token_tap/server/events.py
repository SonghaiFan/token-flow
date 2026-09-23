"""SSE event stream handlers and lifecycle broadcasting."""

from __future__ import annotations

import asyncio
import json

from aiohttp import web

from token_tap.analysis.records import attach_cost_to_record
from token_tap.analysis.sessions import dashboard_trace_snapshot


class ServerEvents:
    async def _handle_sse(self, request: web.Request, response: web.StreamResponse | None = None) -> web.StreamResponse:
        """SSE endpoint for live trace updates."""
        resp = response or web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            },
        )
        await resp.prepare(request)

        async with self._lock:
            for record in self._records:
                data = json.dumps(attach_cost_to_record(record), ensure_ascii=False, separators=(",", ":"))
                await resp.write(f"data: {data}\n\n".encode("utf-8"))

        self._sse_clients.append(resp)

        try:
            while not self._shutdown_event.is_set():
                try:
                    await asyncio.wait_for(self._shutdown_event.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass
                if self._shutdown_event.is_set():
                    break
                try:
                    await resp.write(b": keepalive\n\n")
                except (ConnectionError, ConnectionResetError, RuntimeError):
                    break
        except asyncio.CancelledError:
            pass
        finally:
            if resp in self._sse_clients:
                self._sse_clients.remove(resp)

        return resp

    async def _handle_dashboard_sse(
        self, request: web.Request, response: web.StreamResponse | None = None
    ) -> web.StreamResponse:
        """SSE endpoint for dashboard-level session updates."""
        resp = response or web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            },
        )
        await resp.prepare(request)
        self._dashboard_clients.append(resp)
        await self._write_dashboard_event(resp, {"type": "ready"})

        try:
            while not self._shutdown_event.is_set():
                try:
                    await asyncio.wait_for(self._shutdown_event.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass
                if self._shutdown_event.is_set():
                    break
                try:
                    await resp.write(b": keepalive\n\n")
                except (ConnectionError, ConnectionResetError, RuntimeError):
                    break
        except asyncio.CancelledError:
            pass
        finally:
            if resp in self._dashboard_clients:
                self._dashboard_clients.remove(resp)

        return resp

    async def _watch_dashboard_store(self) -> None:
        """Poll SQLite and notify dashboard clients when history changes."""
        while not self._shutdown_event.is_set():
            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass
            if self._shutdown_event.is_set():
                break
            snapshot = dashboard_trace_snapshot()
            if snapshot != self._dashboard_snapshot:
                self._dashboard_snapshot = snapshot
                await self._broadcast_dashboard_event({"type": "refresh"})

    async def _broadcast_dashboard_event(self, payload: dict) -> None:
        if not self._dashboard_clients:
            return
        disconnected = []
        for client in self._dashboard_clients:
            try:
                await self._write_dashboard_event(client, payload)
            except (ConnectionError, ConnectionResetError, RuntimeError, Exception):
                disconnected.append(client)
        for client in disconnected:
            if client in self._dashboard_clients:
                self._dashboard_clients.remove(client)

    async def _write_dashboard_event(self, client: web.StreamResponse, payload: dict) -> None:
        event_name = payload.get("type", "message")
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        await client.write(f"event: {event_name}\ndata: {data}\n\n".encode("utf-8"))
