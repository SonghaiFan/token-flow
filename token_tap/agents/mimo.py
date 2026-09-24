"""MiMo Code, an OpenCode fork agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
    _extend_no_proxy,
)
from token_tap.agents.opencode import _opencode_reverse_env

CONFIG = ClientConfig(
    cmd="mimo",
    label="MiMo Code",
    install_url="https://mimo.xiaomi.com/en/mimocode",
    # MiMo Code is an OpenCode fork (https://github.com/XiaomiMiMo/MiMo-Code).
    # It inherits the same multi-provider env vars; forward proxy is the
    # natural default to capture all provider traffic transparently.
    base_url_env="ANTHROPIC_BASE_URL",
    base_url_suffix="",
    default_target="https://api.anthropic.com",
    default_proxy_mode="forward",
)


class MiMoPlugin(AgentPlugin):
    config = CONFIG
    display_label = "MiMo Code"

    def configure_forward(self, ctx: LaunchContext) -> None:
        # MiMo defaults to mimo-only mode and ignores provider env vars unless disabled.
        ctx.env["MIMOCODE_MIMO_ONLY"] = "false"

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        reverse_env = _opencode_reverse_env(ctx.port) if ctx.capture_only else super().reverse_env(ctx)
        reverse_env["MIMOCODE_MIMO_ONLY"] = "false"
        return reverse_env

    def configure_reverse(self, ctx: LaunchContext) -> None:
        # MiMo talks to a local HTTP server in TUI mode; preserve any existing
        # NO_PROXY entries and bypass localhost the same way forward mode does.
        _extend_no_proxy(ctx.env, ("localhost", "127.0.0.1", "::1"))


PLUGIN = MiMoPlugin("mimo")
