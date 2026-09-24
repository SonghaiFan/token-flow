"""Agent plugin registry: the single list of clients Token Flow can capture.

Add a client by writing ``token_tap/agents/<id>.py`` with a ``PLUGIN`` built on
``AgentPlugin`` and listing it here. The UI counterpart lives in ``ui/lib/agents``.
"""

from __future__ import annotations

from token_tap.agents import (
    agy,
    claude,
    codebuddy,
    codex,
    codexapp,
    dsh,
    gemini,
    grok,
    hermes,
    kimi,
    kimi_code,
    mimo,
    openclaw,
    opencode,
    pi,
    qoder,
)
from token_tap.agents.base import AgentPlugin, ClientConfig

AGENTS: dict[str, AgentPlugin] = {
    module.PLUGIN.id: module.PLUGIN
    for module in (
        claude,
        codex,
        grok,
        dsh,
        codexapp,
        kimi,
        kimi_code,
        gemini,
        opencode,
        mimo,
        pi,
        hermes,
        qoder,
        agy,
        openclaw,
        codebuddy,
    )
}

# Labels for clients that are no longer captured but still appear in stored traces.
LEGACY_LABELS = {"antigravity": "Antigravity", "cursor": "Cursor"}


def get_agent(agent_id: str) -> AgentPlugin:
    return AGENTS[agent_id]


def client_configs() -> dict[str, ClientConfig]:
    return {agent_id: plugin.config for agent_id, plugin in AGENTS.items()}


def dashboard_labels() -> dict[str, str]:
    """Conversation labels by client id, including legacy clients."""
    labels = {agent_id: plugin.display_label for agent_id, plugin in AGENTS.items() if plugin.display_label}
    return {**labels, **LEGACY_LABELS}
