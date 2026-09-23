"""Token Flow capture backend.

The inherited ``claude_tap`` module name is retained for storage and import
compatibility while the product and command-line interface use Token Flow.
"""

from __future__ import annotations

from claude_tap.capture.certs import CertificateAuthority, ensure_ca
from claude_tap.capture.forward_proxy import ForwardProxyServer
from claude_tap.capture.proxy import filter_headers
from claude_tap.commands.cli import (
    __version__,
    async_main,
    dashboard_main,
    main_entry,
    parse_args,
    parse_dashboard_args,
    parse_trust_ca_args,
    trust_ca_main,
)
from claude_tap.core.sse import SSEReassembler
from claude_tap.server.app import LiveViewerServer
from claude_tap.server.viewer import _generate_html_viewer
from claude_tap.storage.history import cleanup_trace_sessions, delete_trace_history, migrate_legacy_traces
from claude_tap.storage.trace import TraceWriter
from claude_tap.storage.trace_store import get_trace_store, reset_trace_store, resolve_db_path

__all__ = [
    "__version__",
    "main_entry",
    "parse_args",
    "parse_dashboard_args",
    "parse_trust_ca_args",
    "trust_ca_main",
    "async_main",
    "dashboard_main",
    "CertificateAuthority",
    "ensure_ca",
    "ForwardProxyServer",
    "SSEReassembler",
    "TraceWriter",
    "LiveViewerServer",
    "filter_headers",
    "_generate_html_viewer",
    "cleanup_trace_sessions",
    "delete_trace_history",
    "migrate_legacy_traces",
    "get_trace_store",
    "reset_trace_store",
    "resolve_db_path",
]
