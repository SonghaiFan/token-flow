"""Shared capture requests used by the CLI and dashboard adapters.

The public CLI and the dashboard express the same application operation in
different ways.  Keep product-facing names, project validation, and worker
arguments here so neither adapter has to translate capture semantics itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from token_tap.agents import AGENTS

PUBLIC_AGENT_ALIASES = {
    "antigravity": "agy",
    "codex-app": "codexapp",
    "deepseek": "dsh",
}


def resolve_capture_agent(agent: str) -> str:
    """Resolve a product-facing agent name to its plugin id."""
    agent_id = PUBLIC_AGENT_ALIASES.get(agent, agent)
    if agent_id not in AGENTS:
        names = sorted({*PUBLIC_AGENT_ALIASES, *(name for name in AGENTS if name not in PUBLIC_AGENT_ALIASES.values())})
        raise ValueError(f"unknown agent '{agent}' (choose from: {', '.join(names)})")
    return agent_id


def resolve_capture_project(path: str | Path | None, *, required: bool = False) -> Path | None:
    """Validate an explicitly selected project directory."""
    if path is None:
        if required:
            raise ValueError("Choose a project folder before starting a terminal agent")
        return None

    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        raise ValueError("Project folder must be an absolute path")
    try:
        project = candidate.resolve(strict=True)
    except OSError as exc:
        raise ValueError("Project folder does not exist") from exc
    if not project.is_dir():
        raise ValueError("Project folder must be a directory")
    return project


@dataclass(frozen=True)
class CaptureRequest:
    """Canonical application request for starting one capture worker."""

    agent: str
    project: Path | None = None
    open_dashboard: bool = True
    dashboard_enabled: bool = True
    dashboard_port: int | None = None
    agent_args: tuple[str, ...] = ()

    @classmethod
    def create(
        cls,
        agent: str,
        *,
        project: str | Path | None = None,
        require_project: bool = False,
        open_dashboard: bool = True,
        dashboard_enabled: bool = True,
        dashboard_port: int | None = None,
        agent_args: tuple[str, ...] = (),
    ) -> "CaptureRequest":
        return cls(
            agent=resolve_capture_agent(agent),
            project=resolve_capture_project(project, required=require_project),
            open_dashboard=open_dashboard,
            dashboard_enabled=dashboard_enabled,
            dashboard_port=dashboard_port,
            agent_args=agent_args,
        )

    def public_argv(self) -> list[str]:
        """Return the stable product CLI spelling for this request."""
        argv = ["capture", self.agent]
        if self.project is not None:
            argv.extend(["--project", str(self.project)])
        if not self.open_dashboard:
            argv.append("--no-open")
        if not self.dashboard_enabled:
            argv.append("--no-dashboard")
        if self.dashboard_port is not None:
            argv.extend(["--dashboard-port", str(self.dashboard_port)])
        argv.extend(self.agent_args)
        return argv

    def legacy_argv(self) -> list[str]:
        """Translate at the compatibility boundary used by the capture runtime."""
        argv = ["--tap-client", self.agent]
        if not self.open_dashboard:
            argv.append("--tap-no-open")
        if not self.dashboard_enabled:
            argv.append("--tap-no-live")
        if self.dashboard_port is not None:
            argv.extend(["--tap-live-port", str(self.dashboard_port)])
        argv.extend(self.agent_args)
        return argv
