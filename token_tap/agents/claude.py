"""Claude Code agent plugin."""

from __future__ import annotations

import re
from collections.abc import Sequence

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    _is_truthy_env_value,
    _resolve_env_value,
)

_BEDROCK_HOST_RE = re.compile(
    r"(^|\.)("
    r"(bedrock-runtime|bedrock-runtime-fips)"
    r"\.[a-z0-9-]+\.(amazonaws\.com|amazonaws\.com\.cn|vpce\.amazonaws\.com)"
    r"|bedrock-mantle\.[a-z0-9-]+\.(api\.aws|amazonaws\.com|amazonaws\.com\.cn)"
    r")$"
)


def _is_aws_native_bedrock_url(url: str) -> bool:
    """Return True if the URL points to a real AWS Bedrock endpoint (SigV4-signed).

    AWS native Bedrock endpoints match patterns like:
      - bedrock-runtime.us-east-1.amazonaws.com
      - bedrock-runtime-fips.us-west-2.amazonaws.com
      - vpce-xxx.bedrock-runtime.us-east-1.vpce.amazonaws.com
      - bedrock-mantle.us-east-1.api.aws
      - bedrock-mantle.us-east-1.amazonaws.com

    Custom gateways on other AWS services (e.g. API Gateway *.execute-api.*)
    or company proxies do NOT use SigV4, so rewriting their URL is safe.
    """
    try:
        from urllib.parse import urlparse

        host = urlparse(url).hostname or ""
    except Exception:
        return False
    return bool(_BEDROCK_HOST_RE.search(host))


def _is_claude_bedrock_enabled() -> bool:
    return _is_truthy_env_value(_resolve_env_value("CLAUDE_CODE_USE_BEDROCK"))


def _is_claude_vertex_enabled() -> bool:
    return _is_truthy_env_value(_resolve_env_value("CLAUDE_CODE_USE_VERTEX"))


def _should_rewrite_extra_base_url_env(env_key: str) -> bool:
    current_value = _resolve_env_value(env_key)
    if env_key == "ANTHROPIC_BEDROCK_BASE_URL":
        if not _is_claude_bedrock_enabled() or not current_value:
            return False
        return not _is_aws_native_bedrock_url(current_value)
    if env_key == "ANTHROPIC_VERTEX_BASE_URL":
        return _is_claude_vertex_enabled() and bool(current_value)
    return True


def _detect_claude_target() -> str:
    """Auto-detect the upstream target Claude Code would normally use.

    Claude Code can source provider base URLs from settings files rather than
    only the process environment. Mirror that behavior for custom Anthropic,
    Bedrock, and Vertex gateways without forcing users to repeat
    ``--tap-target``.
    """
    if _is_claude_vertex_enabled():
        vertex_target = _resolve_env_value("ANTHROPIC_VERTEX_BASE_URL")
    else:
        vertex_target = ""
    if vertex_target:
        return vertex_target

    if _is_claude_bedrock_enabled():
        bedrock_target = _resolve_env_value("ANTHROPIC_BEDROCK_BASE_URL")
    else:
        bedrock_target = ""
    if bedrock_target and not _is_aws_native_bedrock_url(bedrock_target):
        return bedrock_target

    env_target = _resolve_env_value("ANTHROPIC_BASE_URL")
    if env_target:
        return env_target

    return CONFIG.default_target


CONFIG = ClientConfig(
    cmd="claude",
    label="Claude Code",
    install_url="https://docs.anthropic.com/en/docs/claude-code",
    base_url_env="ANTHROPIC_BASE_URL",
    extra_base_url_envs=("ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"),
    base_url_suffix="",
    default_target="https://api.anthropic.com",
    nesting_env_keys=("CLAUDECODE", "CLAUDE_CODE_SSE_PORT"),
    inject_settings_env=True,
    rewrite_extra_base_url_env=_should_rewrite_extra_base_url_env,
)


class ClaudePlugin(AgentPlugin):
    config = CONFIG
    display_label = "Claude Code"

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_claude_target()


PLUGIN = ClaudePlugin("claude")
