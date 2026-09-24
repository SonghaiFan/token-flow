"""Kimi Code CLI (MoonshotAI/kimi-cli) agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
    _multi_provider_reverse_env,
)

CONFIG = ClientConfig(
    cmd="kimi",
    label="Kimi Code CLI",
    install_url="https://github.com/MoonshotAI/kimi-cli",
    base_url_env="KIMI_BASE_URL",
    base_url_suffix="",
    default_target="https://api.kimi.com/coding/v1",
)


class KimiPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Kimi"

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        if ctx.capture_only:
            return _multi_provider_reverse_env(ctx.port)
        return super().reverse_env(ctx)


PLUGIN = KimiPlugin("kimi")
