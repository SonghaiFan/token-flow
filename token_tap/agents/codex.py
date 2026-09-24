"""Codex CLI agent plugin."""

from __future__ import annotations

import json
import os
import tomllib
from collections.abc import Sequence
from pathlib import Path

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
)


def _codex_config_override_values(args: list[str]) -> list[str]:
    values: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-c", "--config"):
            if i + 1 < len(args):
                values.append(args[i + 1])
            i += 2
            continue
        if arg.startswith("--config="):
            values.append(arg.split("=", 1)[1])
        i += 1
    return values


def _codex_config_override_value(args: list[str] | None, key: str) -> object | None:
    if not args:
        return None
    prefix = f"{key}="
    value: object | None = None
    for override in _codex_config_override_values(args):
        if not override.startswith(prefix):
            continue
        raw = override[len(prefix) :].strip()
        try:
            parsed = tomllib.loads(f"value = {raw}\n")
        except tomllib.TOMLDecodeError:
            value = raw
        else:
            value = parsed.get("value")
    return value


def _codex_profile_arg(args: list[str] | None) -> str | None:
    if not args:
        return None
    profile: str | None = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("-p", "--profile"):
            if i + 1 < len(args):
                profile = args[i + 1]
            i += 2
            continue
        if arg.startswith("--profile="):
            profile = arg.split("=", 1)[1]
        i += 1
    return profile.strip() if profile and profile.strip() else None


def _toml_dotted_key_segment(value: str) -> str:
    """Return a TOML dotted-key segment for a Codex config key."""
    if value and value.isascii() and all(char.isalnum() or char in {"_", "-"} for char in value):
        return value
    return json.dumps(value)


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def _read_codex_config_file(config_path: Path) -> dict[str, object]:
    try:
        data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _read_codex_config() -> dict[str, object]:
    return _read_codex_config_file(_codex_home() / "config.toml")


def _read_codex_profile_config(profile: str | None) -> dict[str, object]:
    if not profile:
        return {}
    return _read_codex_config_file(_codex_home() / f"{profile}.config.toml")


def _selected_codex_provider_base_url(args: list[str] | None = None) -> tuple[str, str] | None:
    """Return the selected custom Codex provider and base URL, if configured."""
    data = _read_codex_config()
    provider = _codex_config_override_value(args, "model_provider")
    profile = _codex_profile_arg(args)
    if profile is None:
        configured_profile = _codex_config_override_value(args, "profile")
        if configured_profile is None:
            configured_profile = data.get("profile")
        if isinstance(configured_profile, str) and configured_profile.strip():
            profile = configured_profile.strip()

    profile_data = _read_codex_profile_config(profile)
    if not isinstance(provider, str):
        provider = profile_data.get("model_provider")

    profiles = data.get("profiles")
    if profile and isinstance(profiles, dict):
        profile_config = profiles.get(profile)
        if isinstance(profile_config, dict) and not isinstance(provider, str):
            provider = profile_config.get("model_provider")

    if not isinstance(provider, str):
        provider = data.get("model_provider")
    if not isinstance(provider, str) or not provider.strip():
        return None
    provider = provider.strip()

    provider_base_url_key = f"model_providers.{_toml_dotted_key_segment(provider)}.base_url"
    base_url_override = _codex_config_override_value(args, provider_base_url_key)
    if isinstance(base_url_override, str) and base_url_override.strip():
        return provider, base_url_override.strip()

    base_url: object | None = None
    for config in (profile_data, data):
        providers = config.get("model_providers")
        if not isinstance(providers, dict):
            continue
        provider_config = providers.get(provider)
        if not isinstance(provider_config, dict):
            continue
        base_url = provider_config.get("base_url")
        if isinstance(base_url, str) and base_url.strip():
            break
    if not isinstance(base_url, str) or not base_url.strip():
        return None
    return provider.strip(), base_url.strip()


def _codex_selected_provider_base_url_key(args: list[str] | None = None) -> str | None:
    selected = _selected_codex_provider_base_url(args)
    if selected is None:
        return None
    provider, _base_url = selected
    return f"model_providers.{_toml_dotted_key_segment(provider)}.base_url"


def _codex_reverse_args(proxy_base_url: str, args: list[str]) -> list[str]:
    """Route Codex through the proxy over HTTP/SSE without changing user config."""
    provider_base_url_key = _codex_selected_provider_base_url_key(args)
    if provider_base_url_key:
        provider_key = provider_base_url_key.removesuffix(".base_url")
        overrides = [
            f'{provider_base_url_key}="{proxy_base_url}"',
            f"{provider_key}.supports_websockets=false",
        ]
        args = _without_config_overrides(args, {provider_base_url_key, f"{provider_key}.supports_websockets"})
    else:
        provider_key = "model_providers.token-flow-openai"
        overrides = [
            'model_provider="token-flow-openai"',
            f'{provider_key}.name="Token Flow"',
            f'{provider_key}.base_url="{proxy_base_url}"',
            f'{provider_key}.wire_api="responses"',
            f"{provider_key}.requires_openai_auth=true",
            f"{provider_key}.supports_websockets=false",
        ]
        args = _without_config_overrides(args, {"model_provider"})

    injected = [item for override in overrides for item in ("-c", override)]
    return injected + args


def _without_config_overrides(args: list[str], keys: set[str]) -> list[str]:
    """Remove Codex config overrides that would bypass enforced proxy settings."""
    filtered: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"-c", "--config"} and i + 1 < len(args):
            value = args[i + 1]
            if any(value.startswith(f"{key}=") for key in keys):
                i += 2
                continue
            filtered.extend((arg, value))
            i += 2
            continue
        if arg.startswith("--config="):
            value = arg.split("=", 1)[1]
            if any(value.startswith(f"{key}=") for key in keys):
                i += 1
                continue
        filtered.append(arg)
        i += 1
    return filtered


_CODEX_CHATGPT_TARGET = "https://chatgpt.com/backend-api/codex"


def _detect_codex_target(args: list[str] | None = None) -> str:
    """Auto-detect the correct upstream target for Codex CLI.

    Explicit provider and CLI target configuration takes precedence over the
    auth-mode defaults, matching Codex's own layered config resolution.
    """
    custom_provider = _selected_codex_provider_base_url(args)
    if custom_provider is not None:
        _provider, base_url = custom_provider
        return base_url

    openai_base_url_override = _codex_config_override_value(args, "openai_base_url")
    if isinstance(openai_base_url_override, str) and openai_base_url_override.strip():
        return openai_base_url_override.strip()

    codex_home = _codex_home()
    auth_file = codex_home / "auth.json"
    try:
        data = json.loads(auth_file.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("auth_mode") == "chatgpt":
            return _CODEX_CHATGPT_TARGET
    except (OSError, json.JSONDecodeError, ValueError):
        pass

    env_target = os.environ.get(CONFIG.base_url_env, "").strip()
    if env_target:
        return env_target

    data = _read_codex_config()
    openai_base_url = data.get("openai_base_url")
    if isinstance(openai_base_url, str) and openai_base_url.strip():
        return openai_base_url.strip()
    return CONFIG.default_target


CONFIG = ClientConfig(
    cmd="codex",
    label="Codex CLI",
    install_url="https://github.com/openai/codex",
    base_url_env="OPENAI_BASE_URL",
    base_url_suffix="/v1",
    default_target="https://api.openai.com",
    strip_path_prefix="/v1",
    strip_path_prefix_unless_target_contains=("api.openai.com",),
)


class CodexPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Codex"

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_codex_target(list(args))

    def configure_reverse(self, ctx: LaunchContext) -> None:
        super().configure_reverse(ctx)
        ctx.args = _codex_reverse_args(self.config.reverse_base_url(ctx.port), ctx.args)


PLUGIN = CodexPlugin("codex")
