"""Pi coding agent agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
)

CONFIG = ClientConfig(
    cmd="pi",
    label="Pi",
    install_url="https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
    # Pi is multi-provider and stores provider base URLs in its model
    # registry/models.json rather than a single global env var. Reverse
    # mode remains structurally available for custom OpenAI-compatible
    # setups, but forward mode is the reliable default.
    base_url_env="OPENAI_BASE_URL",
    base_url_suffix="/v1",
    default_target="https://api.openai.com",
    default_proxy_mode="forward",
)


class PiPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Pi"
    node_env_proxy = True


PLUGIN = PiPlugin("pi")
