"""Generic client launcher for the Token Flow CLI.

Everything client-specific lives in the agent plugins under ``token_tap.agents``;
this module only runs the shared launch sequence and calls their hooks.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
from pathlib import Path

from token_tap.agents import client_configs, get_agent
from token_tap.agents.base import LaunchContext, _extend_no_proxy, _has_settings_arg, _settings_arg
from token_tap.commands.cli_output import print_status as _print

CLIENT_CONFIGS = client_configs()


def _prefer_windows_command_shim(resolved_cmd: str) -> str:
    """Replace an extensionless npm POSIX shim with its Windows batch sibling."""
    if sys.platform != "win32" or Path(resolved_cmd).suffix:
        return resolved_cmd
    for suffix in (".cmd", ".bat"):
        candidate = Path(f"{resolved_cmd}{suffix}")
        if candidate.is_file():
            return str(candidate)
    return resolved_cmd


def _reverse_proxy_trace_options(client: str, target: str) -> dict[str, object]:
    cfg = CLIENT_CONFIGS[client]
    return {
        "strip_path_prefix": cfg.reverse_strip_path_prefix(target),
        "force_http": False,
    }


def _forward_proxy_env(ctx: LaunchContext) -> None:
    proxy_url = ctx.proxy_url
    # Set both upper/lower-case variants for tools that read one form only.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        ctx.env[key] = proxy_url


async def run_client(
    port: int,
    extra_args: list[str],
    client: str = "claude",
    proxy_mode: str = "reverse",
    ca_cert_path: Path | None = None,
    client_cmd: str | None = None,
    capture_only: bool = False,
    launch_state: dict[str, object] | None = None,
) -> int:
    """Launch one client under the capture proxy and wait for it to exit.

    ``launch_state`` is the result of the plugin's ``prepare_launch`` when the
    caller already ran it before starting the proxy.
    """
    plugin = get_agent(client)
    cfg = plugin.config

    # asyncio.create_subprocess_exec uses CreateProcess on Windows, which only
    # auto-appends `.exe`; resolve here so npm `.cmd`/`.bat` shims also work.
    display_cmd = client_cmd or cfg.cmd
    resolved_cmd = plugin.resolve_executable(client_cmd)
    if resolved_cmd is None:
        if client_cmd:
            _print(f"\nError: '{client_cmd}' command not found.\nPlease check the wrapper-provided {cfg.label} path.\n")
        else:
            _print(plugin.missing_executable_help())
        return 1
    resolved_cmd = _prefer_windows_command_shim(resolved_cmd)
    if launch_state is None:
        launch_state = await plugin.prepare_launch(proxy_mode)
        if launch_state is None:
            return 1

    ctx = LaunchContext(
        port=port,
        proxy_mode=proxy_mode,
        capture_only=capture_only,
        ca_cert_path=ca_cert_path,
        env=os.environ.copy(),
        args=plugin.prepare_args(list(extra_args)),
        state=dict(launch_state),
    )
    env = ctx.env

    if proxy_mode == "forward":
        error = plugin.forward_launch_error(env)
        if error:
            _print(error)
            return 1
        _forward_proxy_env(ctx)
        if plugin.node_env_proxy:
            # Node fetch only reads proxy env vars when built-in environment
            # proxy support is enabled.
            env["NODE_USE_ENV_PROXY"] = "1"
        _extend_no_proxy(env, ("localhost", "127.0.0.1", "::1"))
        plugin.configure_forward(ctx)
        forward_base_url = cfg.reverse_base_url(port)
        for env_key in cfg.forward_base_url_envs:
            env[env_key] = forward_base_url
        if ca_cert_path:
            env["NODE_EXTRA_CA_CERTS"] = str(ca_cert_path)
            # Codex is a Rust binary; NODE_EXTRA_CA_CERTS does not affect its TLS stack.
            env["SSL_CERT_FILE"] = str(ca_cert_path)
            env["CODEX_CA_CERTIFICATE"] = str(ca_cert_path)
            # hermes is Python (httpx + requests); SSL_CERT_FILE covers httpx,
            # REQUESTS_CA_BUNDLE covers the requests library.
            env["REQUESTS_CA_BUNDLE"] = str(ca_cert_path)

        if cfg.inject_settings_env and not _has_settings_arg(ctx.args):
            settings_env = {
                key: ctx.proxy_url
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
            }
            if ca_cert_path:
                settings_env["NODE_EXTRA_CA_CERTS"] = str(ca_cert_path)
            ctx.args = _settings_arg(settings_env) + ctx.args
        # Don't set reverse-mode provider-specific base URL in forward mode.
    else:
        reverse_env = plugin.reverse_env(ctx)
        env.update(reverse_env)
        plugin.configure_reverse(ctx)
        if cfg.inject_settings_env and not _has_settings_arg(ctx.args):
            ctx.args = _settings_arg(reverse_env) + ctx.args

    for key in cfg.nesting_env_keys:
        env.pop(key, None)

    cmd = [resolved_cmd] + ctx.args
    _print(f"\n🚀 Starting {cfg.label}: {' '.join([display_cmd, *ctx.args])}")
    if proxy_mode == "forward":
        _print(f"   HTTPS_PROXY=http://127.0.0.1:{port}")
        for env_key in cfg.forward_base_url_envs:
            _print(f"   {env_key}={cfg.reverse_base_url(port)}")
        if ca_cert_path:
            _print(f"   NODE_EXTRA_CA_CERTS={ca_cert_path}")
    else:
        for line in plugin.reverse_summary(ctx):
            _print(f"   {line}")
    _print()

    # Give TUI children their own process group and make them the foreground
    # group so they have full terminal control (e.g. Cmd+Delete, Ctrl+U).
    hide_child_output = plugin.hide_child_output
    use_fg = not hide_child_output and hasattr(os, "tcsetpgrp") and sys.stdin.isatty()

    def _remove_cleanup_paths() -> None:
        for path in ctx.cleanup_paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            env=env,
            stdin=subprocess.DEVNULL if hide_child_output else None,
            stdout=subprocess.DEVNULL if hide_child_output else None,
            stderr=subprocess.DEVNULL if hide_child_output else None,
            **({"process_group": 0} if use_fg else {}),
        )
    except Exception:
        _remove_cleanup_paths()
        plugin.on_launch_error(ctx)
        raise

    if use_fg:
        try:
            os.tcsetpgrp(sys.stdin.fileno(), proc.pid)
        except OSError:
            pass

    # --- Signal handling: graceful Ctrl+C / Ctrl+Z ---
    loop = asyncio.get_running_loop()

    # SIGTSTP is Unix-only; on Windows the attribute is absent.
    sigtstp = getattr(signal, "SIGTSTP", None)
    old_sigtstp = signal.signal(sigtstp, signal.SIG_IGN) if sigtstp is not None else None

    sigint_count = 0

    def _handle_sigint():
        nonlocal sigint_count
        sigint_count += 1
        if sigint_count == 1:
            if proc.returncode is None:
                proc.terminate()
                _print(f"\n⏳ Shutting down {cfg.label}... (Ctrl+C again to force)")
        else:
            if proc.returncode is None:
                proc.kill()

    def _handle_sigtstp():
        if proc.returncode is None:
            proc.terminate()
            _print(f"\n⏳ Shutting down {cfg.label}...")

    try:
        loop.add_signal_handler(signal.SIGINT, _handle_sigint)
        if sigtstp is not None:
            loop.add_signal_handler(sigtstp, _handle_sigtstp)
    except (NotImplementedError, OSError):
        pass

    started_at = loop.time()
    code: int | None = None
    try:
        code = await proc.wait()
    finally:
        _remove_cleanup_paths()
        plugin.after_exit(ctx, code if code is not None else -1, loop.time() - started_at)

    # Restore parent as foreground process group.
    # Ignore SIGTTOU first — the parent is still in the background group
    # and any terminal write (including tcsetpgrp) would suspend it.
    if use_fg:
        old_sigttou = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
        try:
            os.tcsetpgrp(sys.stdin.fileno(), os.getpgrp())
        except OSError:
            pass
        signal.signal(signal.SIGTTOU, old_sigttou)

    # Restore original SIGTSTP handler and remove async signal handlers
    if sigtstp is not None and old_sigtstp is not None:
        signal.signal(sigtstp, old_sigtstp)
    try:
        loop.remove_signal_handler(signal.SIGINT)
    except (NotImplementedError, OSError):
        pass
    if sigtstp is not None:
        try:
            loop.remove_signal_handler(sigtstp)
        except (NotImplementedError, OSError):
            pass

    _print(f"\n📋 {cfg.label} exited with code {code}")
    hint = plugin.exit_hint(ctx, code, loop.time() - started_at)
    if hint:
        _print(hint)
    return code
