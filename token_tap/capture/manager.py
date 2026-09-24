"""Lifecycle management for capture subprocesses controlled by the server."""

from __future__ import annotations

import asyncio
import contextlib
import os
import shlex
import signal
import subprocess
import sys
import tempfile
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path

from token_tap.agents import AGENTS
from token_tap.agents.base import AgentPlugin

CaptureChanged = Callable[[], Awaitable[None]]

_TERMINAL_PID_TIMEOUT_SECONDS = 20.0
_TERMINAL_POLL_SECONDS = 1.0


def capture_clients() -> dict[str, AgentPlugin]:
    """Agents the dashboard can start, in registry order."""
    return {agent_id: plugin for agent_id, plugin in AGENTS.items() if plugin.dashboard_capture is not None}


DEFAULT_CAPTURE_CLIENT = "codexapp"


class _TerminalProcess:
    """A capture running in a Terminal window, tracked by the pid its script reports.

    It mirrors the parts of ``asyncio.subprocess.Process`` the manager uses. The exit
    code of a Terminal process is not observable, so a finished capture reports 0.
    """

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None

    def _alive(self) -> bool:
        try:
            os.kill(self.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    async def wait(self) -> int:
        while self.returncode is None:
            if not self._alive():
                self.returncode = 0
                break
            await asyncio.sleep(_TERMINAL_POLL_SECONDS)
        return self.returncode

    def send_signal(self, sent_signal: int) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.kill(self.pid, sent_signal)

    def terminate(self) -> None:
        self.send_signal(signal.SIGTERM)

    def kill(self) -> None:
        self.send_signal(signal.SIGKILL)


class CaptureManager:
    """Start, observe, and stop one managed capture process at a time."""

    def __init__(self, on_change: CaptureChanged | None = None) -> None:
        self._on_change = on_change
        self._process: asyncio.subprocess.Process | _TerminalProcess | None = None
        self._client = DEFAULT_CAPTURE_CLIENT
        self._watch_task: asyncio.Task | None = None
        self._state = "idle"
        self._started_at: str | None = None
        self._exit_code: int | None = None
        self._error: str | None = None
        self._lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return any(self.client_available(client) for client in capture_clients())

    def client_available(self, client: str) -> bool:
        return self.unavailable_reason(client) is None

    def unavailable_reason(self, client: str) -> str | None:
        """Why the dashboard cannot start ``client``: unsupported platform or not installed."""
        plugin = capture_clients().get(client)
        if plugin is None or sys.platform not in plugin.dashboard_capture.platforms:
            return "platform"
        return None if plugin.resolve_executable(None) is not None else "not_installed"

    def status(self, *, enabled: bool = True) -> dict:
        process = self._process
        return {
            "enabled": enabled,
            "available": enabled and self.available,
            "client": self._client,
            "clients": [self._client_status(plugin, enabled) for plugin in capture_clients().values()],
            "cwd": str(Path.cwd()),
            "state": self._state,
            "pid": process.pid if process is not None and process.returncode is None else None,
            "started_at": self._started_at,
            "exit_code": self._exit_code,
            "error": self._error,
        }

    def _client_status(self, plugin: AgentPlugin, enabled: bool) -> dict:
        reason = self.unavailable_reason(plugin.id)
        return {
            "id": plugin.id,
            "label": plugin.picker_label,
            "available": enabled and reason is None,
            "reason": reason,
            "terminal": plugin.dashboard_capture.terminal,
            "command": plugin.config.cmd if plugin.dashboard_capture.terminal else None,
            "install_url": plugin.config.install_url,
        }

    async def start(self, client: str = DEFAULT_CAPTURE_CLIENT) -> bool:
        """Start capture; return False if a capture process is already active."""
        plugin = capture_clients()[client]
        async with self._lock:
            if self._process is not None and self._process.returncode is None:
                return False

            self._client = client
            self._state = "starting"
            self._started_at = datetime.now(timezone.utc).isoformat()
            self._exit_code = None
            self._error = None
            command = [
                sys.executable,
                "-m",
                "token_tap",
                "--tap-client",
                client,
                "--tap-no-open",
                "--tap-no-live",
            ]
            try:
                if plugin.dashboard_capture.terminal:
                    process = await self._start_in_terminal(command)
                else:
                    process = await asyncio.create_subprocess_exec(
                        *command,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
            except OSError as exc:
                self._state = "error"
                self._error = f"Unable to start {plugin.picker_label} capture: {exc}"
                raise

            self._process = process
            self._state = "capturing"
            self._watch_task = asyncio.create_task(self._watch(process))

        await self._notify_changed()
        return True

    async def _start_in_terminal(self, command: list[str]) -> _TerminalProcess:
        """Open a Terminal window running ``command`` in the dashboard's directory."""
        run_dir = Path(tempfile.mkdtemp(prefix="token-flow-capture-"))
        pid_file = run_dir / "pid"
        script = run_dir / "capture.command"
        script.write_text(
            "#!/bin/sh\n"
            f"echo $$ > {shlex.quote(str(pid_file))}\n"
            f"cd {shlex.quote(str(Path.cwd()))}\n"
            f"exec {shlex.join(command)}\n"
        )
        script.chmod(0o700)
        opener = await asyncio.create_subprocess_exec(
            "open",
            "-a",
            "Terminal",
            str(script),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if await opener.wait() != 0:
            raise OSError("Terminal could not be opened")

        loop = asyncio.get_running_loop()
        deadline = loop.time() + _TERMINAL_PID_TIMEOUT_SECONDS
        while loop.time() < deadline:
            with contextlib.suppress(OSError, ValueError):
                return _TerminalProcess(int(pid_file.read_text().strip()))
            await asyncio.sleep(0.2)
        raise OSError("the Terminal window did not start the capture")

    async def stop(self, *, notify: bool = True) -> None:
        async with self._lock:
            process = self._process
            if process is None or process.returncode is not None:
                self._process = None
                if self._state != "error":
                    self._state = "idle"
                watch_task = self._watch_task
                self._watch_task = None
            else:
                self._state = "stopping"
                watch_task = self._watch_task
                self._watch_task = None

        if process is None or process.returncode is not None:
            if watch_task is not None and watch_task is not asyncio.current_task():
                watch_task.cancel()
                try:
                    await watch_task
                except asyncio.CancelledError:
                    pass
            return

        if notify:
            await self._notify_changed()
        try:
            if sys.platform == "win32":
                process.terminate()
            else:
                process.send_signal(signal.SIGINT)
            await asyncio.wait_for(process.wait(), timeout=12)
        except asyncio.TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        finally:
            async with self._lock:
                self._exit_code = process.returncode
                if self._process is process:
                    self._process = None
                self._state = "idle"
                self._error = None
            if watch_task is not None and watch_task is not asyncio.current_task():
                watch_task.cancel()
                try:
                    await watch_task
                except asyncio.CancelledError:
                    pass
            if notify:
                await self._notify_changed()

    async def cleanup(self) -> None:
        """Stop the child process as part of application shutdown."""
        await self.stop(notify=False)

    async def _watch(self, process: asyncio.subprocess.Process) -> None:
        try:
            code = await process.wait()
        except asyncio.CancelledError:
            return

        async with self._lock:
            if process is not self._process:
                return
            self._exit_code = code
            self._process = None
            if self._state == "stopping" or code == 0:
                self._state = "idle"
                self._error = None
            else:
                self._state = "error"
                self._error = f"{AGENTS[self._client].picker_label} capture exited with code {code}"
            self._watch_task = None
        await self._notify_changed()

    async def _notify_changed(self) -> None:
        if self._on_change is not None:
            await self._on_change()
