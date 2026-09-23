"""Compatibility imports for dashboard session analysis.

Dashboard data queries and summary transformations live in
``token_tap.analysis.sessions``. This module keeps existing internal imports
working while HTML template access remains at the dashboard boundary.
"""

# ruff: noqa: F401

from __future__ import annotations

from pathlib import Path

from token_tap.analysis.sessions import (
    DASHBOARD_SUMMARY_VERSION,
    VALID_SESSION_STATUSES,
    _agent_filter_values,
    _bedrock_events,
    _clean_user_prompt_text,
    _content_text,
    _event_payload,
    _first_error,
    _infer_agent,
    _input_user_text,
    _parts_text,
    _preview,
    _record_host,
    _record_model,
    _record_response_text,
    _record_usage,
    _request_user_text,
    _response_events,
    _response_text,
    build_imported_session_summary,
    build_session_query,
    build_stored_session_summary,
    count_trace_sessions,
    dashboard_trace_snapshot,
    ensure_trace_store,
    is_dashboard_summary_current,
    list_trace_agents,
    list_trace_sessions,
    load_trace_session,
    merge_record_into_summary,
    redact_dashboard_records,
    redact_dashboard_summary,
    select_trace_turn_records,
    sum_trace_session_records,
)

DASHBOARD_TEMPLATE_PATH = Path(__file__).parents[1] / "dashboard.html"


def read_dashboard_template() -> str:
    """Read the packaged dashboard HTML."""
    return DASHBOARD_TEMPLATE_PATH.read_text(encoding="utf-8")
