"""CodeBuddy agent plugin."""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from pathlib import Path

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    _read_settings_env_base_url,
)


def _detect_codebuddy_target() -> str:
    """Auto-detect the upstream target CodeBuddy would normally use.

    Priority:
    1. ``CODEBUDDY_BASE_URL`` env var.
    2. ``settings.json`` env block, searched in this order:
       project-local ``.codebuddy/settings{.local,}.json`` →
       ``${CODEBUDDY_CONFIG_DIR}/settings.json`` (when set) →
       ``~/.codebuddy/settings.json``.
    3. CodeBuddy's endpoint cache written on login (all four login modes).
    4. ``ClientConfig.default_target`` fallback.
    """
    env_target = os.environ.get("CODEBUDDY_BASE_URL", "").strip()
    if env_target:
        return env_target

    env_key = CONFIG.base_url_env
    config_dir = os.environ.get("CODEBUDDY_CONFIG_DIR", "").strip()
    candidate_paths: list[Path] = [
        Path.cwd() / ".codebuddy" / "settings.local.json",
        Path.cwd() / ".codebuddy" / "settings.json",
    ]
    if config_dir:
        candidate_paths.append(Path(config_dir) / "settings.json")
    candidate_paths.append(Path.home() / ".codebuddy" / "settings.json")
    for path in candidate_paths:
        target = _read_settings_env_base_url(path, env_key)
        if target:
            return target

    cached = _read_codebuddy_endpoint_cache()
    if cached:
        return cached.rstrip("/") + "/v2"

    return CONFIG.default_target


def _read_codebuddy_endpoint_cache() -> str | None:
    """Return the host URL from CodeBuddy's login-time endpoint cache, or None."""
    config_dir = os.environ.get("CODEBUDDY_CONFIG_DIR", "").strip()
    base = Path(config_dir) if config_dir else Path.home() / ".codebuddy"
    # md5("CodeBuddy-Endpoint-Cache") — CodeBuddy's endpointCacheKey constant.
    cache_file = base / "local_storage" / "entry_933d5543e80177622c17a73869c0fad7.info"
    try:
        value = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


CONFIG = ClientConfig(
    cmd="codebuddy",
    label="CodeBuddy",
    install_url="https://www.codebuddy.ai/docs/cli",
    base_url_env="CODEBUDDY_BASE_URL",
    base_url_suffix="",
    # CodeBuddy's bundled OpenAI client appends ``/v2`` to its product
    # endpoint, so the reverse-proxy upstream must include that prefix
    # to hit ``/v2/chat/completions`` rather than the nginx default page.
    # Users on non-Tencent deployments can override via ``--tap-target``
    # or ``CODEBUDDY_BASE_URL``.
    default_target="https://copilot.tencent.com/v2",
    inject_settings_env=True,
)


class CodeBuddyPlugin(AgentPlugin):
    config = CONFIG

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_codebuddy_target()


PLUGIN = CodeBuddyPlugin("codebuddy")
