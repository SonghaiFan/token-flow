"""Antigravity CLI agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
)

CONFIG = ClientConfig(
    cmd="agy",
    label="Antigravity CLI",
    install_url="https://antigravity.google/product/antigravity-cli",
    base_url_env="CLOUD_CODE_URL",
    base_url_suffix="",
    default_target="https://daily-cloudcode-pa.googleapis.com",
    default_proxy_mode="forward",
    auto_trust_ca_macos=True,
    forward_base_url_envs=("CLOUD_CODE_URL",),
    forward_base_url_allowed_path_prefixes=("/v1internal",),
)


class AntigravityPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Antigravity"


PLUGIN = AntigravityPlugin("agy")
