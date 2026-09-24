"""DeepSeek Harness agent plugin."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Sequence

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
)


def _node_supports_env_proxy(env: dict[str, str]) -> bool:
    """Return whether the Node runtime on PATH supports ``--use-env-proxy``."""
    node_cmd = shutil.which("node", path=env.get("PATH"))
    if node_cmd is None:
        return False
    probe_env = env.copy()
    probe_env.pop("NODE_OPTIONS", None)
    try:
        result = subprocess.run(
            [node_cmd, "--use-env-proxy", "--version"],
            env=probe_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _detect_dsh_target() -> str:
    """Auto-detect the DeepSeek endpoint used by dsh reverse mode."""
    env_target = os.environ.get(CONFIG.base_url_env, "").strip()
    if env_target:
        return env_target
    return CONFIG.default_target


CONFIG = ClientConfig(
    cmd="dsh",
    label="DeepSeek Harness",
    install_url="https://github.com/deepseek-ai/deepseek-harness",
    base_url_env="DEEPSEEK_BASE_URL",
    base_url_suffix="",
    default_target="https://api.deepseek.com",
    # A stored dsh model baseURL outranks DEEPSEEK_BASE_URL. Forward mode
    # captures both stored and environment-configured endpoints reliably.
    default_proxy_mode="forward",
    forward_trace_methods=("POST",),
    # dsh may call either an OpenAI-compatible endpoint (/chat/completions)
    # or an Anthropic SDK endpoint (/v1/messages) depending on the stored
    # provider config. Capture both so trace capture is not silently empty.
    forward_trace_path_suffixes=("/chat/completions", "/v1/messages", "/messages"),
)


class DeepSeekHarnessPlugin(AgentPlugin):
    config = CONFIG
    node_env_proxy = True

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_dsh_target()

    def forward_launch_error(self, env: dict[str, str]) -> str | None:
        if _node_supports_env_proxy(env):
            return None
        return (
            "\nError: DeepSeek Harness forward capture requires a Node runtime "
            "with --use-env-proxy support.\n"
            "Upgrade Node until `node --use-env-proxy --version` succeeds, or use "
            "--tap-proxy-mode reverse when dsh is configured through DEEPSEEK_BASE_URL.\n"
        )

    def configure_forward(self, ctx: LaunchContext) -> None:
        # A dsh model can store any baseURL, including a loopback gateway.
        # Route every child request through tap; the proxy's own upstream
        # session still honors the user's original NO_PROXY settings.
        ctx.env["NO_PROXY"] = ""
        ctx.env["no_proxy"] = ""


PLUGIN = DeepSeekHarnessPlugin("dsh")
