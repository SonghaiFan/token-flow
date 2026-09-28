"""Pytest configuration and shared fixtures."""

import asyncio
import os
import shutil
import socket
import sys
import tempfile
from pathlib import Path

import pytest

from token_tap.agents.base import _extend_no_proxy
from token_tap.server.shared_dashboard import stop_dashboard_service
from token_tap.storage.trace_store import get_trace_store, reset_trace_store


def playwright_skip_reason() -> str | None:
    """Return why browser tests cannot run here, or None when they can.

    The playwright package and the chromium binary install separately, so
    checking only the import makes a browser-less environment fail instead of
    skip. Callers use this as a `pytest.mark.skipif` condition.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return "playwright not installed"

    with sync_playwright() as pw:
        if not Path(pw.chromium.executable_path).exists():
            return "chromium not installed (run: python -m playwright install chromium)"
    return None


def trace_db_path(trace_dir: str | Path) -> Path:
    return Path(trace_dir) / "packlite-test.sqlite3"


def e2e_env(env: dict[str, str], trace_dir: str | Path) -> dict[str, str]:
    updated = dict(env)
    updated["TOKEN_FLOW_DB"] = str(trace_db_path(trace_dir))
    _extend_no_proxy(updated, ("localhost", "127.0.0.1", "::1"))
    return updated


def read_trace_records(trace_dir: str | Path, *, session_index: int = -1) -> list[dict]:
    db_path = trace_db_path(trace_dir)
    reset_trace_store()
    os.environ["TOKEN_FLOW_DB"] = str(db_path)
    store = get_trace_store()
    rows = store.list_session_rows()
    if not rows:
        return []
    session_id = rows[session_index]["id"]
    return store.load_records(session_id)


def read_proxy_log(trace_dir: str | Path, *, session_index: int = -1) -> str:
    db_path = trace_db_path(trace_dir)
    reset_trace_store()
    os.environ["TOKEN_FLOW_DB"] = str(db_path)
    store = get_trace_store()
    rows = store.list_session_rows()
    if not rows:
        return ""
    session_id = rows[session_index]["id"]
    return store.export_log(session_id)


@pytest.fixture(autouse=True)
def isolate_trace_store(monkeypatch, tmp_path):
    """Reset trace storage and both current and compatibility overrides."""
    monkeypatch.setenv("TOKEN_FLOW_SETTINGS", str(tmp_path / "token-flow-settings.json"))
    saved_db = os.environ.get("TOKEN_FLOW_DB")
    saved_legacy_db = os.environ.get("CLOUDTAP_DB")
    os.environ.pop("TOKEN_FLOW_DB", None)
    os.environ.pop("CLOUDTAP_DB", None)
    reset_trace_store()
    yield
    reset_trace_store()
    if saved_db is None:
        os.environ.pop("TOKEN_FLOW_DB", None)
    else:
        os.environ["TOKEN_FLOW_DB"] = saved_db
    if saved_legacy_db is None:
        os.environ.pop("CLOUDTAP_DB", None)
    else:
        os.environ["CLOUDTAP_DB"] = saved_legacy_db


def _free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _is_port_listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture(autouse=True)
def isolate_shared_dashboard(monkeypatch):
    """Keep tests off the user's real dashboard port and out of their browser.

    CLI runs without ``--tap-no-live`` spawn a detached shared dashboard. On
    the default port that would displace the user's dashboard and outlive the
    test's temporary DB, so every test gets its own ephemeral port (inherited
    by subprocesses through the environment) and anything left listening
    there is stopped on teardown.
    """
    port = _free_local_port()
    monkeypatch.setenv("TOKEN_FLOW_DASHBOARD_PORT", str(port))
    monkeypatch.delenv("PACKLITE_DASHBOARD_PORT", raising=False)
    monkeypatch.delenv("CLOUDTAP_DASHBOARD_PORT", raising=False)
    if sys.platform != "win32":
        # webbrowser honors $BROWSER; `true` accepts the URL and opens nothing.
        monkeypatch.setenv("BROWSER", "true")
    yield port
    if _is_port_listening(port):
        asyncio.run(stop_dashboard_service("127.0.0.1", port))


@pytest.fixture
def trace_db(tmp_path, monkeypatch):
    """Provide an isolated SQLite trace database for each test."""
    db_path = tmp_path / "test-traces.sqlite3"
    monkeypatch.setenv("TOKEN_FLOW_DB", str(db_path))
    reset_trace_store()
    yield db_path
    reset_trace_store()


@pytest.fixture
def temp_trace_dir():
    """Create a temporary directory for trace output."""
    trace_dir = tempfile.mkdtemp(prefix="packlite_test_")
    yield trace_dir
    shutil.rmtree(trace_dir, ignore_errors=True)


@pytest.fixture
def temp_bin_dir():
    """Create a temporary directory for fake binaries."""
    bin_dir = tempfile.mkdtemp(prefix="token_tap_bin_")
    yield bin_dir
    shutil.rmtree(bin_dir, ignore_errors=True)


@pytest.fixture
def project_dir():
    """Return the project root directory."""
    return Path(__file__).parent.parent
