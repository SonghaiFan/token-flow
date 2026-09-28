"""FastAPI route handlers backed by Token Flow's Python services."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit

from aiohttp import web

from token_tap.analysis.estimates import (
    ESTIMATE_ENCODING,
    MAX_ESTIMATE_CHARS,
    MAX_ESTIMATE_TEXTS,
    EstimatesUnavailable,
    estimate_token_counts,
)
from token_tap.analysis.records import (
    _extract_metadata_from_record,
    _normalize_record_for_viewer,
    attach_cost_to_record,
)
from token_tap.analysis.sessions import (
    build_session_query,
    dashboard_trace_snapshot,
    ensure_trace_store,
    list_trace_agents,
    list_trace_sessions,
    load_trace_session,
    redact_dashboard_summary,
    select_trace_turn_records,
)
from token_tap.capture.manager import DEFAULT_CAPTURE_CLIENT, capture_clients
from token_tap.core.compact_trace import build_compact_trace_bundle
from token_tap.server.dashboard import read_dashboard_template
from token_tap.server.shared_dashboard import token_tap_VERSION
from token_tap.server.viewer import (
    VIEWER_SCRIPT_ANCHOR,
    VIEWER_TEMPLATE_PATH,
    _generate_html_viewer_from_compact_bundle,
    _generate_html_viewer_from_metadata,
    _pricing_data_js,
    _read_viewer_template,
)
from token_tap.storage.history import delete_trace_history
from token_tap.storage.trace_store import (
    TraceStore,
    get_trace_store,
    read_configured_working_directory,
    reset_trace_store,
    resolve_db_path,
    save_configured_db_path,
    token_flow_data_dir,
)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_SESSION_PAGE_LIMIT = 100
MAX_SESSION_PAGE_LIMIT = 500
STATIC_UI_DIR = Path(__file__).parents[1] / "static_ui"
STATIC_UI_INDEX_PATH = STATIC_UI_DIR / "index.html"
_DASHBOARD_QUIT_TOKEN_HEADER = "X-Claude-Tap-Dashboard-Token"
_OPEN_DATABASE_PICKER_SCRIPT = """
use scripting additions
on run argv
    set startFolder to POSIX file (item 1 of argv) as alias
    set chosenFile to choose file with prompt "Open a Token Flow database" default location startFolder
    return POSIX path of chosenFile
end run
"""
_NEW_DATABASE_PICKER_SCRIPT = """
use scripting additions
on run argv
    set startFolder to POSIX file (item 1 of argv) as alias
    set chosenFile to choose file name with prompt "Create a Token Flow database" default location startFolder default name (item 2 of argv)
    return POSIX path of chosenFile
end run
"""
_PROJECT_PICKER_SCRIPT = """
use scripting additions
on run argv
    set startFolder to POSIX file (item 1 of argv) as alias
    set chosenFolder to choose folder with prompt "Choose a project for your AI" default location startFolder
    return POSIX path of chosenFolder
end run
"""


class ServerAPI:
    def _finalize_stale_active_sessions(self) -> None:
        """Release abandoned active sessions while protecting the current writer."""
        protected = {self.session_id} if self.session_id else set()
        ensure_trace_store().finalize_stale_active_sessions(protected_session_ids=protected)

    async def _handle_dashboard_index(self, request: web.Request) -> web.Response:
        """Serve the session-first dashboard."""
        if session_id := request.query.get("session_id"):
            raise web.HTTPFound(location=f"/dashboard/session/{quote(session_id, safe='')}")
        if STATIC_UI_INDEX_PATH.exists():
            return web.Response(text=STATIC_UI_INDEX_PATH.read_text(encoding="utf-8"), content_type="text/html")
        try:
            html = read_dashboard_template()
        except OSError:
            return web.Response(status=404, text="dashboard.html not found")
        html = html.replace(
            'const token_tap_VERSION = "";',
            f"const token_tap_VERSION = {json.dumps(token_tap_VERSION)};",
            1,
        )
        if self.dashboard_mode and _is_trusted_dashboard_token_request(request):
            html = html.replace(
                'const DASHBOARD_QUIT_TOKEN = "";',
                f"const DASHBOARD_QUIT_TOKEN = {json.dumps(self._dashboard_quit_token)};",
                1,
            ).replace(
                "const DASHBOARD_CAN_STOP = false;",
                "const DASHBOARD_CAN_STOP = true;",
                1,
            )
        return web.Response(text=html, content_type="text/html")

    async def _handle_dashboard_session_detail(self, request: web.Request) -> web.Response:
        """Serve the compiled workspace shell for one session."""
        if get_trace_store().load_session_row(request.match_info["session_id"]) is None:
            return web.Response(status=404, text="Session not found")
        if STATIC_UI_INDEX_PATH.exists():
            return web.Response(text=STATIC_UI_INDEX_PATH.read_text(encoding="utf-8"), content_type="text/html")
        return await self._session_html_response(request.match_info["session_id"])

    async def _handle_static_ui_asset(self, request: web.Request) -> web.StreamResponse:
        """Serve a compiled Vite asset without allowing path traversal."""
        relative = Path(request.match_info["asset_path"])
        root = (STATIC_UI_DIR / "assets").resolve()
        candidate = (root / relative).resolve()
        if root not in candidate.parents or not candidate.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(candidate, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    async def _handle_dashboard_health(self, request: web.Request) -> web.Response:
        payload = {
            "ok": True,
            "db_path": str(resolve_db_path()),
            "dashboard_mode": self.dashboard_mode,
            "version": token_tap_VERSION,
        }
        if self.dashboard_mode and _is_trusted_dashboard_token_request(request):
            payload["quit_token"] = self._dashboard_quit_token
        return web.json_response(payload)

    async def _handle_database_settings(self, request: web.Request) -> web.Response:
        """Return the database currently backing this dashboard."""
        return web.json_response({"db_path": str(resolve_db_path()), "can_choose_path": sys.platform == "darwin"})

    async def _handle_choose_database(self, request: web.Request) -> web.Response:
        """Open the native macOS file chooser and return its selected path."""
        if error := self._capture_mutation_error(request):
            return error
        if sys.platform != "darwin":
            return web.json_response({"error": "The native database picker is only available on macOS"}, status=501)
        try:
            payload = await request.json()
        except ValueError:
            payload = {}
        mode = payload.get("mode", "new") if isinstance(payload, dict) else "new"
        current = resolve_db_path()
        if mode == "existing":
            start_folder = current.parent if current.parent.is_dir() else Path.home()
            script = _OPEN_DATABASE_PICKER_SCRIPT
            arguments = (str(start_folder),)
        elif mode == "new":
            start_folder = token_flow_data_dir()
            try:
                start_folder.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                return web.json_response({"error": f"Unable to create the Token Flow data folder: {exc}"}, status=500)
            script = _NEW_DATABASE_PICKER_SCRIPT
            arguments = (str(start_folder), "traces.sqlite3")
        else:
            return web.json_response({"error": "Database picker mode must be existing or new"}, status=400)
        try:
            process = await asyncio.create_subprocess_exec(
                "osascript",
                "-e",
                script,
                *arguments,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
        except OSError as exc:
            return web.json_response({"error": f"Unable to open Finder: {exc}"}, status=500)
        if process.returncode:
            message = stderr.decode("utf-8", errors="replace").strip()
            if "User canceled" in message or "(-128)" in message:
                return web.json_response({"path": None})
            return web.json_response({"error": message or "Finder could not choose a database"}, status=500)
        selected = stdout.decode("utf-8", errors="replace").strip()
        return web.json_response({"path": selected or None})

    async def _handle_set_database(self, request: web.Request) -> web.Response:
        """Persist and immediately switch to a database selected in the dashboard."""
        if error := self._capture_mutation_error(request):
            return error
        capture_state = self.capture_manager.status(enabled=self.dashboard_mode).get("state")
        if capture_state in {"starting", "capturing", "stopping"}:
            return web.json_response({"error": "Stop the active capture before changing databases"}, status=409)
        override_name = next(
            (name for name in ("TOKEN_FLOW_DB", "PACKLITE_DB", "CLOUDTAP_DB") if os.environ.get(name, "").strip()),
            None,
        )
        if override_name:
            return web.json_response(
                {"error": f"The database path is controlled by the {override_name} environment variable"},
                status=409,
            )
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"error": "Body must be JSON"}, status=400)
        raw_path = payload.get("path") if isinstance(payload, dict) else None
        if not isinstance(raw_path, str) or not raw_path.strip():
            return web.json_response({"error": "Database path is required"}, status=400)
        candidate = Path(raw_path.strip()).expanduser()
        if not candidate.is_absolute():
            return web.json_response({"error": "Database path must be absolute"}, status=400)
        candidate = candidate.resolve()
        if candidate.exists() and not candidate.is_file():
            return web.json_response({"error": "Database path must point to a file"}, status=400)
        try:
            probe = TraceStore(candidate)
            probe.close()
            save_configured_db_path(candidate)
            reset_trace_store()
            get_trace_store()
        except (OSError, sqlite3.Error, ValueError) as exc:
            return web.json_response({"error": f"Unable to use that database: {exc}"}, status=400)
        self._dashboard_snapshot = dashboard_trace_snapshot()
        await self._broadcast_dashboard_event({"type": "refresh"})
        return web.json_response({"db_path": str(resolve_db_path()), "can_choose_path": sys.platform == "darwin"})

    async def _handle_choose_project(self, request: web.Request) -> web.Response:
        """Open the native macOS folder chooser for a dashboard-launched CLI."""
        if error := self._capture_mutation_error(request):
            return error
        if sys.platform != "darwin":
            return web.json_response({"error": "The native project picker is only available on macOS"}, status=501)
        current = read_configured_working_directory()
        start_folder = current if current is not None else Path.home()
        try:
            process = await asyncio.create_subprocess_exec(
                "osascript",
                "-e",
                _PROJECT_PICKER_SCRIPT,
                str(start_folder),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
        except OSError as exc:
            return web.json_response({"error": f"Unable to open Finder: {exc}"}, status=500)
        if process.returncode:
            message = stderr.decode("utf-8", errors="replace").strip()
            if "User canceled" in message or "(-128)" in message:
                return web.json_response({"path": None})
            return web.json_response({"error": message or "Finder could not choose a project"}, status=500)
        selected = stdout.decode("utf-8", errors="replace").strip()
        return web.json_response({"path": selected.rstrip("/") or None})

    async def _handle_dashboard_quit(self, request: web.Request) -> web.Response:
        if not self.dashboard_mode:
            return web.json_response(
                {"ok": False, "error": "Dashboard quit is only available in dashboard mode"},
                status=403,
            )
        if not _is_trusted_dashboard_token_request(request):
            return _untrusted_dashboard_token_response()
        token = request.headers.get(_DASHBOARD_QUIT_TOKEN_HEADER)
        if token != self._dashboard_quit_token:
            return web.json_response(
                {"ok": False, "error": "Dashboard quit requires a same-origin token"},
                status=403,
            )

        async def stop_soon() -> None:
            await asyncio.sleep(0.05)
            await self.stop()

        asyncio.create_task(stop_soon())
        return web.json_response({"ok": True})

    def _capture_mutation_error(self, request: web.Request) -> web.Response | None:
        if not self.dashboard_mode:
            return web.json_response(
                {"error": "Capture controls are only available in dashboard mode"},
                status=403,
            )
        if not _is_trusted_dashboard_token_request(request):
            return web.json_response(
                {"error": "Capture controls require a trusted localhost Host and Origin"},
                status=403,
            )
        if request.headers.get(_DASHBOARD_QUIT_TOKEN_HEADER) != self._dashboard_quit_token:
            return web.json_response(
                {"error": "Capture controls require a same-origin token"},
                status=403,
            )
        return None

    async def _handle_token_estimates(self, request: web.Request) -> web.Response:
        """Estimate token counts for prompt blocks with a local tokenizer."""
        try:
            payload = await request.json()
        except ValueError:
            return web.json_response({"error": "Body must be JSON"}, status=400)
        texts = payload.get("texts") if isinstance(payload, dict) else None
        if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
            return web.json_response({"error": "texts must be a list of strings"}, status=400)
        if len(texts) > MAX_ESTIMATE_TEXTS or sum(len(text) for text in texts) > MAX_ESTIMATE_CHARS:
            return web.json_response({"error": "Too much text to estimate in one request"}, status=413)
        try:
            counts = await asyncio.to_thread(estimate_token_counts, texts)
        except EstimatesUnavailable as exc:
            return web.json_response({"error": str(exc)}, status=501)
        return web.json_response({"encoding": ESTIMATE_ENCODING, "counts": counts})

    async def _handle_capture_status(self, _request: web.Request) -> web.Response:
        return web.json_response(self.capture_manager.status(enabled=self.dashboard_mode))

    async def _handle_start_capture(self, request: web.Request) -> web.Response:
        if error := self._capture_mutation_error(request):
            return error
        client = DEFAULT_CAPTURE_CLIENT
        working_directory = None
        if raw := await request.read():
            try:
                payload = json.loads(raw)
            except ValueError:
                return web.json_response({"error": "Capture request body must be JSON"}, status=400)
            if isinstance(payload, dict) and payload.get("client") is not None:
                client = payload["client"]
            if isinstance(payload, dict) and payload.get("working_directory") is not None:
                working_directory = payload["working_directory"]
        plugin = capture_clients().get(client)
        if plugin is None:
            return web.json_response({"error": f"Unsupported capture client: {client}"}, status=400)
        if not self.capture_manager.client_available(client):
            return web.json_response(
                {
                    "error": f"{plugin.picker_label} capture from the dashboard requires macOS with {plugin.picker_label} installed"
                },
                status=501,
            )
        try:
            started = await self.capture_manager.start(client, working_directory)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except OSError:
            return web.json_response(self.capture_manager.status(enabled=self.dashboard_mode), status=500)
        if not started:
            return web.json_response(self.capture_manager.status(enabled=self.dashboard_mode), status=409)
        return web.json_response(self.capture_manager.status(enabled=self.dashboard_mode), status=202)

    async def _handle_stop_capture(self, request: web.Request) -> web.Response:
        if error := self._capture_mutation_error(request):
            return error
        await self.capture_manager.stop()
        return web.json_response(self.capture_manager.status(enabled=self.dashboard_mode))

    async def _handle_index(self, request: web.Request) -> web.Response:
        """Serve the viewer HTML with live mode enabled."""
        if not VIEWER_TEMPLATE_PATH.exists():
            return web.Response(status=404, text="viewer.html not found")

        html = _read_viewer_template()
        # Price provenance has to be present even though the index starts empty:
        # live records arrive over SSE carrying their own costs.
        live_js = (
            "const LIVE_MODE = true;\nconst EMBEDDED_TRACE_DATA = [];\n"
            f"const __TRACE_SESSION_ID__ = {json.dumps(self.session_id or '')};\n"
            f"{_pricing_data_js({})}"
        )
        html = html.replace(
            VIEWER_SCRIPT_ANCHOR,
            f"<script>\n{live_js}</script>\n{VIEWER_SCRIPT_ANCHOR}",
            1,
        )
        return web.Response(text=html, content_type="text/html")

    async def _handle_records(self, request: web.Request) -> web.Response:
        """Return all records as JSON array."""
        async with self._lock:
            return web.json_response([attach_cost_to_record(record) for record in self._records])

    async def _handle_dates(self, request: web.Request) -> web.Response:
        """Return available trace dates (descending)."""
        ensure_trace_store()
        dates, has_legacy = get_trace_store().list_dates()
        return web.json_response({"dates": dates, "has_legacy": has_legacy})

    async def _handle_traces_by_date(self, request: web.Request) -> web.Response:
        """Return combined trace records for a given date."""
        date_key = request.match_info["date"]
        if date_key != "legacy" and not _DATE_RE.match(date_key):
            return web.Response(status=400, text="Invalid date format")

        records = ensure_trace_store().load_records_for_date(date_key)
        return web.json_response([attach_cost_to_record(record) for record in records])

    async def _handle_agents(self, request: web.Request) -> web.Response:
        """Return trace history agent buckets."""
        self._finalize_stale_active_sessions()
        live_count = await self._current_live_record_count()
        return web.json_response({"agents": list_trace_agents(self.session_id, live_record_count=live_count)})

    async def _handle_sessions(self, request: web.Request) -> web.Response:
        """Return trace history sessions."""
        self._finalize_stale_active_sessions()
        live_count = await self._current_live_record_count()
        offset = _session_offset_from_request(request)
        limit = _session_limit_from_request(request)
        query = _session_query_from_request(request)
        aggregates = get_trace_store().get_session_aggregates(query)
        total = aggregates["total_sessions"]
        total_records = aggregates["total_records"]
        total_tokens = aggregates["total_tokens"]
        total_errors = aggregates["total_errors"]
        sessions = list_trace_sessions(
            self.session_id,
            live_record_count=live_count,
            limit=limit,
            offset=offset,
            query=query,
        )
        dates, has_legacy = get_trace_store().list_dates()
        return web.json_response(
            {
                "sessions": sessions,
                "total": total,
                "total_records": total_records,
                "total_tokens": total_tokens,
                "total_errors": total_errors,
                "offset": offset,
                "limit": limit,
                "has_more": offset + len(sessions) < total,
                "dates": dates,
                "has_legacy": has_legacy,
            }
        )

    async def _handle_session_records(self, request: web.Request) -> web.Response:
        """Return one session's summary and records."""
        live_count = await self._current_live_record_count()
        session = load_trace_session(
            request.match_info["session_id"],
            current_session_id=self.session_id,
            record_limit=_record_limit_from_request(request),
            record_offset=_record_offset_from_request(request),
            live_record_count=live_count,
        )
        if session is None:
            return web.json_response({"error": "Session not found"}, status=404)
        session = dict(session)
        if request.query.get("view") == "turns":
            session["records"] = select_trace_turn_records(session.get("records") or [])
        session["records"] = [attach_cost_to_record(record) for record in session.get("records") or []]
        return web.json_response(session)

    async def _handle_session_html_compat(self, request: web.Request) -> web.Response:
        return await self._session_html_response(request.match_info["session_id"])

    async def _session_html_response(self, session_id: str) -> web.Response:
        store = ensure_trace_store()
        if store.load_session_row(session_id) is None:
            return web.Response(status=404, text="Session not found")
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            html_path = tmp_path / f"session-{session_id[:8]}.html"
            export_urls = {
                "jsonl": f"/api/sessions/{quote(session_id)}/export/jsonl",
                "compact": f"/api/sessions/{quote(session_id)}/export/compact",
                "html": f"/api/sessions/{quote(session_id)}/export/html",
            }
            metadata = [
                redact_dashboard_summary(item)
                for record in store.load_records(session_id)
                if (item := _extract_metadata_from_record(record)) is not None
            ]
            _generate_html_viewer_from_metadata(
                metadata,
                html_path,
                display_trace_path=export_urls["compact"],
                display_html_path=f"/dashboard/session/{quote(session_id)}",
                records_api_path=f"/api/sessions/{quote(session_id)}/records",
            )
            if not html_path.exists():
                return web.Response(status=500, text="Failed to generate session viewer")
            html = html_path.read_text(encoding="utf-8")
            export_js = f"const __TRACE_SESSION_EXPORTS__ = {json.dumps(export_urls, separators=(',', ':'))};\n"
            html = html.replace(
                VIEWER_SCRIPT_ANCHOR,
                f"<script>\n{export_js}</script>\n{VIEWER_SCRIPT_ANCHOR}",
                1,
            )
        return web.Response(text=html, content_type="text/html")

    async def _current_live_record_count(self) -> int:
        async with self._lock:
            return len(self._records)

    async def _handle_export_jsonl(self, request: web.Request) -> web.Response:
        session_id = request.match_info["session_id"]
        store = ensure_trace_store()
        if store.load_session_row(session_id) is None:
            return web.Response(status=404, text="Session not found")
        body = store.export_jsonl(session_id)
        filename = f"trace_{session_id[:8]}.jsonl"
        return web.Response(
            body=body,
            content_type="application/x-ndjson",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    async def _handle_export_compact(self, request: web.Request) -> web.Response:
        session_id = request.match_info["session_id"]
        store = ensure_trace_store()
        if store.load_session_row(session_id) is None:
            return web.Response(status=404, text="Session not found")
        body = store.export_compact(session_id)
        filename = f"trace_{session_id[:8]}.ctap.json"
        return web.Response(
            text=body,
            content_type="application/json",
            charset="utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    async def _handle_export_log(self, request: web.Request) -> web.Response:
        session_id = request.match_info["session_id"]
        store = ensure_trace_store()
        if store.load_session_row(session_id) is None:
            return web.Response(status=404, text="Session not found")
        body = store.export_log(session_id)
        filename = f"trace_{session_id[:8]}.log"
        return web.Response(
            text=body,
            content_type="text/plain",
            charset="utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    async def _handle_delete_session(self, request: web.Request) -> web.Response:
        """Delete one stored trace session."""
        session_id = request.match_info["session_id"]
        self._finalize_stale_active_sessions()
        store = ensure_trace_store()
        row = store.load_session_row(session_id)
        if row is None:
            return web.json_response({"error": "Session not found"}, status=404)
        if self.session_id and session_id == self.session_id:
            return web.json_response({"error": "Live session cannot be deleted"}, status=409)
        if _session_row_blocks_delete(row, live_session_id=None):
            return web.json_response({"error": "Active session cannot be deleted"}, status=409)
        result = store.delete_session(session_id)
        await self._broadcast_dashboard_event({"type": "refresh"})
        return web.json_response(result)

    async def _handle_delete_sessions(self, request: web.Request) -> web.Response:
        """Delete multiple stored trace sessions."""
        try:
            payload = await request.json()
        except (json.JSONDecodeError, web.HTTPBadRequest):
            return web.json_response({"error": "Invalid JSON body"}, status=400)
        clear_all = isinstance(payload, dict) and payload.get("clear_all") is True
        raw_ids = payload.get("session_ids") if isinstance(payload, dict) else None
        if not clear_all and not isinstance(raw_ids, list):
            return web.json_response({"error": "session_ids must be a list"}, status=400)

        self._finalize_stale_active_sessions()
        store = ensure_trace_store()
        session_ids = (
            [row["id"] for row in store.list_session_rows()]
            if clear_all
            else [item for item in raw_ids if isinstance(item, str) and item]
        )
        if not session_ids:
            if clear_all:
                return web.json_response(
                    {
                        "deleted_sessions": 0,
                        "deleted_records": 0,
                        "deleted_logs": 0,
                        "missing_sessions": [],
                        "skipped_active_sessions": [],
                    }
                )
            return web.json_response({"error": "No sessions selected"}, status=400)

        deletable_ids = []
        skipped_active = []
        missing_ids = []
        for session_id in dict.fromkeys(session_ids):
            row = store.load_session_row(session_id)
            if row is None:
                missing_ids.append(session_id)
                continue
            if _session_row_blocks_delete(row, live_session_id=self.session_id):
                skipped_active.append(session_id)
                continue
            deletable_ids.append(session_id)

        if not deletable_ids:
            result = {
                "deleted_sessions": 0,
                "deleted_records": 0,
                "deleted_logs": 0,
                "missing_sessions": missing_ids,
                "skipped_active_sessions": skipped_active,
            }
            if clear_all:
                return web.json_response(result)
            return web.json_response({"error": "No selected sessions can be deleted", **result}, status=409)

        result = store.delete_sessions(deletable_ids)
        result["missing_sessions"] = [*missing_ids, *result.get("missing_sessions", [])]
        result["skipped_active_sessions"] = skipped_active
        await self._broadcast_dashboard_event({"type": "refresh"})
        return web.json_response(result)

    async def _handle_export_html(self, request: web.Request) -> web.Response:
        session_id = request.match_info["session_id"]
        store = ensure_trace_store()
        if store.load_session_row(session_id) is None:
            return web.Response(status=404, text="Session not found")
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            html_path = tmp_path / f"trace_{session_id[:8]}.html"
            records = []
            for record in store.load_records(session_id):
                try:
                    normalized = json.loads(_normalize_record_for_viewer(json.dumps(record, ensure_ascii=False)))
                except (TypeError, json.JSONDecodeError):
                    normalized = record
                if isinstance(normalized, dict):
                    records.append(normalized)
            _generate_html_viewer_from_compact_bundle(
                build_compact_trace_bundle(records),
                html_path,
                display_trace_path=f"/api/sessions/{quote(session_id)}/export/compact",
                display_html_path=f"/api/sessions/{quote(session_id)}/export/html",
            )
            if not html_path.exists():
                return web.Response(status=500, text="Failed to generate session viewer")
            body = html_path.read_text(encoding="utf-8")
        filename = f"trace_{session_id[:8]}.html"
        return web.Response(
            text=body,
            content_type="text/html",
            charset="utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    async def _handle_delete_traces_by_date(self, request: web.Request) -> web.Response:
        """Delete stored trace sessions for a selected history date."""
        date_key = request.match_info["date"]
        if date_key != "legacy" and not _DATE_RE.match(date_key):
            return web.json_response({"error": "Invalid date format"}, status=400)
        self._finalize_stale_active_sessions()
        protected: set[str] = set()
        force = request.query.get("force", "").lower() in {"1", "true", "yes"}
        if self.session_id:
            protected.add(self.session_id)
        elif not force:
            for row in get_trace_store().list_session_rows():
                if _session_row_blocks_delete(row, live_session_id=None):
                    protected.add(row["id"])
        try:
            result = delete_trace_history(date_key, protected_session_ids=protected)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(result)


def _session_query_from_request(request: web.Request):
    return build_session_query(
        date=request.query.get("date", ""),
        status=request.query.get("status", ""),
        search=request.query.get("search", ""),
        agent=request.query.get("agent", ""),
    )


def _origin_port(origin) -> int | None:
    if origin.port is not None:
        return origin.port
    if origin.scheme == "http":
        return 80
    if origin.scheme == "https":
        return 443
    return None


def _is_trusted_dashboard_token_request(request: web.Request) -> bool:
    host, host_port = _split_host_port(request.headers.get("Host", ""))
    if not _is_trusted_localhost(host):
        return False

    origin_value = request.headers.get("Origin")
    if not origin_value:
        return True
    try:
        origin = urlsplit(origin_value)
    except ValueError:
        return False
    if origin.scheme not in {"http", "https"} or not _is_trusted_localhost(origin.hostname):
        return False
    try:
        origin_port = _origin_port(origin)
    except ValueError:
        return False
    return host_port is None or origin_port == host_port


def _session_limit_from_request(request: web.Request) -> int:
    value = request.query.get("limit")
    if value is None:
        return DEFAULT_SESSION_PAGE_LIMIT
    try:
        limit = int(value)
    except ValueError:
        return DEFAULT_SESSION_PAGE_LIMIT
    return max(1, min(MAX_SESSION_PAGE_LIMIT, limit))


def _split_host_port(value: str) -> tuple[str, int | None]:
    host = value.strip()
    if not host:
        return "", None
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return host, None
        name = host[1:end]
        rest = host[end + 1 :]
        if rest.startswith(":") and rest[1:].isdigit():
            return name, int(rest[1:])
        return name, None
    if host.count(":") == 1:
        name, port = host.rsplit(":", 1)
        if port.isdigit():
            return name, int(port)
    return host, None


def _is_trusted_localhost(value: str | None) -> bool:
    if value is None:
        return False
    host = value.strip().strip("[]").lower().rstrip(".")
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _untrusted_dashboard_token_response() -> web.Response:
    return web.json_response(
        {"ok": False, "error": "Dashboard quit requires a trusted localhost Host and Origin"},
        status=403,
    )


def _session_row_blocks_delete(row, *, live_session_id: str | None) -> bool:
    """Return True when a stored session must stay undeleted.

    The current live writer is always protected. Remaining `active` rows stay
    protected too; callers finalize stale sessions first, including abandoned
    zero-trace startups after ``STALE_EMPTY_ACTIVE_SESSION_AFTER``.
    """
    if live_session_id and row["id"] == live_session_id:
        return True
    return (row["status"] or "") == "active"


def _session_offset_from_request(request: web.Request) -> int:
    value = request.query.get("offset")
    if value is None:
        return 0
    try:
        offset = int(value)
    except ValueError:
        return 0
    return max(0, offset)


def _record_limit_from_request(request: web.Request) -> int | None:
    value = request.query.get("limit")
    if value is None:
        return None
    try:
        limit = int(value)
    except ValueError:
        return None
    return max(0, limit)


def _record_offset_from_request(request: web.Request) -> int:
    value = request.query.get("offset")
    if value is None:
        return 0
    try:
        offset = int(value)
    except ValueError:
        return 0
    return max(0, offset)
