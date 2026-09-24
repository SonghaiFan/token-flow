"""Gemini CLI agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
)

CONFIG = ClientConfig(
    cmd="gemini",
    label="Gemini CLI",
    install_url="https://github.com/google-gemini/gemini-cli",
    base_url_env="GOOGLE_GEMINI_BASE_URL",
    extra_base_url_envs=("GOOGLE_VERTEX_BASE_URL",),
    base_url_suffix="",
    default_target="https://generativelanguage.googleapis.com",
    # Google OAuth / Code Assist traffic spans several Google endpoints.
    # Forward mode captures that flow without assuming a single base URL.
    default_proxy_mode="forward",
)


class GeminiPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Gemini"


PLUGIN = GeminiPlugin("gemini")
