"""Hermes Agent agent plugin."""

from __future__ import annotations

from token_tap.agents.base import (
    AgentPlugin,
    ClientConfig,
    LaunchContext,
    _multi_provider_reverse_env,
)
from token_tap.commands.cli_output import print_status as _print

_HERMES_GLOBAL_OPTS_WITH_VALUE = {"--profile", "-p"}


_HERMES_GLOBAL_BOOLEAN_OPTS = {"--ignore-user-config", "--accept-hooks"}


def _maybe_rewrite_hermes_gateway_start(cmd_args: list[str]) -> list[str]:
    """Rewrite ``hermes [global-opts] gateway start`` to ``... gateway run``.

    Recent hermes versions delegate ``gateway start`` to systemd / launchd,
    which spawn the gateway in a fresh env that does NOT inherit the
    HTTPS_PROXY / CA env we inject — trace capture would silently fail.
    ``gateway run`` is the foreground equivalent (it's exactly what the
    systemd unit's ``ExecStart=`` invokes), so the spawned process is our
    child and inherits the injected env.

    Hermes' CLI shape is ``hermes [global-options] <command> [...]``, so the
    rewrite skips any recognised leading global options before matching
    ``gateway start``.
    """
    i = 0
    while i < len(cmd_args):
        arg = cmd_args[i]
        if arg in _HERMES_GLOBAL_OPTS_WITH_VALUE and i + 1 < len(cmd_args):
            i += 2
            continue
        if "=" in arg and arg.split("=", 1)[0] in _HERMES_GLOBAL_OPTS_WITH_VALUE:
            i += 1
            continue
        if arg in _HERMES_GLOBAL_BOOLEAN_OPTS:
            i += 1
            continue
        break
    if i + 1 < len(cmd_args) and cmd_args[i] == "gateway" and cmd_args[i + 1] == "start":
        _print(
            "ℹ️  Rewriting `hermes gateway start` to `hermes gateway run` so the "
            "gateway runs in the foreground under Token Flow. Recent hermes "
            "versions delegate `gateway start` to systemd / launchd, which spawns "
            "the gateway in a fresh env that does NOT inherit the proxy / CA env "
            "we inject — trace capture would silently fail. Pass --tap-no-launch "
            "and start the gateway yourself if you want the daemonised behaviour."
        )
        return cmd_args[:i] + ["gateway", "run"] + cmd_args[i + 2 :]
    return cmd_args


CONFIG = ClientConfig(
    cmd="hermes",
    label="Hermes Agent",
    install_url="https://github.com/NousResearch/hermes-agent",
    base_url_env="OPENAI_BASE_URL",
    base_url_suffix="/v1",
    default_target="https://api.openai.com",
    # hermes is a Python 3.11+ multi-provider agent; reverse mode requires
    # a user-configured OpenAI-compatible provider in ~/.hermes that honors
    # OPENAI_BASE_URL. Default to forward proxy capture.
    default_proxy_mode="forward",
)


class HermesPlugin(AgentPlugin):
    config = CONFIG
    display_label = "Hermes"

    def prepare_args(self, args: list[str]) -> list[str]:
        return _maybe_rewrite_hermes_gateway_start(args)

    def reverse_env(self, ctx: LaunchContext) -> dict[str, str]:
        if ctx.capture_only:
            return _multi_provider_reverse_env(ctx.port)
        return super().reverse_env(ctx)


PLUGIN = HermesPlugin("hermes")
