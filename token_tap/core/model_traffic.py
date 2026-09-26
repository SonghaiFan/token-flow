"""Classify captured requests as model traffic from the request line alone."""

from __future__ import annotations

import re
from typing import Any

PRIMARY_MODEL_PATH_FRAGMENTS = (
    "/v1/messages",
    "/zen/v1/messages",
    "/v1/responses",
    "/responses",
    "/backend-api/codex/responses",
    "/v1/chat/completions",
    "/chat/completions",
    "/v1/completions",
    "/completions",
    "streamgeneratecontent",
    "generatecontent",
)

# RFC 9110 method token characters.
_HTTP_METHOD_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
# Methods that cannot carry a model prompt: browser navigation, asset fetches,
# health checks, and CORS preflights all land here.
_BODYLESS_METHODS = {"GET", "HEAD", "OPTIONS"}
_NON_HTTP_TRANSPORTS = {"websocket", "cursor-transcript"}


def is_primary_model_path(path: str) -> bool:
    lowered = path.lower()
    return bool(lowered) and any(fragment in lowered for fragment in PRIMARY_MODEL_PATH_FRAGMENTS)


def is_model_probe_path(path: str) -> bool:
    """Return whether ``path`` lists or describes models (model API, but not a turn)."""
    clean_path = path.lower().split("?", 1)[0].rstrip("/")
    if clean_path in {"/models", "/v1/models", "/v1alpha/models", "/v1beta/models"}:
        return True
    return re.fullmatch(r"/(?:v1/)?models/([^/:]+)", clean_path) is not None


def is_non_model_request(record: dict[str, Any]) -> bool:
    """Return whether the captured request line itself rules out model traffic.

    A proxy port is reachable by anything on the machine, so captures can hold
    browser probes (``GET /``, ``GET /favicon.ico``, ``HEAD /``) and TLS bytes
    sent to a plain-HTTP port, which parse as a garbage request line. Those are
    kept in raw exports but are neither turns nor session errors.
    """
    if str(record.get("transport") or "") in _NON_HTTP_TRANSPORTS:
        return False
    request = record.get("request")
    if not isinstance(request, dict):
        return False
    method = request.get("method")
    path = request.get("path")
    if not isinstance(path, str):
        path = ""
    if isinstance(method, str) and method and not _HTTP_METHOD_RE.match(method):
        return True
    if path and (not path.startswith("/") or not path.isprintable() or "\ufffd" in path):
        return True
    if not isinstance(method, str) or method.upper() not in _BODYLESS_METHODS:
        return False
    return not is_primary_model_path(path) and not is_model_probe_path(path)
