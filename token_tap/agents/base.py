"""Shared contract for Token Flow agent plugins.

An agent plugin describes one supported client: how to launch it under the
capture proxy, where its model traffic goes, and how the dashboard offers it.
Each client lives in its own module under ``token_tap.agents``; the registry in
``token_tap.agents.__init__`` is the only list of supported clients.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path


def _is_truthy_env_value(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class ClientConfig:
    """Per-client configuration for supported AI CLI tools."""

    cmd: str
    label: str
    install_url: str
    base_url_env: str
    base_url_suffix: str  # appended to http://127.0.0.1:{port}
    default_target: str
    extra_base_url_envs: tuple[str, ...] = ()
    nesting_env_keys: tuple[str, ...] = ()  # env vars to clear before launch
    # Some CLIs need process env duplicated into a CLI settings payload.
    inject_settings_env: bool = False
    # Reverse proxy URL normalization. Example: Codex OAuth receives /v1/* but
    # its upstream target already points at a /codex backend that expects /*.
    strip_path_prefix: str = ""
    strip_path_prefix_unless_target_contains: tuple[str, ...] = ()
    # Default proxy mode when --tap-proxy-mode is not explicitly set.
    # Multi-provider clients (e.g. hermes, opencode, pi) default to "forward" so that all
    # provider traffic is captured regardless of which env var the client honors.
    default_proxy_mode: str = "reverse"
    # Some non-Python/non-Node macOS clients do not honor per-process CA env
    # variables, so they need the forward-proxy CA in the user login keychain.
    auto_trust_ca_macos: bool = False
    # Some clients honor a native provider URL for the core model API but ignore
    # HTTPS_PROXY for that API. In forward mode, point those env vars back at the
    # local proxy and let the forward proxy bridge selected paths to target.
    forward_base_url_envs: tuple[str, ...] = ()
    forward_base_url_allowed_path_prefixes: tuple[str, ...] = ()
    # Empty allowlists preserve the default behavior: trace every forward-proxied
    # request that is not skipped by generic noise filters. Clients with noisy
    # product traffic can still relay everything while persisting only model API calls.
    forward_trace_methods: tuple[str, ...] = ()
    forward_trace_path_prefixes: tuple[str, ...] = ()
    forward_trace_path_suffixes: tuple[str, ...] = ()
    # Extra client product endpoints accepted by the reverse proxy. Keep these
    # client-scoped so one client's control-plane routes do not broaden every
    # reverse proxy instance.
    reverse_allowed_path_prefixes: tuple[str, ...] = ()
    # When set, accepted reverse-proxy traffic outside these prefixes is
    # relayed without persistence. This avoids storing account/control-plane
    # responses while preserving the model traffic users launched us to trace.
    reverse_trace_path_prefixes: tuple[str, ...] = ()
    # Decides per launch whether an extra base URL env var is rewritten to the
    # reverse proxy. Claude only rewrites Bedrock/Vertex URLs when those modes are on.
    rewrite_extra_base_url_env: Callable[[str], bool] | None = None

    @property
    def missing_help(self) -> str:
        return (
            f"\nError: '{self.cmd}' command not found in PATH.\nPlease install {self.label} first: {self.install_url}\n"
        )

    def reverse_base_url(self, port: int) -> str:
        return f"http://127.0.0.1:{port}{self.base_url_suffix}"

    @property
    def reverse_base_url_envs(self) -> tuple[str, ...]:
        seen: set[str] = set()
        env_keys: list[str] = []
        for env_key in (self.base_url_env, *self.extra_base_url_envs):
            if env_key in seen:
                continue
            seen.add(env_key)
            env_keys.append(env_key)
        return tuple(env_keys)

    def reverse_base_url_env_map(self, port: int) -> dict[str, str]:
        base_url = self.reverse_base_url(port)
        env_map: dict[str, str] = {}
        for env_key in self.reverse_base_url_envs:
            if (
                env_key in self.extra_base_url_envs
                and self.rewrite_extra_base_url_env is not None
                and not self.rewrite_extra_base_url_env(env_key)
            ):
                continue
            env_map[env_key] = base_url
        return env_map

    def reverse_strip_path_prefix(self, target: str) -> str:
        if not self.strip_path_prefix:
            return ""
        if any(marker in target for marker in self.strip_path_prefix_unless_target_contains):
            return ""
        return self.strip_path_prefix


def _extend_no_proxy(env: dict[str, str], values: tuple[str, ...]) -> None:
    """Append local proxy bypasses without discarding existing settings."""
    existing: list[str] = []
    for key in ("NO_PROXY", "no_proxy"):
        raw = env.get(key, "")
        existing.extend(part.strip() for part in raw.split(",") if part.strip())
    if "*" in existing:
        env["NO_PROXY"] = "*"
        env["no_proxy"] = "*"
        return

    merged: list[str] = []
    seen: set[str] = set()
    for value in [*existing, *values]:
        lowered = value.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        merged.append(value)

    no_proxy = ",".join(merged)
    env["NO_PROXY"] = no_proxy
    env["no_proxy"] = no_proxy


def _has_settings_arg(args: list[str]) -> bool:
    return any(arg == "--settings" or arg.startswith("--settings=") for arg in args)


def _settings_arg(env_values: dict[str, str]) -> list[str]:
    settings_payload = {"env": env_values}
    return ["--settings", json.dumps(settings_payload, separators=(",", ":"))]


def _resolve_env_value(env_key: str) -> str:
    """Resolve an env key from process env or Claude settings files."""
    value = os.environ.get(env_key, "").strip()
    if value:
        return value
    candidate_paths = (
        Path.cwd() / ".claude" / "settings.local.json",
        Path.cwd() / ".claude" / "settings.json",
        Path.home() / ".claude" / "settings.json",
    )
    for path in candidate_paths:
        found = _read_settings_env_base_url(path, env_key)
        if found:
            return found
    return ""


def _read_settings_env_base_url(path: Path, env_key: str) -> str | None:
    """Read a provider base URL from a Claude-style settings file."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    env = data.get("env")
    if not isinstance(env, dict):
        return None
    value = env.get(env_key)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _multi_provider_reverse_env(port: int) -> dict[str, str]:
    proxy_url = f"http://127.0.0.1:{port}"
    return {
        "KIMI_BASE_URL": proxy_url,
        "MOONSHOT_BASE_URL": f"{proxy_url}/v1",
        "OPENAI_BASE_URL": f"{proxy_url}/v1",
        "ANTHROPIC_BASE_URL": proxy_url,
        "GOOGLE_GEMINI_BASE_URL": proxy_url,
        "OPENROUTER_BASE_URL": f"{proxy_url}/v1",
        "CUSTOM_BASE_URL": f"{proxy_url}/v1",
    }


@dataclass(frozen=True)
class DashboardCapture:
    """How the dashboard's Capture menu starts an agent."""

    # Interactive TUI clients run in their own Terminal window.
    terminal: bool = False
    platforms: tuple[str, ...] = ("darwin",)


@dataclass
class LaunchContext:
    """Mutable launch state shared by the generic launcher and one plugin."""

    port: int
    proxy_mode: str
    capture_only: bool
    ca_cert_path: Path | None
    env: dict[str, str]
    args: list[str]
    # Plugin-owned values carried from preflight to exit (e.g. a sandbox path).
    state: dict[str, object] = field(default_factory=dict)
    cleanup_paths: list[Path] = field(default_factory=list)

    @property
    def proxy_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


class AgentPlugin:
    """One supported agent client. Subclasses override only the hooks they need."""

    config: ClientConfig
    # Name shown on dashboard conversations. ``None`` keeps the raw client id,
    # which older stored sessions were grouped by.
    display_label: str | None = None
    # How the dashboard's Capture picker starts this agent; ``None`` hides it.
    # CLI agents are interactive, so by default they open in a Terminal window.
    dashboard_capture: DashboardCapture | None = DashboardCapture(terminal=True)
    forward_only = False
    # GUI clients with noisy stdio keep it detached from Token Flow's terminal.
    hide_child_output = False
    # Node clients read proxy env vars only when built-in env proxy is enabled.
    node_env_proxy = False

    def __init__(self, agent_id: str) -> None:
        self.id = agent_id

    @property
    def dashboard_label(self) -> str:
        return self.display_label or self.id

    @property
    def picker_label(self) -> str:
        """Name in the Capture picker, where every agent needs a readable name."""
        return self.display_label or self.config.label

    # -- Discovery -------------------------------------------------------

    def resolve_executable(self, client_cmd: str | None) -> str | None:
        if client_cmd:
            return str(Path(client_cmd)) if Path(client_cmd).is_file() else None
        return shutil.which(self.config.cmd)

    def missing_executable_help(self) -> str:
        return self.config.missing_help

    def detect_target(self, args: Sequence[str]) -> str:
        """Upstream the client would call without Token Flow."""
        return self.config.default_target

    # -- Launch ----------------------------------------------------------

    def prepare_args(self, args: list[str]) -> list[str]:
        return args

    async def prepare_launch(self, proxy_mode: str) -> dict[str, object] | None:
        """Run before capture starts. Return launch state, or ``None`` to abort."""
        return {}

    def forward_launch_error(self, env: dict[str, str]) -> str | None:
        """Explain why forward capture cannot work in this environment."""
        return None

    def configure_forward(self, ctx: LaunchContext) -> None:
        """Adjust env/args after the shared forward-proxy environment is set."""

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        return self.config.reverse_base_url_env_map(ctx.port)

    def configure_reverse(self, ctx: LaunchContext) -> None:
        """Adjust env/args after the reverse-proxy base URLs are applied."""
        ctx.env["NO_PROXY"] = "127.0.0.1"

    def reverse_summary(self, ctx: LaunchContext) -> list[str]:
        return [f"{key}={value}" for key, value in self.config.reverse_base_url_env_map(ctx.port).items()]

    def on_launch_error(self, ctx: LaunchContext) -> None:
        """Undo launch preparation when the client process cannot start."""

    def after_exit(self, ctx: LaunchContext, code: int, elapsed: float) -> None:
        """Persist client state once the process ends, even after an error."""

    def exit_hint(self, ctx: LaunchContext, code: int, elapsed: float) -> str | None:
        """Explain an unexpected exit, printed after the exit status."""
        return None
