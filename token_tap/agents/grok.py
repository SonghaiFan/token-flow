"""Grok Build CLI agent plugin."""

from __future__ import annotations

import os
from collections.abc import Sequence

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
)


def _detect_grok_target() -> str:
    """Auto-detect the Grok Build CLI chat proxy endpoint."""
    env_target = os.environ.get(CONFIG.base_url_env, "").strip()
    if env_target:
        return env_target
    return CONFIG.default_target


CONFIG = ClientConfig(
    cmd="grok",
    label="Grok Build CLI",
    install_url="https://docs.x.ai/build/overview",
    base_url_env="GROK_CLI_CHAT_PROXY_BASE_URL",
    base_url_suffix="/v1",
    default_target="https://cli-chat-proxy.grok.com/v1",
    # Grok sends /v1/* to its configured base URL. The official upstream
    # target already includes /v1, so remove the local prefix when relaying.
    strip_path_prefix="/v1",
    reverse_allowed_path_prefixes=(
        "/v1/user",
        "/v1/settings",
        "/v1/bundle",
        "/v1/subagents",
        "/v1/feedback",
        "/v1/storage",
        "/v1/traces",
        "/v1/deployment",
        "/v1/mcp",
        "/v1/sessions",
        "/v1/billing",
    ),
    reverse_trace_path_prefixes=(
        "/v1/responses",
        "/v1/chat/completions",
        "/v1/storage",
        "/v1/traces",
    ),
)


class GrokPlugin(AgentPlugin):
    config = CONFIG

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_grok_target()


PLUGIN = GrokPlugin("grok")
