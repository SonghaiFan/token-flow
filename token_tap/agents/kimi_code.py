"""Kimi Code CLI (MoonshotAI/kimi-code), captured through a sandboxed KIMI_CODE_HOME agent plugin."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import tomllib
from collections.abc import Iterable, Sequence
from pathlib import Path

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
)

_KIMI_CODE_MANAGED_PROVIDER = "managed:kimi-code"


_KIMI_CODE_SKIP_MIGRATION_MARKER = ".skip-migration-from-kimi-cli"


_KIMI_CODE_MIGRATED_MARKER = ".migrated-to-kimi-code"


_KIMI_CODE_SANDBOX_DIR_PREFIX = "token_tap_kimi_code_"


def _kimi_code_home() -> Path:
    return _kimi_code_source_home()


def _kimi_code_source_home() -> Path:
    """Persistent kimi-code data dir used when building a tap sandbox."""
    override = os.environ.get("KIMI_CODE_HOME", "").strip()
    if override and _KIMI_CODE_SANDBOX_DIR_PREFIX not in override:
        return Path(override).expanduser()
    return Path.home() / ".kimi-code"


def _kimi_code_migration_already_handled(real_home: Path) -> bool:
    """Mirror kimi-code detectPendingMigration suppression for the real home."""
    if (real_home / _KIMI_CODE_SKIP_MIGRATION_MARKER).is_file():
        return True
    marker = Path.home() / ".kimi" / _KIMI_CODE_MIGRATED_MARKER
    if not marker.is_file():
        return False
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        # Unreadable marker: kimi-code treats this as "already handled".
        return True
    target_path = data.get("target_path")
    if not isinstance(target_path, str):
        return True
    return Path(target_path).expanduser().resolve() == real_home.resolve()


def _sync_kimi_code_migration_suppression(source_home: Path, sandbox: Path) -> None:
    """Copy or synthesize the skip marker so sandbox startups skip the migrate TUI."""
    skip_source = source_home / _KIMI_CODE_SKIP_MIGRATION_MARKER
    skip_target = sandbox / _KIMI_CODE_SKIP_MIGRATION_MARKER
    if skip_source.is_file():
        shutil.copy2(skip_source, skip_target)
        return
    if _kimi_code_migration_already_handled(source_home):
        skip_target.write_text("", encoding="utf-8")


def _read_kimi_code_config(home: Path | None = None, path: Path | None = None) -> dict[str, object]:
    config_path = path or (home or _kimi_code_home()) / "config.toml"
    try:
        text = config_path.read_text(encoding="utf-8")
        data = json.loads(text) if config_path.suffix.lower() == ".json" else tomllib.loads(text)
    except (OSError, json.JSONDecodeError, tomllib.TOMLDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _kimi_code_option_value(args: Sequence[str], flags: set[str]) -> str | None:
    for idx, arg in enumerate(args):
        if arg in flags and idx + 1 < len(args):
            value = args[idx + 1].strip()
            if value:
                return value
        for flag in flags:
            prefix = f"{flag}="
            if arg.startswith(prefix):
                value = arg[len(prefix) :].strip()
                if value:
                    return value
    return None


def _replace_kimi_code_option_value(args: Sequence[str], flags: set[str], value: str) -> list[str]:
    rewritten: list[str] = []
    skip_next = False
    for arg in args:
        if skip_next:
            rewritten.append(value)
            skip_next = False
            continue
        if arg in flags:
            rewritten.append(arg)
            skip_next = True
            continue
        matched = False
        for flag in flags:
            if arg.startswith(f"{flag}="):
                rewritten.append(f"{flag}={value}")
                matched = True
                break
        if not matched:
            rewritten.append(arg)
    return rewritten


def _kimi_code_model_arg(cmd_args: Sequence[str] = ()) -> str | None:
    return _kimi_code_option_value(cmd_args, {"--model", "-m"})


def _kimi_code_config_file_arg(cmd_args: Sequence[str] = ()) -> str | None:
    return _kimi_code_option_value(cmd_args, {"--config-file"})


def _kimi_code_inline_config_arg(cmd_args: Sequence[str] = ()) -> str | None:
    return _kimi_code_option_value(cmd_args, {"--config"})


def _loads_kimi_code_inline_config(value: str) -> dict[str, object]:
    value = value.strip()
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        try:
            parsed = tomllib.loads(value)
        except (tomllib.TOMLDecodeError, ValueError):
            return {}
    return parsed if isinstance(parsed, dict) else {}


def _kimi_code_config_for_args(cmd_args: Sequence[str] = ()) -> dict[str, object]:
    inline_config = _kimi_code_inline_config_arg(cmd_args)
    if inline_config:
        return _loads_kimi_code_inline_config(inline_config)

    config_file = _kimi_code_config_file_arg(cmd_args)
    if config_file:
        return _read_kimi_code_config(path=Path(config_file).expanduser())

    return _read_kimi_code_config()


def _has_active_kimi_code_model_env() -> bool:
    return bool(os.environ.get("KIMI_MODEL_NAME", "").strip())


def _should_proxy_kimi_code_model_env() -> bool:
    if not _has_active_kimi_code_model_env():
        return False
    if os.environ.get("KIMI_MODEL_BASE_URL", "").strip():
        return True
    provider_type = os.environ.get("KIMI_MODEL_PROVIDER_TYPE", "").strip().lower()
    return provider_type in {"", "kimi"}


def _kimi_code_provider_base_url(provider: dict[str, object]) -> str | None:
    base_url = provider.get("base_url")
    if isinstance(base_url, str) and base_url.strip():
        return base_url.strip()
    env_table = provider.get("env")
    if isinstance(env_table, dict):
        fallback = env_table.get("KIMI_BASE_URL")
        if isinstance(fallback, str) and fallback.strip():
            return fallback.strip()
    return None


def _kimi_code_selected_provider_names(config: dict[str, object], cmd_args: Sequence[str] = ()) -> set[str]:
    providers = config.get("providers")
    if not isinstance(providers, dict):
        return set()

    selected_model = _kimi_code_model_arg(cmd_args)
    if not selected_model:
        default_model = config.get("default_model")
        if isinstance(default_model, str) and default_model.strip():
            selected_model = default_model.strip()

    models = config.get("models")
    if selected_model and isinstance(models, dict):
        model = models.get(selected_model)
        if isinstance(model, dict):
            provider_name = model.get("provider")
            if isinstance(provider_name, str) and provider_name in providers:
                return {provider_name}

    kimi_providers = [
        name
        for name, provider in providers.items()
        if isinstance(name, str) and isinstance(provider, dict) and provider.get("type") == "kimi"
    ]
    if len(kimi_providers) == 1:
        return {kimi_providers[0]}
    if _KIMI_CODE_MANAGED_PROVIDER in kimi_providers:
        return {_KIMI_CODE_MANAGED_PROVIDER}
    return set()


def _collect_kimi_code_provider_urls(config: dict[str, object], provider_names: set[str] | None = None) -> list[str]:
    urls: list[str] = []
    providers = config.get("providers")
    if not isinstance(providers, dict):
        return urls
    for name, provider in providers.items():
        if provider_names is not None and name not in provider_names:
            continue
        if not isinstance(provider, dict) or provider.get("type") != "kimi":
            continue
        base_url = _kimi_code_provider_base_url(provider)
        if base_url:
            urls.append(base_url)
    return urls


def _patch_kimi_code_config_dict(
    config: dict[str, object], proxy_base: str, cmd_args: Sequence[str] = ()
) -> tuple[dict[str, object], list[str]]:
    patched = json.loads(json.dumps(config))
    patched_providers: list[str] = []
    provider_names = _kimi_code_selected_provider_names(config, cmd_args)

    providers = patched.get("providers")
    if isinstance(providers, dict):
        for name, provider in providers.items():
            if not isinstance(provider, dict) or provider.get("type") != "kimi":
                continue
            if provider_names and name not in provider_names:
                continue
            provider["base_url"] = proxy_base
            env_table = provider.get("env")
            if isinstance(env_table, dict) and "KIMI_BASE_URL" in env_table:
                env_table["KIMI_BASE_URL"] = proxy_base
            patched_providers.append(str(name))

    return patched, patched_providers


def _kimi_code_config_url_replacements(
    config: dict[str, object], proxy_base: str, provider_names: set[str]
) -> list[tuple[str, str]]:
    replacements: list[tuple[str, str]] = []
    for old_url in _collect_kimi_code_provider_urls(config, provider_names):
        replacements.append((old_url, proxy_base))
    seen: set[str] = set()
    ordered: list[tuple[str, str]] = []
    for old_url, new_url in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        if old_url in seen:
            continue
        seen.add(old_url)
        ordered.append((old_url, new_url))
    return ordered


def _replace_kimi_code_toml_url_assignments(text: str, old_url: str, new_url: str) -> str:
    escaped = re.escape(old_url)
    pattern = rf'(?m)^((?:base_url|KIMI_BASE_URL)\s*=\s*["\']){escaped}(["\'].*)$'
    return re.sub(pattern, rf"\1{new_url}\2", text)


def _insert_kimi_code_provider_base_url(text: str, provider_name: str, proxy_base: str) -> str:
    quoted = f'"{re.escape(provider_name)}"'
    bare = re.escape(provider_name)
    pattern = rf"(?m)^(\[providers\.(?:{quoted}|{bare})\]\s*(?:#.*)?\r?\n)"
    replacement = rf'\1base_url = "{proxy_base}"' + "\n"
    return re.sub(pattern, replacement, text, count=1)


def _patch_kimi_code_config_text(
    source_text: str, proxy_base: str, cmd_args: Sequence[str] = ()
) -> tuple[str, list[str]]:
    if not source_text.strip():
        return _minimal_kimi_code_config_toml(proxy_base), [_KIMI_CODE_MANAGED_PROVIDER]
    try:
        config = tomllib.loads(source_text)
    except (tomllib.TOMLDecodeError, ValueError):
        config = {}
    if not isinstance(config, dict):
        config = {}
    _, patched_providers = _patch_kimi_code_config_dict(config, proxy_base, cmd_args)
    provider_names = set(patched_providers)
    result = source_text
    for old_url, new_url in _kimi_code_config_url_replacements(config, proxy_base, provider_names):
        result = _replace_kimi_code_toml_url_assignments(result, old_url, new_url)
    providers = config.get("providers")
    if isinstance(providers, dict):
        for name in provider_names:
            provider = providers.get(name)
            if isinstance(provider, dict) and not _kimi_code_provider_base_url(provider):
                result = _insert_kimi_code_provider_base_url(result, str(name), proxy_base)
    return result, patched_providers


def _patch_kimi_code_inline_config(value: str, proxy_base: str, cmd_args: Sequence[str] = ()) -> str:
    config = _loads_kimi_code_inline_config(value)
    if not config:
        return value
    if value.strip().startswith(("{", "[")):
        patched, _ = _patch_kimi_code_config_dict(config, proxy_base, cmd_args)
        return json.dumps(patched, separators=(",", ":"))
    patched_text, _ = _patch_kimi_code_config_text(value, proxy_base, cmd_args)
    return patched_text


def _minimal_kimi_code_config_toml(proxy_base: str) -> str:
    return (
        'default_model = "kimi-code/kimi-for-coding"\n'
        "\n"
        f'[providers."{_KIMI_CODE_MANAGED_PROVIDER}"]\n'
        'type = "kimi"\n'
        f'base_url = "{proxy_base}"\n'
        'api_key = ""\n'
        "\n"
        '[models."kimi-code/kimi-for-coding"]\n'
        f'provider = "{_KIMI_CODE_MANAGED_PROVIDER}"\n'
        'model = "kimi-for-coding"\n'
        "max_context_size = 262144\n"
    )


def _kimi_code_config_has_launch_state(source_text: str) -> bool:
    if not source_text.strip():
        return False
    try:
        config = tomllib.loads(source_text)
    except (tomllib.TOMLDecodeError, ValueError):
        return True
    if not isinstance(config, dict):
        return False
    return any(key in config for key in ("default_model", "models", "providers"))


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _write_kimi_code_config_metadata(
    sandbox: Path,
    *,
    source_config: Path | None,
    sandbox_config: Path,
    patched_text: str,
    proxy_base: str,
    upstream_base: str,
) -> None:
    if source_config is None:
        return
    metadata = {
        "source_config": str(source_config.expanduser().resolve()),
        "sandbox_config": str(sandbox_config),
        "patched_sha256": _sha256_text(patched_text),
        "proxy_base": proxy_base,
        "upstream_base": upstream_base,
    }
    (sandbox / _KIMI_CODE_CONFIG_METADATA).write_text(json.dumps(metadata), encoding="utf-8")


def _persist_kimi_code_config_edits(sandbox: Path) -> None:
    metadata_path = sandbox / _KIMI_CODE_CONFIG_METADATA
    if not metadata_path.is_file():
        return
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    if not isinstance(metadata, dict):
        return
    source_config_raw = metadata.get("source_config")
    sandbox_config_raw = metadata.get("sandbox_config")
    patched_sha256 = metadata.get("patched_sha256")
    proxy_base = metadata.get("proxy_base")
    upstream_base = metadata.get("upstream_base")
    if not all(isinstance(value, str) and value for value in (source_config_raw, sandbox_config_raw, patched_sha256)):
        return
    sandbox_config = Path(sandbox_config_raw)
    if not sandbox_config.is_file():
        return
    try:
        final_text = sandbox_config.read_text(encoding="utf-8")
    except OSError:
        return
    if _sha256_text(final_text) == patched_sha256:
        return
    if isinstance(proxy_base, str) and isinstance(upstream_base, str) and proxy_base and upstream_base:
        final_text = final_text.replace(proxy_base, upstream_base)
    source_config = Path(source_config_raw)
    source_config.parent.mkdir(parents=True, exist_ok=True)
    source_config.write_text(final_text, encoding="utf-8")


_KIMI_CODE_SANDBOX_LINKS: tuple[tuple[str, bool], ...] = (
    ("oauth", True),
    ("credentials", True),
    ("plugins", True),
    ("skills", True),
    ("sessions", True),
    ("AGENTS.md", False),
    ("mcp.json", False),
    ("tui.toml", False),
)


_KIMI_CODE_CONFIG_METADATA = ".token-flow-config-metadata.json"


def _link_kimi_code_sandbox_path(source_home: Path, sandbox: Path, rel: str, *, is_dir: bool) -> None:
    source = source_home / rel
    target = sandbox / rel
    if rel in ("oauth", "credentials") and not source.exists():
        source.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        if is_dir:
            target.symlink_to(source, target_is_directory=True)
        else:
            target.symlink_to(source)
    except OSError:
        if is_dir:
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)


def _persist_kimi_code_sandbox(source_home: Path, sandbox: Path) -> None:
    """Copy sandbox-only auth/session files back when symlinks were unavailable."""
    _persist_kimi_code_config_edits(sandbox)
    for name, is_dir in _KIMI_CODE_SANDBOX_LINKS:
        path = sandbox / name
        if not path.exists() or path.is_symlink():
            continue
        dest = source_home / name
        if is_dir:
            if dest.exists():
                if dest.is_dir() and not dest.is_symlink():
                    shutil.rmtree(dest)
                else:
                    dest.unlink()
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(path, dest)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)


_KIMI_CODE_SESSION_TEXT_SUFFIXES = frozenset({".json", ".jsonl", ".md", ".log", ".txt"})


def _normalize_kimi_code_fs_path(path: str) -> str:
    """Keep macOS temp paths on /var so they match KIMI_CODE_HOME join() results."""
    resolved = str(Path(path).expanduser().resolve())
    if resolved.startswith("/private/var/"):
        return "/var" + resolved[len("/private/var") :]
    return resolved


def _translate_kimi_code_home_path(path: str, old_prefix: str, new_prefix: str) -> str:
    if not path:
        return path
    resolved = _normalize_kimi_code_fs_path(path)
    old = _normalize_kimi_code_fs_path(old_prefix).rstrip("/")
    new = _normalize_kimi_code_fs_path(new_prefix).rstrip("/")
    if resolved == old:
        return new
    if resolved.startswith(old + "/"):
        return new + resolved[len(old) :]
    return path


def _iter_kimi_code_session_index_entries(path: Path) -> Iterable[dict[str, object]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(entry, dict):
            yield entry


def _materialize_kimi_code_session_index(source_home: Path, sandbox: Path) -> None:
    """Copy session_index into the sandbox with sessionDir paths under KIMI_CODE_HOME."""
    source_index = source_home / "session_index.jsonl"
    target_index = sandbox / "session_index.jsonl"
    source_prefix = _normalize_kimi_code_fs_path(str(source_home))
    sandbox_prefix = _normalize_kimi_code_fs_path(str(sandbox))
    lines_out: list[str] = []
    if source_index.is_file():
        for entry in _iter_kimi_code_session_index_entries(source_index):
            session_dir = entry.get("sessionDir")
            if isinstance(session_dir, str):
                entry["sessionDir"] = _translate_kimi_code_home_path(session_dir, source_prefix, sandbox_prefix)
            lines_out.append(json.dumps(entry, ensure_ascii=False))
    target_index.parent.mkdir(parents=True, exist_ok=True)
    if lines_out:
        target_index.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    else:
        target_index.write_text("", encoding="utf-8")


def _merge_kimi_code_session_index(source_home: Path, sandbox: Path) -> None:
    """Merge sandbox session_index updates back into the real home."""
    sandbox_index = sandbox / "session_index.jsonl"
    if not sandbox_index.is_file():
        return
    source_index = source_home / "session_index.jsonl"
    source_prefix = _normalize_kimi_code_fs_path(str(source_home))
    sandbox_prefix = _normalize_kimi_code_fs_path(str(sandbox))
    entries: dict[str, dict[str, object]] = {}

    def ingest_index(path: Path, *, from_sandbox: bool) -> None:
        for entry in _iter_kimi_code_session_index_entries(path):
            session_id = entry.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                continue
            session_dir = entry.get("sessionDir")
            if isinstance(session_dir, str):
                entry["sessionDir"] = (
                    _translate_kimi_code_home_path(session_dir, sandbox_prefix, source_prefix)
                    if from_sandbox
                    else _normalize_kimi_code_fs_path(session_dir)
                )
            entries[session_id] = entry

    if source_index.is_file():
        ingest_index(source_index, from_sandbox=False)
    ingest_index(sandbox_index, from_sandbox=True)

    source_index.parent.mkdir(parents=True, exist_ok=True)
    merged = "\n".join(json.dumps(entries[session_id], ensure_ascii=False) for session_id in entries) + "\n"
    source_index.write_text(merged, encoding="utf-8")


def _kimi_code_path_prefix_variants(prefix: str) -> tuple[str, ...]:
    normalized = _normalize_kimi_code_fs_path(prefix)
    variants = [normalized]
    if normalized.startswith("/var/"):
        private_variant = "/private" + normalized
        if private_variant not in variants:
            variants.append(private_variant)
    if prefix not in variants and prefix != normalized:
        variants.append(prefix)
    return tuple(sorted(variants, key=len, reverse=True))


def _rewrite_kimi_code_text_paths(text: str, sandbox_prefix: str, source_prefix: str) -> str:
    target_prefix = _normalize_kimi_code_fs_path(source_prefix)
    rewritten = text
    for old_prefix in _kimi_code_path_prefix_variants(sandbox_prefix):
        rewritten = rewritten.replace(old_prefix, target_prefix)
    return rewritten


def _remap_kimi_code_sandbox_paths(source_home: Path, sandbox: Path) -> None:
    """Rewrite kimi-code session metadata that still points at the temp sandbox."""
    sandbox_prefix = _normalize_kimi_code_fs_path(str(sandbox))
    source_prefix = _normalize_kimi_code_fs_path(str(source_home))
    if sandbox_prefix == source_prefix:
        return

    index_path = source_home / "session_index.jsonl"
    if index_path.is_file():
        index_text = index_path.read_text(encoding="utf-8")
        rewritten = _rewrite_kimi_code_text_paths(index_text, sandbox_prefix, source_prefix)
        if rewritten != index_text:
            index_path.write_text(rewritten, encoding="utf-8")

    sessions_root = source_home / "sessions"
    if not sessions_root.is_dir():
        return
    for path in sessions_root.rglob("*"):
        if not path.is_file() or path.suffix not in _KIMI_CODE_SESSION_TEXT_SUFFIXES:
            continue
        try:
            original = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rewritten = _rewrite_kimi_code_text_paths(original, sandbox_prefix, source_prefix)
        if rewritten != original:
            path.write_text(rewritten, encoding="utf-8")


def _kimi_code_config_model_target(config: dict[str, object], model_name: str) -> str | None:
    models = config.get("models")
    providers = config.get("providers")
    if not model_name.strip() or not isinstance(models, dict) or not isinstance(providers, dict):
        return None
    alias = models.get(model_name.strip())
    if not isinstance(alias, dict):
        return None
    provider_name = alias.get("provider")
    if not isinstance(provider_name, str):
        return None
    provider = providers.get(provider_name)
    if not isinstance(provider, dict):
        return None
    base_url = _kimi_code_provider_base_url(provider)
    if base_url:
        return base_url
    if provider.get("type") == "kimi":
        return CONFIG.default_target
    return None


def _prepare_kimi_code_reverse_sandbox(
    port: int, cmd_args: Sequence[str] = ()
) -> tuple[Path, list[str], Path, list[str]]:
    source_home = _kimi_code_source_home()
    proxy_base = f"http://127.0.0.1:{port}"
    upstream_base = _detect_kimi_code_target(cmd_args)
    sandbox = Path(tempfile.mkdtemp(prefix=_KIMI_CODE_SANDBOX_DIR_PREFIX))
    patched_cmd_args = list(cmd_args)
    inline_config = _kimi_code_inline_config_arg(cmd_args)
    config_file_arg = _kimi_code_config_file_arg(cmd_args)

    if inline_config:
        patched_inline = _patch_kimi_code_inline_config(inline_config, proxy_base, cmd_args)
        patched_cmd_args = _replace_kimi_code_option_value(cmd_args, {"--config"}, patched_inline)
        (sandbox / "config.toml").write_text(_minimal_kimi_code_config_toml(proxy_base), encoding="utf-8")
        patched_providers = [_KIMI_CODE_MANAGED_PROVIDER]
    elif config_file_arg:
        source_config = Path(config_file_arg).expanduser()
        target_config = sandbox / ("config.json" if source_config.suffix.lower() == ".json" else "config.toml")
        try:
            source_text = source_config.read_text(encoding="utf-8")
        except OSError:
            source_text = ""
        if target_config.suffix.lower() == ".json" and source_text.strip():
            config = _read_kimi_code_config(path=source_config)
            patched, patched_providers = _patch_kimi_code_config_dict(config, proxy_base, cmd_args)
            target_config.write_text(json.dumps(patched, indent=2) + "\n", encoding="utf-8")
        else:
            patched_text, patched_providers = _patch_kimi_code_config_text(source_text, proxy_base, cmd_args)
            if not patched_providers:
                if _kimi_code_config_has_launch_state(source_text):
                    patched_text = source_text
                else:
                    patched_text = _minimal_kimi_code_config_toml(proxy_base)
                    patched_providers = [_KIMI_CODE_MANAGED_PROVIDER]
            target_config.write_text(patched_text, encoding="utf-8")
        _write_kimi_code_config_metadata(
            sandbox,
            source_config=source_config,
            sandbox_config=target_config,
            patched_text=target_config.read_text(encoding="utf-8"),
            proxy_base=proxy_base,
            upstream_base=upstream_base,
        )
        patched_cmd_args = _replace_kimi_code_option_value(cmd_args, {"--config-file"}, str(target_config))
    else:
        source_config = source_home / "config.toml"
        target_config = sandbox / "config.toml"
        if source_config.is_file():
            source_text = source_config.read_text(encoding="utf-8")
            patched_text, patched_providers = _patch_kimi_code_config_text(source_text, proxy_base, cmd_args)
            if not patched_providers:
                if _kimi_code_config_has_launch_state(source_text):
                    patched_text = source_text
                else:
                    patched_text = _minimal_kimi_code_config_toml(proxy_base)
                    patched_providers = [_KIMI_CODE_MANAGED_PROVIDER]
            target_config.write_text(patched_text, encoding="utf-8")
        else:
            target_config.write_text(_minimal_kimi_code_config_toml(proxy_base), encoding="utf-8")
            patched_providers = [_KIMI_CODE_MANAGED_PROVIDER]
        _write_kimi_code_config_metadata(
            sandbox,
            source_config=source_config,
            sandbox_config=target_config,
            patched_text=target_config.read_text(encoding="utf-8"),
            proxy_base=proxy_base,
            upstream_base=upstream_base,
        )

    for rel, is_dir in _KIMI_CODE_SANDBOX_LINKS:
        _link_kimi_code_sandbox_path(source_home, sandbox, rel, is_dir=is_dir)

    _materialize_kimi_code_session_index(source_home, sandbox)

    _sync_kimi_code_migration_suppression(source_home, sandbox)

    return sandbox, patched_providers, source_home, patched_cmd_args


def _detect_kimi_code_target(cmd_args: Sequence[str] = ()) -> str:
    config = _kimi_code_config_for_args(cmd_args)
    model_arg = _kimi_code_model_arg(cmd_args)
    if model_arg:
        base_url = _kimi_code_config_model_target(config, model_arg)
        if base_url:
            return base_url

    env_keys = ["KIMI_BASE_URL", "KIMI_CODE_BASE_URL"]
    if _has_active_kimi_code_model_env():
        env_keys.insert(0, "KIMI_MODEL_BASE_URL")
    for env_key in env_keys:
        base_url = os.environ.get(env_key, "").strip()
        if base_url:
            return base_url

    selected_model = model_arg
    if not selected_model:
        default_model = config.get("default_model")
        if isinstance(default_model, str) and default_model.strip():
            selected_model = default_model.strip()
    if isinstance(selected_model, str) and selected_model.strip():
        base_url = _kimi_code_config_model_target(config, selected_model.strip())
        if base_url:
            return base_url

    providers = config.get("providers")
    if isinstance(providers, dict):
        managed = providers.get(_KIMI_CODE_MANAGED_PROVIDER)
        if isinstance(managed, dict):
            base_url = _kimi_code_provider_base_url(managed)
            if base_url:
                return base_url
        for provider in providers.values():
            if isinstance(provider, dict) and provider.get("type") == "kimi":
                base_url = _kimi_code_provider_base_url(provider)
                if base_url:
                    return base_url

    return CONFIG.default_target


CONFIG = ClientConfig(
    cmd="kimi",
    label="Kimi Code CLI",
    install_url="https://github.com/MoonshotAI/kimi-code",
    base_url_env="KIMI_CODE_BASE_URL",
    base_url_suffix="",
    default_target="https://api.kimi.com/coding/v1",
)


class KimiCodePlugin(AgentPlugin):
    config = CONFIG
    display_label = "Kimi Code"

    def detect_target(self, args: Sequence[str]) -> str:
        return _detect_kimi_code_target(args)

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        sandbox, _patched_providers, source_home, ctx.args = _prepare_kimi_code_reverse_sandbox(ctx.port, ctx.args)
        ctx.state["sandbox"] = sandbox
        ctx.state["source_home"] = source_home
        has_model_arg = bool(_kimi_code_model_arg(ctx.args))
        if has_model_arg:
            ctx.env.pop("KIMI_MODEL_NAME", None)
            ctx.env.pop("KIMI_MODEL_BASE_URL", None)
        elif not _has_active_kimi_code_model_env():
            ctx.env.pop("KIMI_MODEL_BASE_URL", None)
        base_url = self.config.reverse_base_url(ctx.port)
        reverse_env = {"KIMI_CODE_HOME": str(sandbox), "KIMI_CODE_BASE_URL": base_url, "KIMI_BASE_URL": base_url}
        if not has_model_arg and _should_proxy_kimi_code_model_env():
            reverse_env["KIMI_MODEL_BASE_URL"] = base_url
        return reverse_env

    def reverse_summary(self, ctx: LaunchContext) -> list[str]:
        return [
            f"KIMI_CODE_HOME={ctx.env.get('KIMI_CODE_HOME', '')}",
            f"KIMI_CODE_BASE_URL={ctx.env.get('KIMI_CODE_BASE_URL', '')}",
        ]

    def on_launch_error(self, ctx: LaunchContext) -> None:
        sandbox = ctx.state.get("sandbox")
        if ctx.proxy_mode == "reverse" and isinstance(sandbox, Path):
            shutil.rmtree(sandbox, ignore_errors=True)

    def after_exit(self, ctx: LaunchContext, code: int, elapsed: float) -> None:
        sandbox = ctx.state.get("sandbox")
        source_home = ctx.state.get("source_home")
        if ctx.proxy_mode != "reverse" or not isinstance(sandbox, Path) or not isinstance(source_home, Path):
            return
        _merge_kimi_code_session_index(source_home, sandbox)
        _persist_kimi_code_sandbox(source_home, sandbox)
        _remap_kimi_code_sandbox_paths(source_home, sandbox)
        shutil.rmtree(sandbox, ignore_errors=True)


PLUGIN = KimiCodePlugin("kimi-code")
