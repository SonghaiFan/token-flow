"""FastAPI application and server lifecycle for Token Flow."""

from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import suppress
from datetime import date
from pathlib import Path
from typing import Any

from aiohttp import web
from fastapi import FastAPI, Request
from starlette.responses import FileResponse, Response, StreamingResponse

from token_tap.analysis.records import attach_cost_to_record
from token_tap.analysis.sessions import dashboard_trace_snapshot
from token_tap.capture.manager import CaptureManager
from token_tap.server.api import ServerAPI
from token_tap.server.events import ServerEvents
from token_tap.server.shared_dashboard import dashboard_url
from token_tap.storage.history import migrate_legacy_traces


class LiveViewerServer(ServerAPI, ServerEvents):
    """FastAPI server runtime for the dashboard and live trace viewer."""

    def __init__(
        self,
        session_id: str | None = None,
        port: int = 0,
        host: str = "127.0.0.1",
        migrate_from: Path | None = None,
        dashboard_mode: bool = False,
    ):
        self.session_id = session_id
        self.port = port
        self.host = host
        self.migrate_from = migrate_from
        self.dashboard_mode = dashboard_mode
        self._sse_clients: list[web.StreamResponse] = []
        self._dashboard_clients: list[web.StreamResponse] = []
        self._records: list[dict] = []
        self._current_date: str = date.today().isoformat()
        self._lock = asyncio.Lock()
        self._uvicorn_server = None
        self._uvicorn_task: asyncio.Task | None = None
        self._actual_port: int = 0
        self._shutdown_event = asyncio.Event()
        self._stop_lock = asyncio.Lock()
        self._dashboard_watch_task: asyncio.Task | None = None
        self._dashboard_snapshot: dict[str, tuple[int, str]] = {}
        self._dashboard_quit_token = secrets.token_urlsafe(32)
        self.capture_manager = CaptureManager(on_change=self._notify_capture_changed)

    async def start(self) -> int:
        """Start the viewer server and return the actual port."""
        if self.migrate_from is not None:
            migrate_legacy_traces(self.migrate_from)

        import uvicorn

        config = uvicorn.Config(
            create_app(self),
            host=self.host,
            port=self.port,
            log_level="error",
            lifespan="off",
            access_log=False,
        )
        self._uvicorn_server = uvicorn.Server(config)
        self._uvicorn_task = asyncio.create_task(self._uvicorn_server.serve())
        self._uvicorn_task.add_done_callback(lambda _task: self._shutdown_event.set())
        try:
            while not self._uvicorn_server.started:
                if self._uvicorn_task.done():
                    await self._uvicorn_task
                    raise RuntimeError("FastAPI server stopped before startup completed")
                await asyncio.sleep(0.01)
        except BaseException:
            task = self._uvicorn_task
            if task is not None and not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            self._uvicorn_server = None
            self._uvicorn_task = None
            raise
        self._actual_port = self._uvicorn_server.servers[0].sockets[0].getsockname()[1]

        if self.dashboard_mode:
            self._dashboard_snapshot = dashboard_trace_snapshot()
            self._dashboard_watch_task = asyncio.create_task(self._watch_dashboard_store())

        return self._actual_port

    async def stop(self) -> None:
        """Stop the server, active capture, and connected event streams."""
        async with self._stop_lock:
            if self._shutdown_event.is_set() and self._uvicorn_server is None:
                return

            self._shutdown_event.set()
            await self.capture_manager.cleanup()
            if self._dashboard_watch_task:
                self._dashboard_watch_task.cancel()
                try:
                    await self._dashboard_watch_task
                except asyncio.CancelledError:
                    pass
                self._dashboard_watch_task = None
            for client in self._sse_clients:
                try:
                    await client.write_eof()
                except Exception:
                    pass
            self._sse_clients.clear()
            for client in self._dashboard_clients:
                try:
                    await client.write_eof()
                except Exception:
                    pass
            self._dashboard_clients.clear()

            if self._uvicorn_server is not None:
                self._uvicorn_server.should_exit = True
            if self._uvicorn_task is not None:
                task = self._uvicorn_task
                self._uvicorn_task = None
                await task
            self._uvicorn_server = None

    async def wait_stopped(self) -> None:
        """Wait until the server shutdown event is set."""
        await self._shutdown_event.wait()

    async def broadcast(self, record: dict) -> None:
        """Publish a captured record to connected clients and the event stream."""
        async with self._lock:
            today = date.today().isoformat()
            if today != self._current_date:
                self._records.clear()
                self._current_date = today
            self._records.append(record)

        data = json.dumps(attach_cost_to_record(record), ensure_ascii=False, separators=(",", ":"))
        message = f"data: {data}\n\n"
        disconnected = []
        for client in self._sse_clients:
            try:
                await client.write(message.encode("utf-8"))
            except (ConnectionError, ConnectionResetError, Exception):
                disconnected.append(client)
        for client in disconnected:
            self._sse_clients.remove(client)

        await self._broadcast_dashboard_event({"type": "record", "session_id": self.session_id})

    async def _notify_capture_changed(self) -> None:
        await self._broadcast_dashboard_event({"type": "capture"})

    @property
    def url(self) -> str:
        """Return the viewer URL."""
        return dashboard_url(self.host, self._actual_port)


class _RequestAdapter:
    """Expose the small aiohttp request surface used by compatibility handlers."""

    def __init__(self, request: Request):
        self.headers = request.headers
        self.query = request.query_params
        self.match_info = request.path_params
        self.path = request.url.path
        self._request = request

    async def json(self) -> Any:
        return await self._request.json()

    async def read(self) -> bytes:
        return await self._request.body()


class _StreamAdapter:
    """Queue-backed response interface consumed by the existing SSE handlers."""

    _END = object()

    def __init__(self, *, status: int = 200, headers: dict[str, str] | None = None):
        self.status = status
        self.headers = headers or {}
        self.chunks: asyncio.Queue[bytes | object] = asyncio.Queue(maxsize=32)
        self.started = asyncio.Event()

    async def prepare(self, _request: _RequestAdapter) -> _StreamAdapter:
        self.started.set()
        return self

    async def write(self, chunk: bytes) -> None:
        await self.chunks.put(chunk)

    async def write_eof(self) -> None:
        await self.chunks.put(self._END)


def _to_fastapi_response(response: web.StreamResponse) -> Response:
    if isinstance(response, web.FileResponse):
        return FileResponse(path=response._path, status_code=response.status, headers=response.headers)
    body = response.body if isinstance(response, web.Response) else b""
    if not isinstance(body, bytes):
        body = getattr(body, "_value", b"")
    return Response(content=body or b"", status_code=response.status, headers=response.headers)


def create_app(controller) -> FastAPI:
    """Create the FastAPI app using a LiveViewerServer as the current handler set."""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.controller = controller

    def add_route(path: str, method: str, handler_name: str, *, streaming: bool = False) -> None:
        async def endpoint(request: Request):
            handler = getattr(controller, handler_name)
            adapted = _RequestAdapter(request)
            try:
                if not streaming:
                    return _to_fastapi_response(await handler(adapted))

                stream = _StreamAdapter(
                    headers={
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "Access-Control-Allow-Origin": "*",
                    }
                )
                task = asyncio.create_task(handler(adapted, stream))
                await stream.started.wait()

                async def chunks():
                    try:
                        while True:
                            chunk = await stream.chunks.get()
                            if chunk is stream._END:
                                break
                            yield chunk
                    finally:
                        if not task.done():
                            task.cancel()
                        with suppress(asyncio.CancelledError):
                            await task

                return StreamingResponse(
                    chunks(),
                    status_code=stream.status,
                    headers=stream.headers,
                    media_type="text/event-stream",
                )
            except web.HTTPException as exc:
                return Response(
                    content=exc.text or b"",
                    status_code=exc.status,
                    headers=exc.headers,
                )

        endpoint.__name__ = f"{handler_name}_{method.lower()}"
        app.add_api_route(path, endpoint, methods=[method], include_in_schema=False)

    routes: list[tuple[str, str, str, bool]] = [
        ("/", "GET", "_handle_dashboard_index" if controller.dashboard_mode else "_handle_index", False),
        ("/viewer", "GET", "_handle_index", False),
        ("/dashboard", "GET", "_handle_dashboard_index", False),
        ("/dashboard/session/{session_id}", "GET", "_handle_dashboard_session_detail", False),
        ("/assets/{asset_path:path}", "GET", "_handle_static_ui_asset", False),
        ("/dashboard/health", "GET", "_handle_dashboard_health", False),
        ("/dashboard/events", "GET", "_handle_dashboard_sse", True),
        ("/dashboard/quit", "POST", "_handle_dashboard_quit", False),
        ("/dashboard/captures", "GET", "_handle_capture_status", False),
        ("/dashboard/captures", "POST", "_handle_start_capture", False),
        ("/dashboard/captures", "DELETE", "_handle_stop_capture", False),
        ("/events", "GET", "_handle_sse", True),
        ("/records", "GET", "_handle_records", False),
        ("/api/dates", "GET", "_handle_dates", False),
        ("/api/traces/{date}", "GET", "_handle_traces_by_date", False),
        ("/api/traces/{date}", "DELETE", "_handle_delete_traces_by_date", False),
        ("/api/agents", "GET", "_handle_agents", False),
        ("/api/token-estimates", "POST", "_handle_token_estimates", False),
        ("/api/sessions", "GET", "_handle_sessions", False),
        ("/api/sessions", "DELETE", "_handle_delete_sessions", False),
        ("/api/sessions/{session_id}", "DELETE", "_handle_delete_session", False),
        ("/api/sessions/{session_id}/records", "GET", "_handle_session_records", False),
        ("/api/sessions/{session_id}/html", "GET", "_handle_session_html_compat", False),
        ("/api/sessions/{session_id}/export/jsonl", "GET", "_handle_export_jsonl", False),
        ("/api/sessions/{session_id}/export/compact", "GET", "_handle_export_compact", False),
        ("/api/sessions/{session_id}/export/log", "GET", "_handle_export_log", False),
        ("/api/sessions/{session_id}/export/html", "GET", "_handle_export_html", False),
    ]
    for path, method, handler_name, streaming in routes:
        add_route(path, method, handler_name, streaming=streaming)

    return app
