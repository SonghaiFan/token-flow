"""Shared helpers for classifying and parsing request bodies for trace storage."""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any

PROTOBUF_CONTENT_TYPE_TOKENS = (
    "application/proto",
    "application/x-protobuf",
    "application/connect+proto",
    "application/grpc",
)

_ENCODED_BLOB_ENCODINGS = frozenset({"protobuf", "binary"})


def content_type_from_headers(headers: Mapping[str, Any] | None) -> str:
    if not headers:
        return ""
    return str(headers.get("Content-Type") or headers.get("content-type") or "")


def is_protobuf_content_type(content_type: str) -> bool:
    lowered = content_type.lower()
    return any(token in lowered for token in PROTOBUF_CONTENT_TYPE_TOKENS)


def looks_like_binary_text(text: str) -> bool:
    if not text:
        return False
    sample = text[:256]
    if "\ufffd" in sample:
        return True
    control = sum(1 for ch in sample if ord(ch) < 32 and ch not in "\t\n\r")
    return control / max(len(sample), 1) >= 0.1


def is_encoded_blob_body(body: Any) -> bool:
    return isinstance(body, dict) and body.get("_encoding") in _ENCODED_BLOB_ENCODINGS


def parse_request_body_for_trace(body: bytes, headers: Mapping[str, str] | None = None) -> object:
    """Parse a request body for trace storage without mutating upstream bytes."""
    if not body:
        return None

    if is_protobuf_content_type(content_type_from_headers(headers)):
        return {"_encoding": "protobuf", "byte_length": len(body)}

    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return body.decode("utf-8", errors="replace")

    if isinstance(parsed, str):
        try:
            inner = json.loads(parsed)
        except (json.JSONDecodeError, ValueError):
            return parsed
        if isinstance(inner, dict):
            return inner

    return parsed


def _decode_bedrock_eventstream_events(body: object) -> list[dict]:
    """Extract normalized stream events from a decoded AWS EventStream body.

    Bedrock streaming responses are binary AWS EventStream frames. Legacy
    traces may contain those bytes decoded as text with invalid frame bytes
    replaced, but the JSON payloads inside the frames remain intact.
    """
    error_event_keys = {
        "internalServerException",
        "modelStreamErrorException",
        "modelTimeoutException",
        "serviceUnavailableException",
        "throttlingException",
        "validationException",
    }
    if not isinstance(body, str):
        return []
    stream_event_keys = (
        "bytes",
        "chunk",
        "type",
        "messageStart",
        "contentBlockStart",
        "contentBlockDelta",
        "contentBlockStop",
        "messageStop",
        "metadata",
        *error_event_keys,
    )
    if not any(f'"{key}"' in body for key in stream_event_keys):
        return []

    def _converse_event_payload(payload: dict) -> tuple[str | None, dict | None]:
        message_start = payload.get("messageStart")
        if isinstance(message_start, dict):
            return "message_start", {
                "message": {
                    "type": "message",
                    "role": message_start.get("role") or "assistant",
                    "content": [],
                }
            }

        block_start = payload.get("contentBlockStart")
        if isinstance(block_start, dict):
            start = block_start.get("start") if isinstance(block_start.get("start"), dict) else {}
            tool_use = start.get("toolUse") if isinstance(start, dict) else None
            block: dict = {}
            if isinstance(tool_use, dict):
                block = {
                    "type": "tool_use",
                    "id": tool_use.get("toolUseId", ""),
                    "name": tool_use.get("name", ""),
                    "input": {},
                }
            return "content_block_start", {
                "index": block_start.get("contentBlockIndex", payload.get("contentBlockIndex", 0)),
                "content_block": block,
            }

        block_delta = payload.get("contentBlockDelta")
        if isinstance(block_delta, dict):
            delta = block_delta.get("delta") if isinstance(block_delta.get("delta"), dict) else {}
            normalized_delta: dict = {}
            if isinstance(delta.get("text"), str):
                normalized_delta = {"type": "text_delta", "text": delta["text"]}
            elif isinstance(delta.get("reasoningContent"), dict):
                reasoning = delta["reasoningContent"]
                text = reasoning.get("text") if isinstance(reasoning.get("text"), str) else ""
                normalized_delta = {"type": "thinking_delta", "thinking": text}
                signature = reasoning.get("signature") if isinstance(reasoning.get("signature"), str) else ""
                if signature:
                    normalized_delta["signature"] = signature
            elif isinstance(delta.get("toolUse"), dict):
                tool_delta = delta["toolUse"]
                partial = tool_delta.get("input") if isinstance(tool_delta.get("input"), str) else ""
                normalized_delta = {"type": "input_json_delta", "partial_json": partial}
            if normalized_delta:
                return "content_block_delta", {
                    "index": block_delta.get("contentBlockIndex", payload.get("contentBlockIndex", 0)),
                    "delta": normalized_delta,
                }

        block_stop = payload.get("contentBlockStop")
        if isinstance(block_stop, dict):
            return "content_block_stop", {
                "index": block_stop.get("contentBlockIndex", payload.get("contentBlockIndex", 0)),
            }

        message_stop = payload.get("messageStop")
        if isinstance(message_stop, dict):
            return "message_delta", {
                "delta": {"stop_reason": message_stop.get("stopReason")},
            }

        metadata = payload.get("metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("usage"), dict):
            return "message_delta", {"usage": metadata["usage"]}

        return None, None

    def _event_payload_from_frame(frame: dict) -> tuple[str | None, dict | None]:
        encoded = frame.get("bytes")
        if not isinstance(encoded, str):
            chunk = frame.get("chunk")
            if isinstance(chunk, dict):
                encoded = chunk.get("bytes")
        if isinstance(encoded, str):
            try:
                payload_bytes = base64.b64decode(encoded, validate=True)
                payload = json.loads(payload_bytes)
            except (ValueError, json.JSONDecodeError):
                return None, None
            if not isinstance(payload, dict):
                return None, None

            event_type = payload.get("type")
            if isinstance(event_type, str) and event_type:
                return event_type, payload
            event_type, event_payload = _converse_event_payload(payload)
            if event_type and event_payload:
                return event_type, event_payload
            for event_type in error_event_keys:
                event_payload = payload.get(event_type)
                if isinstance(event_payload, dict):
                    return event_type, event_payload
            return None, None

        event_type = frame.get("type")
        if isinstance(event_type, str) and event_type:
            return event_type, frame
        event_type, event_payload = _converse_event_payload(frame)
        if event_type and event_payload:
            return event_type, event_payload

        for event_type in error_event_keys:
            payload = frame.get(event_type)
            if isinstance(payload, dict):
                return event_type, payload
        return None, None

    events: list[dict] = []
    decoder = json.JSONDecoder()
    pos = 0
    while True:
        start = body.find('{"', pos)
        if start < 0:
            break
        try:
            frame, end = decoder.raw_decode(body[start:])
        except json.JSONDecodeError:
            pos = start + 1
            continue
        pos = start + end

        if not isinstance(frame, dict):
            continue
        event_type, payload = _event_payload_from_frame(frame)
        if event_type and payload:
            events.append({"event": event_type, "data": payload})

    return events
