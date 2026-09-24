"""Qoder CLI agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
)

CONFIG = ClientConfig(
    cmd="qodercli",
    label="Qoder CLI",
    install_url="https://qoder.com/cli",
    # Qoder CLI talks to multiple Qoder endpoints and does not expose a
    # reliable single-provider base URL override. Keep reverse-mode fields
    # structurally valid, but default to forward proxy mode.
    base_url_env="QODER_BASE_URL",
    base_url_suffix="",
    default_target="https://api2.qoder.sh",
    default_proxy_mode="forward",
)


class QoderPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Qoder"


PLUGIN = QoderPlugin("qoder")
