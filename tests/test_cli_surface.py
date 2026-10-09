from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from token_tap.commands.cli import (
    _dashboard_stop_command,
    _working_directory,
    open_dashboard_main,
    parse_capture_args,
    parse_open_args,
    parse_status_args,
    status_main,
)
from token_tap.core.capture_service import CaptureRequest


def test_capture_command_translates_public_options_and_forwards_agent_args(tmp_path: Path) -> None:
    project, argv = parse_capture_args(
        ["codex", "--project", str(tmp_path), "--no-open", "--dashboard-port", "23000", "--", "--full-auto"]
    )

    assert project == tmp_path.resolve()
    assert argv == [
        "--tap-client",
        "codex",
        "--tap-no-open",
        "--tap-live-port",
        "23000",
        "--",
        "--full-auto",
    ]


def test_capture_command_accepts_product_agent_names() -> None:
    project, argv = parse_capture_args(["codex-app", "--no-open"])

    assert project is None
    assert argv == ["--tap-client", "codexapp", "--tap-no-open"]


def test_shared_capture_request_has_public_and_compatibility_adapters(tmp_path: Path) -> None:
    request = CaptureRequest.create(
        "codex-app",
        project=tmp_path,
        open_dashboard=False,
        dashboard_enabled=False,
        agent_args=("--", "--full-auto"),
    )

    assert request.public_argv() == [
        "capture",
        "codexapp",
        "--project",
        str(tmp_path.resolve()),
        "--no-open",
        "--no-dashboard",
        "--",
        "--full-auto",
    ]
    assert request.legacy_argv() == [
        "--tap-client",
        "codexapp",
        "--tap-no-open",
        "--tap-no-live",
        "--",
        "--full-auto",
    ]


def test_capture_project_is_scoped_to_the_capture(tmp_path: Path) -> None:
    before = Path.cwd()
    with _working_directory(tmp_path):
        assert Path.cwd() == tmp_path
    assert Path.cwd() == before


def test_stop_command_uses_product_facing_options() -> None:
    assert _dashboard_stop_command("0.0.0.0", 23000) == "token-flow stop --port 23000 --host 0.0.0.0"


@pytest.mark.asyncio
async def test_root_dashboard_starts_detached_and_opens_even_when_reused(monkeypatch, tmp_path: Path) -> None:
    opened: list[str] = []
    ensure = AsyncMock(return_value=("http://127.0.0.1:19527", False))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("token_tap.commands.cli.ensure_shared_dashboard", ensure)
    monkeypatch.setattr("token_tap.commands.cli._open_browser", opened.append)
    monkeypatch.setattr("token_tap.commands.cli.resolve_db_path", lambda: tmp_path / "traces.sqlite3")

    assert await open_dashboard_main(parse_open_args([])) == 0
    assert opened == ["http://127.0.0.1:19527"]
    ensure.assert_awaited_once()


@pytest.mark.asyncio
async def test_status_reports_current_dashboard(monkeypatch, tmp_path: Path, capsys) -> None:
    health = AsyncMock(return_value=True)
    monkeypatch.setattr("token_tap.commands.cli.is_dashboard_healthy", health)
    monkeypatch.setattr("token_tap.commands.cli.resolve_db_path", lambda: tmp_path / "traces.sqlite3")

    assert await status_main(parse_status_args([])) == 0
    output = capsys.readouterr().err
    assert "Dashboard running: http://127.0.0.1:" in output
    assert str(tmp_path / "traces.sqlite3") in output
