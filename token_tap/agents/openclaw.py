"""OpenClaw agent plugin."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Sequence
from pathlib import Path

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
)

_OPENCLAW_CLEANUP_ENV = "__token_tap_OPENCLAW_CONFIG__"


def _read_openclaw_config(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _openclaw_config_path() -> Path:
    explicit = os.environ.get("OPENCLAW_CONFIG_PATH", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state_dir = os.environ.get("OPENCLAW_STATE_DIR", "").strip()
    if state_dir:
        return Path(state_dir).expanduser() / "openclaw.json"
    return Path.home() / ".openclaw" / "openclaw.json"


def _openclaw_model_arg(cmd_args: Sequence[str]) -> str | None:
    for idx, arg in enumerate(cmd_args):
        if arg in {"--model", "-m"} and idx + 1 < len(cmd_args):
            value = cmd_args[idx + 1].strip()
            if value:
                return value
        if arg.startswith("--model="):
            value = arg.split("=", 1)[1].strip()
            if value:
                return value
    return None


def _openclaw_primary_model(cfg: dict, cmd_args: Sequence[str] = ()) -> str | None:
    if model_arg := _openclaw_model_arg(cmd_args):
        return model_arg
    agents = cfg.get("agents")
    if not isinstance(agents, dict):
        return None
    defaults = agents.get("defaults")
    if not isinstance(defaults, dict):
        return None
    model = defaults.get("model")
    if isinstance(model, str):
        return model
    if isinstance(model, dict):
        primary = model.get("primary")
        if isinstance(primary, str):
            return primary
    models = defaults.get("models")
    if isinstance(models, dict):
        for key in models:
            if isinstance(key, str):
                return key
    return None


def _openclaw_provider_proxy_url(provider: dict, proxy_url: str) -> str:
    api = provider.get("api")
    if not isinstance(api, str):
        return f"{proxy_url}/v1"
    if api.startswith("openai-"):
        return f"{proxy_url}/v1"
    return proxy_url


def _openclaw_provider_target_url(provider: dict, base_url: str) -> str:
    target = base_url.strip().rstrip("/")
    if _openclaw_provider_proxy_url(provider, "http://127.0.0.1:0").endswith("/v1") and target.endswith("/v1"):
        return target[:-3].rstrip("/") or target
    return target


def _openclaw_config_with_proxy(cfg: dict, proxy_url: str, cmd_args: Sequence[str] = ()) -> dict | None:
    model = _openclaw_primary_model(cfg, cmd_args)
    if not model or "/" not in model:
        return None
    provider_id = model.split("/", 1)[0]
    models = cfg.get("models")
    if not isinstance(models, dict):
        return None
    providers = models.get("providers")
    if not isinstance(providers, dict):
        return None
    provider = providers.get(provider_id)
    if not isinstance(provider, dict):
        return None
    patched = json.loads(json.dumps(cfg))
    patched_provider = patched["models"]["providers"][provider_id]
    patched_provider["baseUrl"] = _openclaw_provider_proxy_url(provider, proxy_url)
    patched_provider.pop("base_url", None)
    return patched


def _openclaw_reverse_env(port: int, cmd_args: Sequence[str] = ()) -> dict[str, str]:
    proxy_url = f"http://127.0.0.1:{port}"
    cfg = _read_openclaw_config(_openclaw_config_path())
    if cfg:
        patched = _openclaw_config_with_proxy(cfg, proxy_url, cmd_args)
        if patched:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".openclaw.json", delete=False) as f:
                json.dump(patched, f, indent=2)
                f.write("\n")
                tmp_path = f.name
            return {"OPENCLAW_CONFIG_PATH": tmp_path, _OPENCLAW_CLEANUP_ENV: tmp_path}
    return _openclaw_fallback_reverse_env(proxy_url, cmd_args)


def _openclaw_fallback_reverse_env(proxy_url: str, cmd_args: Sequence[str] = ()) -> dict[str, str]:
    provider = _openclaw_fallback_provider(cmd_args)
    if provider == "anthropic":
        return {"ANTHROPIC_BASE_URL": proxy_url}
    if provider in {"gemini", "google"}:
        return {"GOOGLE_GEMINI_BASE_URL": proxy_url}
    if provider == "openrouter":
        return {"OPENROUTER_BASE_URL": proxy_url}
    return {"OPENAI_BASE_URL": f"{proxy_url}/v1"}


def _openclaw_fallback_provider(cmd_args: Sequence[str] = ()) -> str:
    model = _openclaw_primary_model({}, cmd_args)
    if model and "/" in model:
        return model.split("/", 1)[0]
    for env_key, provider in (
        ("OPENAI_API_KEY", "openai"),
        ("ANTHROPIC_API_KEY", "anthropic"),
        ("GEMINI_API_KEY", "gemini"),
        ("GOOGLE_API_KEY", "gemini"),
        ("OPENROUTER_API_KEY", "openrouter"),
    ):
        if os.environ.get(env_key):
            return provider
    return "openai"


def _detect_openclaw_target(cmd_args: Sequence[str] = ()) -> str:
    cfg = _read_openclaw_config(_openclaw_config_path())
    if cfg:
        model = _openclaw_primary_model(cfg, cmd_args)
        if model and "/" in model:
            provider_id = model.split("/", 1)[0]
            models = cfg.get("models")
            providers = models.get("providers") if isinstance(models, dict) else None
            provider = providers.get(provider_id) if isinstance(providers, dict) else None
            if isinstance(provider, dict):
                base = provider.get("baseUrl") or provider.get("base_url")
                if isinstance(base, str) and base.strip():
                    return _openclaw_provider_target_url(provider, base)
    for env_key, target in (
        ("OPENAI_API_KEY", "https://api.openai.com"),
        ("ANTHROPIC_API_KEY", "https://api.anthropic.com"),
        ("GEMINI_API_KEY", "https://generativelanguage.googleapis.com"),
        ("GOOGLE_API_KEY", "https://generativelanguage.googleapis.com"),
        ("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"),
    ):
        if os.environ.get(env_key):
            return target
    return CONFIG.default_target


CONFIG = ClientConfig(
    cmd="openclaw",
    label="OpenClaw",
    install_url="https://github.com/openclaw/openclaw",
    base_url_env="OPENAI_BASE_URL",
    extra_base_url_envs=("ANTHROPIC_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "OPENROUTER_BASE_URL", "CUSTOM_BASE_URL"),
    base_url_suffix="/v1",
    default_target="https://api.openai.com",
)


class OpenClawPlugin(AgentPlugin):
    config = CONFIG

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_openclaw_target(args)

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        reverse_env = _openclaw_reverse_env(ctx.port, ctx.args)
        cleanup_path = reverse_env.pop(_OPENCLAW_CLEANUP_ENV, None)
        if cleanup_path:
            ctx.cleanup_paths.append(Path(cleanup_path))
        return reverse_env


PLUGIN = OpenClawPlugin("openclaw")
