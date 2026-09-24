"""Codex App (the Codex desktop host inside Codex.app or ChatGPT.app) agent plugin."""

from __future__ import annotations

import asyncio
import os
import plistlib
import re
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    DashboardCapture,
    LaunchContext,
)
from token_tap.commands.cli_output import print_status as _print

_CODEX_APP_FAST_EXIT_HINT_SECONDS = 5.0


# Standalone Codex.app and the current ChatGPT.app bundle (same CFBundleIdentifier
# com.openai.codex) both host the desktop Codex runtime.
# Keep this ERE-compatible for ``pgrep -fl`` (no non-capturing ``(?:...)`` groups).
_CODEX_APP_PROCESS_RE = (
    r"(Codex|ChatGPT)\.app/Contents/"
    r"(MacOS/(Codex|ChatGPT)|Resources/codex( app-server)?)"
)


_CODEX_APP_QUIT_TIMEOUT_SECONDS = 10.0


_CODEX_APP_EXECUTABLE_ENV = "CODEX_APP_EXECUTABLE"


_CODEX_APP_BUNDLE_ID = "com.openai.codex"


_CODEX_APP_DEFAULT_EXECUTABLES = (
    Path("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
    Path("/Applications/Codex.app/Contents/MacOS/Codex"),
)


_TOKEN_FLOW_STATE_ROOT = Path.home() / ".token-flow"


_PACKLITE_STATE_ROOT = Path.home() / ".packlite"


_INHERITED_STATE_ROOT = Path.home() / ".claude-tap"


if _TOKEN_FLOW_STATE_ROOT.exists():
    _ACTIVE_STATE_ROOT = _TOKEN_FLOW_STATE_ROOT
elif _PACKLITE_STATE_ROOT.exists():
    _ACTIVE_STATE_ROOT = _PACKLITE_STATE_ROOT
elif _INHERITED_STATE_ROOT.exists():
    _ACTIVE_STATE_ROOT = _INHERITED_STATE_ROOT
else:
    _ACTIVE_STATE_ROOT = _TOKEN_FLOW_STATE_ROOT


_CODEX_APP_ISOLATED_PROFILE_ROOT = _ACTIVE_STATE_ROOT / "codex-app-profiles"


# Kept for tests/docs that refer to the historical fixed path; launches now use a
# per-run directory under ``_CODEX_APP_ISOLATED_PROFILE_ROOT``.
_CODEX_APP_ISOLATED_PROFILE_DIR = _CODEX_APP_ISOLATED_PROFILE_ROOT / "tap"


_CODEX_APP_PROCESS_CHATGPT_BUNDLE_RE = re.compile(r"(/[^\s]*ChatGPT\.app)(?:/|\s|$)")


@dataclass(frozen=True)
class CodexAppLaunchPlan:
    """How ``--tap-client codexapp`` should launch the desktop host."""

    proceed: bool
    user_data_dir: Path | None = None


def _codex_app_executable_candidates() -> tuple[Path, ...]:
    """Return candidate Codex App executable paths, most specific first.

    ``CODEX_APP_EXECUTABLE`` lets users override the install location (e.g. a
    non-standard install path or a test build). Default macOS locations cover
    both the legacy standalone ``Codex.app`` bundle and the current
    ``ChatGPT.app`` bundle that ships the same ``com.openai.codex`` runtime.
    """
    configured = os.environ.get(_CODEX_APP_EXECUTABLE_ENV)
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured).expanduser())
    if sys.platform == "darwin":
        for executable in _CODEX_APP_DEFAULT_EXECUTABLES:
            candidates.append(executable)
            candidates.append(Path.home() / executable.relative_to("/"))
    return tuple(candidates)


def _macos_bundle_identifier_for_executable(executable: Path) -> str | None:
    """Return ``CFBundleIdentifier`` for a macOS ``.app`` executable, if present."""
    info_plist = executable.expanduser().resolve(strict=False).parent.parent / "Info.plist"
    if not info_plist.is_file():
        return None
    try:
        with info_plist.open("rb") as handle:
            payload = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    bundle_id = payload.get("CFBundleIdentifier") if isinstance(payload, dict) else None
    return bundle_id if isinstance(bundle_id, str) and bundle_id else None


def _is_codex_desktop_executable(executable: Path) -> bool:
    """Return True when ``executable`` is a usable Codex desktop host binary.

    ``ChatGPT.app`` may still be the pre-unification ChatGPT desktop on some
    machines, so paths under ``ChatGPT.app`` (and other non-``Codex.app``
    bundles) must advertise ``CFBundleIdentifier == com.openai.codex``.
    Legacy ``Codex.app`` installs are accepted by path. Bare test binaries
    without an ``Info.plist`` remain allowed for overrides/tests.
    """
    if not executable.is_file():
        return False
    path_text = executable.as_posix()
    if "Codex.app/" in path_text:
        return True
    bundle_id = _macos_bundle_identifier_for_executable(executable)
    if bundle_id is None:
        # No app metadata (test stub / unpackaged override): allow the file.
        return "ChatGPT.app/" not in path_text
    return bundle_id == _CODEX_APP_BUNDLE_ID


def _is_codex_desktop_process_line(line: str) -> bool:
    """Return True when a ``pgrep -fl`` line belongs to a Codex desktop host.

    Path-only matching would treat a pre-unification ``ChatGPT.app`` process as
    Codex and force an isolated profile even when only legacy ChatGPT is open.
    ``Codex.app`` paths are accepted; ``ChatGPT.app`` requires the Codex bundle
    id; ``CODEX_APP_EXECUTABLE`` overrides match by path substring.
    """
    if "Codex.app/" in line:
        return True
    configured = os.environ.get(_CODEX_APP_EXECUTABLE_ENV, "").strip()
    if configured and str(Path(configured).expanduser()) in line:
        return True
    match = _CODEX_APP_PROCESS_CHATGPT_BUNDLE_RE.search(line)
    if match is None:
        return False
    info_plist = Path(match.group(1)) / "Contents" / "Info.plist"
    if not info_plist.is_file():
        return False
    try:
        with info_plist.open("rb") as handle:
            payload = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return False
    bundle_id = payload.get("CFBundleIdentifier") if isinstance(payload, dict) else None
    return bundle_id == _CODEX_APP_BUNDLE_ID


def _codex_app_existing_processes() -> list[str]:
    if sys.platform != "darwin":
        return []
    try:
        configured_executable = os.environ.get(_CODEX_APP_EXECUTABLE_ENV)
        process_patterns = [_CODEX_APP_PROCESS_RE]
        if configured_executable:
            process_patterns.append(re.escape(str(Path(configured_executable).expanduser())))
        result = subprocess.run(
            ["pgrep", "-fl", f"({'|'.join(process_patterns)})"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode not in {0, 1}:
        return []
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    current_pid = str(os.getpid())
    return [line for line in lines if not line.startswith(f"{current_pid} ") and _is_codex_desktop_process_line(line)]


def _quit_codex_app() -> bool:
    try:
        result = subprocess.run(
            ["osascript", "-e", 'tell application id "com.openai.codex" to quit'],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


async def _wait_for_codex_app_exit(timeout_seconds: float = _CODEX_APP_QUIT_TIMEOUT_SECONDS) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        if not _codex_app_existing_processes():
            return True
        if asyncio.get_running_loop().time() >= deadline:
            return False
        await asyncio.sleep(0.25)


def _codex_app_isolated_profile_dir() -> Path:
    override = os.environ.get("CODEX_APP_USER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    # Unique per launch so a leftover isolated Codex/ChatGPT window does not
    # steal the next ``--proxy-server`` / CA environment via Chromium handoff.
    return _CODEX_APP_ISOLATED_PROFILE_ROOT / f"tap-{uuid.uuid4().hex}"


async def _prepare_codex_app_forward_launch() -> CodexAppLaunchPlan:
    """Decide how to launch Codex/ChatGPT App under the forward proxy.

    If no desktop instance is running, launch against the normal profile so the
    user keeps an existing login. If one is already running, Chromium would
    usually hand the second launch to that process and drop our proxy/CA env.
    In that case launch an isolated ``--user-data-dir`` instance instead of
    forcing the user to quit their active work.

    ``CODEX_APP_USER_DATA_DIR`` always forces an isolated profile, even when no
    desktop instance is currently running.
    """
    processes = _codex_app_existing_processes()
    forced_profile = bool(os.environ.get("CODEX_APP_USER_DATA_DIR", "").strip())
    if not processes and not forced_profile:
        return CodexAppLaunchPlan(proceed=True)

    profile_dir = _codex_app_isolated_profile_dir()
    profile_dir.mkdir(parents=True, exist_ok=True)
    if processes:
        _print("\n⚠️  Codex/ChatGPT App is already running.")
        _print("   Launching an isolated second instance with a dedicated profile so the")
        _print("   current window keeps working and the new one inherits HTTPS_PROXY/CA.")
        for line in processes[:3]:
            _print(f"   {line}")
        if len(processes) > 3:
            _print(f"   ... {len(processes) - 3} more process(es)")
    else:
        _print("\nℹ️  Using isolated Codex/ChatGPT profile from CODEX_APP_USER_DATA_DIR.")
    _print(f"   Isolated profile: {profile_dir}")
    _print("   You may need to sign in again inside the tapped window.")
    return CodexAppLaunchPlan(proceed=True, user_data_dir=profile_dir)


CONFIG = ClientConfig(
    # Prefer the current ChatGPT.app host binary when present; resolution
    # still falls back through _codex_app_executable_candidates().
    cmd="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    label="Codex App",
    install_url="https://openai.com/codex",
    base_url_env="CODEX_APP_BASE_URL",
    base_url_suffix="",
    default_target="https://chatgpt.com/backend-api/codex",
    default_proxy_mode="forward",
    auto_trust_ca_macos=True,
    forward_trace_methods=("POST", "WEBSOCKET"),
    forward_trace_path_prefixes=(
        "/backend-api/codex/responses",
        "/v1/responses",
    ),
)


class CodexAppPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Codex App"
    dashboard_capture = DashboardCapture()
    forward_only = True
    hide_child_output = True

    def resolve_executable(self, client_cmd: str | None) -> str | None:
        # A macOS .app bundle, not a PATH binary: try the override and install locations.
        if client_cmd:
            return super().resolve_executable(client_cmd)
        for candidate in _codex_app_executable_candidates():
            if _is_codex_desktop_executable(candidate):
                return str(candidate)
        return None

    def missing_executable_help(self) -> str:
        return (
            "\nError: Codex desktop app executable not found.\n"
            "Install Codex.app or ChatGPT.app (bundle id com.openai.codex) in "
            "/Applications, or set "
            f"{_CODEX_APP_EXECUTABLE_ENV}=/path/to/App.app/Contents/MacOS/<Executable>.\n"
        )

    async def prepare_launch(self, proxy_mode: str) -> dict[str, object] | None:
        if proxy_mode != "forward":
            return {}
        plan = await _prepare_codex_app_forward_launch()
        if not plan.proceed:
            return None
        return {"user_data_dir": plan.user_data_dir}

    def configure_forward(self, ctx: LaunchContext) -> None:
        ctx.args.insert(0, f"--proxy-server={ctx.proxy_url}")
        user_data_dir = ctx.state.get("user_data_dir")
        if isinstance(user_data_dir, Path):
            user_data_dir.mkdir(parents=True, exist_ok=True)
            ctx.args.insert(0, f"--user-data-dir={user_data_dir}")

    def exit_hint(self, ctx: LaunchContext, code: int, elapsed: float) -> str | None:
        if ctx.proxy_mode != "forward" or code != 0 or elapsed >= _CODEX_APP_FAST_EXIT_HINT_SECONDS:
            return None
        return (
            "   Codex App exited immediately. If macOS printed something like "
            "'opening in an existing browser session', an already-running "
            "Codex/ChatGPT App handled the launch and did not inherit "
            "Token Flow's HTTPS_PROXY/CA environment. Quit the app completely, "
            "then run this command again."
        )


PLUGIN = CodexAppPlugin("codexapp")
