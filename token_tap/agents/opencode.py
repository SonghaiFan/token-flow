"""OpenCode agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
)


def _opencode_reverse_env(port: int) -> dict[str, str]:
    proxy_url = f"http://127.0.0.1:{port}"
    return {
        "ANTHROPIC_BASE_URL": proxy_url,
        "OPENAI_BASE_URL": f"{proxy_url}/v1",
        "GOOGLE_GEMINI_BASE_URL": proxy_url,
    }


CONFIG = ClientConfig(
    cmd="opencode",
    label="OpenCode",
    install_url="https://opencode.ai/docs/",
    # opencode is multi-provider; ANTHROPIC_BASE_URL is what reverse mode
    # patches when the user explicitly opts out of forward mode. Forward
    # proxy is the default and captures every provider transparently.
    base_url_env="ANTHROPIC_BASE_URL",
    base_url_suffix="",
    default_target="https://api.anthropic.com",
    default_proxy_mode="forward",
)


class OpenCodePlugin(AgentPlugin):
    config = CONFIG
    display_label = "OpenCode"

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        if ctx.capture_only:
            return _opencode_reverse_env(ctx.port)
        return super().reverse_env(ctx)


PLUGIN = OpenCodePlugin("opencode")
