"""Lifecycle management for capture subprocesses controlled by the server."""

from __future__ import annotations

import asyncio
import signal
import subprocess
import sys
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

CaptureChanged = Callable[[], Awaitable[None]]


class CaptureManager:
    """Start, observe, and stop the managed Codex App capture process."""

    def __init__(self, on_change: CaptureChanged | None = None) -> None:
        self._on_change = on_change
        self._process: asyncio.subprocess.Process | None = None
        self._watch_task: asyncio.Task | None = None
        self._state = "idle"
        self._started_at: str | None = None
        self._exit_code: int | None = None
        self._error: str | None = None
        self._lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return sys.platform == "darwin"

    def status(self, *, enabled: bool = True) -> dict:
        process = self._process
        return {
            "available": enabled and self.available,
            "client": "codexapp",
            "state": self._state,
            "pid": process.pid if process is not None and process.returncode is None else None,
            "started_at": self._started_at,
            "exit_code": self._exit_code,
            "error": self._error,
        }

    async def start(self) -> bool:
        """Start capture; return False if a capture process is already active."""
        async with self._lock:
            if self._process is not None and self._process.returncode is None:
                return False

            self._state = "starting"
            self._started_at = datetime.now(timezone.utc).isoformat()
            self._exit_code = None
            self._error = None
            command = [
                sys.executable,
                "-m",
                "claude_tap",
                "--tap-client",
                "codexapp",
                "--tap-no-open",
                "--tap-no-live",
            ]
            try:
                process = await asyncio.create_subprocess_exec(
                    *command,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError as exc:
                self._state = "error"
                self._error = f"Unable to start Codex App capture: {exc}"
                raise

            self._process = process
            self._state = "capturing"
            self._watch_task = asyncio.create_task(self._watch(process))

        await self._notify_changed()
        return True

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
                self._error = f"Codex App capture exited with code {code}"
            self._watch_task = None
        await self._notify_changed()

    async def _notify_changed(self) -> None:
        if self._on_change is not None:
            await self._on_change()
