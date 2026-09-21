"""Cost plumbing between the Python pricing adapter and the viewer.

The adapter itself is covered by tests/test_pricing.py. These tests assert that
every viewer generation path carries the precomputed numbers, and that the keys
of the embedded cost index match the entry ids the viewer derives client-side.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from claude_tap.compact_trace import build_compact_trace_bundle
from claude_tap.viewer import (
    _build_cost_index,
    _cache_ttl_1h,
    _completed_web_search_calls,
    _extract_metadata_from_record,
    _generate_html_viewer,
    _generate_html_viewer_from_metadata,
    _generate_html_viewer_from_records,
    _websocket_response_groups,
    attach_cost_to_record,
)

SONNET_4 = "claude-sonnet-4-20250514"


def _anthropic_record(request_id: str = "req_1", *, cache_read: int = 40_000) -> dict:
    return {
        "timestamp": "2026-08-19T10:00:00+00:00",
        "request_id": request_id,
        "turn": 1,
        "duration_ms": 900,
        "request": {
            "method": "POST",
            "path": "/v1/messages",
            "headers": {"host": "api.anthropic.com"},
            "body": {
                "model": SONNET_4,
                "system": [{"type": "text", "text": "You are Claude Code.", "cache_control": {"type": "ephemeral"}}],
                "messages": [{"role": "user", "content": "hi"}],
            },
        },
        "response": {
            "status": 200,
            "headers": {"content-type": "application/json"},
            "body": {
                "model": SONNET_4,
                "content": [{"type": "text", "text": "hello"}],
                "usage": {
                    "input_tokens": 120,
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": 2_000,
                    "output_tokens": 45,
                },
            },
        },
    }


def _ws_event(event_type: str, **extra: object) -> dict:
    """Match the captured shape: the event type sits on the outer object."""
    return {"type": event_type, **extra}


def _ws_record(request_id: str = "req_ws") -> dict:
    """A single record carrying two completed responses, as the viewer splits it."""

    def completed(tokens: int) -> dict:
        return _ws_event(
            "response.completed",
            response={
                "model": SONNET_4,
                "output": [],
                "usage": {"input_tokens": tokens, "output_tokens": 10},
            },
        )

    return {
        "timestamp": "2026-08-19T10:05:00+00:00",
        "request_id": request_id,
        "turn": 2,
        "request": {"method": "GET", "path": "/v1/realtime", "headers": {}, "body": {}},
        "response": {
            "status": 101,
            "headers": {},
            "ws_events": [
                _ws_event("response.created", response={"model": SONNET_4}),
                completed(1_000),
                _ws_event("response.created", response={"model": SONNET_4}),
                completed(2_000),
            ],
        },
    }


def _single_response_ws_record(request_id: str = "req_ws1") -> dict:
    """A WebSocket record with one response, which the viewer does not split.

    The request body names no model, as the captured realtime handshake does not
    carry one — only the streamed response payload does.
    """
    return {
        "timestamp": "2026-08-19T10:06:00+00:00",
        "request_id": request_id,
        "turn": 3,
        "request": {"method": "GET", "path": "/v1/realtime", "headers": {}, "body": {}},
        "response": {
            "status": 101,
            "headers": {},
            "ws_events": [
                _ws_event("response.created", response={"model": SONNET_4}),
                _ws_event(
                    "response.completed",
                    response={
                        "model": SONNET_4,
                        "output": [],
                        "usage": {"input_tokens": 3_000, "output_tokens": 20},
                    },
                ),
            ],
        },
    }


def _embedded_const(html: str, name: str) -> object:
    match = re.search(rf"const {name} = (.*?);\n", html, re.DOTALL)
    assert match, f"{name} missing from generated viewer"
    return json.loads(match.group(1))


def test_metadata_record_carries_cost_and_cache_provenance() -> None:
    meta = _extract_metadata_from_record(_anthropic_record())
    assert meta is not None

    assert meta["priced_model"] == SONNET_4
    assert meta["cache_read_in_input"] is False
    assert meta["long_context"] is False
    # 120 fresh input + 40K cache read + 2K cache write + 45 output.
    assert meta["cost"] == pytest.approx(120 * 3e-06 + 40_000 * 3e-07 + 2_000 * 3.75e-06 + 45 * 1.5e-05)
    assert meta["uncached_cost"] == pytest.approx(42_120 * 3e-06 + 45 * 1.5e-05)
    assert meta["saved"] == pytest.approx(meta["uncached_cost"] - meta["cost"])


def test_unpriced_model_leaves_cost_off_the_metadata_record() -> None:
    record = _anthropic_record()
    record["request"]["body"]["model"] = "some-unlisted-gateway-model"
    record["response"]["body"]["model"] = "some-unlisted-gateway-model"

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert "cost" not in meta
    assert "saved" not in meta


def test_cache_ttl_1h_is_read_from_the_request_breakpoints() -> None:
    assert _cache_ttl_1h({}) is False
    assert _cache_ttl_1h({"system": [{"cache_control": {"type": "ephemeral"}}]}) is False
    assert _cache_ttl_1h({"system": [{"cache_control": {"type": "ephemeral", "ttl": "1h"}}]}) is True
    assert _cache_ttl_1h({"messages": [{"content": [{"text": "x", "cache_control": {"ttl": "1h"}}]}]}) is True


def test_one_hour_breakpoint_raises_the_cache_write_cost() -> None:
    default_ttl = _extract_metadata_from_record(_anthropic_record())
    record = _anthropic_record()
    record["request"]["body"]["system"][0]["cache_control"]["ttl"] = "1h"
    one_hour = _extract_metadata_from_record(record)
    assert default_ttl is not None and one_hour is not None

    assert one_hour["cost"] > default_ttl["cost"]
    assert one_hour["cost"] - default_ttl["cost"] == pytest.approx(2_000 * (6e-06 - 3.75e-06))


def test_websocket_groups_require_a_completed_response() -> None:
    events = [
        _ws_event("response.created", response={"model": SONNET_4}),
        _ws_event("response.output_text.delta", delta="a"),
    ]

    assert _websocket_response_groups(events) == []


def test_cost_index_keys_match_the_viewer_websocket_entry_ids() -> None:
    index = _build_cost_index([_ws_record()])

    # buildWebSocketResponseEntry keys split entries `${request_id}:${idx + 1}`.
    assert sorted(index) == ["req_ws:1", "req_ws:2"]
    assert index["req_ws:1"]["cost"] == pytest.approx(1_000 * 3e-06 + 10 * 1.5e-05)
    assert index["req_ws:2"]["cost"] == pytest.approx(2_000 * 3e-06 + 10 * 1.5e-05)


def test_cost_index_keys_plain_records_by_request_id() -> None:
    index = _build_cost_index([_anthropic_record("req_plain")])

    assert list(index) == ["req_plain"]
    assert set(index["req_plain"]) == {
        "cost",
        "uncached_cost",
        "saved",
        "priced_model",
        "long_context",
    }


def test_cost_index_skips_records_without_a_request_id() -> None:
    record = _anthropic_record()
    del record["request_id"]

    assert _build_cost_index([record, "not a dict"]) == {}  # type: ignore[list-item]


def test_compact_bundle_viewer_embeds_a_cost_index(tmp_path: Path) -> None:
    html_path = tmp_path / "viewer.html"
    trace_path = tmp_path / "trace.jsonl"
    trace_path.write_text(json.dumps(_anthropic_record("req_compact")) + "\n", encoding="utf-8")

    _generate_html_viewer(trace_path, html_path)
    html = html_path.read_text(encoding="utf-8")

    index = _embedded_const(html, "EMBEDDED_COST_INDEX")
    assert isinstance(index, dict)
    assert index["req_compact"]["cost"] > 0
    meta = _embedded_const(html, "EMBEDDED_PRICING_META")
    assert isinstance(meta, dict)
    assert meta["source_url"].startswith("https://raw.githubusercontent.com/BerriAI/litellm/")
    assert meta["as_of"]


def test_records_viewer_embeds_a_cost_index(tmp_path: Path) -> None:
    html_path = tmp_path / "viewer.html"

    _generate_html_viewer_from_records(
        [json.dumps(_anthropic_record("req_inline"))],
        html_path,
        display_trace_path="trace.jsonl",
        display_html_path=html_path,
    )
    html = html_path.read_text(encoding="utf-8")

    index = _embedded_const(html, "EMBEDDED_COST_INDEX")
    assert isinstance(index, dict)
    assert index["req_inline"]["cost"] > 0


def test_metadata_viewer_ships_provenance_without_an_index(tmp_path: Path) -> None:
    """Lazy mode carries cost on each metadata record, so the index stays empty."""
    html_path = tmp_path / "viewer.html"
    meta = _extract_metadata_from_record(_anthropic_record("req_lazy"))
    assert meta is not None

    _generate_html_viewer_from_metadata(
        [meta],
        html_path,
        display_trace_path="trace.jsonl",
        display_html_path=html_path,
        records_api_path="/records",
    )
    html = html_path.read_text(encoding="utf-8")

    assert _embedded_const(html, "EMBEDDED_COST_INDEX") == {}
    assert _embedded_const(html, "EMBEDDED_PRICING_META")["as_of"]
    embedded_meta = _embedded_const(html, "EMBEDDED_TRACE_META")
    assert isinstance(embedded_meta, list)
    assert embedded_meta[0]["cost"] > 0


def test_compact_bundle_round_trip_keeps_costs_addressable() -> None:
    bundle = build_compact_trace_bundle([_anthropic_record("req_a"), _anthropic_record("req_b")])

    assert bundle
    index = _build_cost_index([_anthropic_record("req_a"), _anthropic_record("req_b")])
    assert sorted(index) == ["req_a", "req_b"]


def test_a_single_response_websocket_record_is_priced_by_request_id() -> None:
    # The viewer only rewrites the entry id when it splits a record, so a record
    # with one response has to be keyed plainly or the turn shows no cost.
    index = _build_cost_index([_single_response_ws_record()])

    assert list(index) == ["req_ws1"]
    assert index["req_ws1"]["cost"] == pytest.approx(3_000 * 3e-06 + 20 * 1.5e-05)


def test_the_model_is_read_from_the_response_when_the_request_omits_it() -> None:
    meta = _extract_metadata_from_record(_single_response_ws_record())

    assert meta is not None
    assert meta["priced_model"] == SONNET_4


def test_raw_records_carry_their_costs_for_the_live_viewer() -> None:
    plain = attach_cost_to_record(_anthropic_record("req_live"))

    assert set(plain["_cost_index"]) == {"req_live"}
    assert plain["_cost_index"]["req_live"]["cost"] > 0

    split = attach_cost_to_record(_ws_record())
    assert sorted(split["_cost_index"]) == ["req_ws:1", "req_ws:2"]


def test_a_split_record_sums_every_response_into_its_one_metadata_stub() -> None:
    # There is one metadata stub per record, and the lazy and dashboard viewers read
    # cost from that stub alone — their embedded index is empty and they never
    # expand a record into per-response entries. Reading only the last response
    # would drop every earlier one from the displayed total.
    meta = _extract_metadata_from_record(_ws_record())
    assert meta is not None

    first = 1_000 * 3e-06 + 10 * 1.5e-05
    second = 2_000 * 3e-06 + 10 * 1.5e-05
    assert meta["cost"] == pytest.approx(first + second)
    assert meta["input_tokens"] == 3_000
    assert meta["output_tokens"] == 20


def test_a_split_record_with_one_unpriceable_response_reports_no_total() -> None:
    # A total that silently omits one of the responses would still be displayed as
    # if it covered the whole record.
    record = _ws_record()
    events = record["response"]["ws_events"]
    events[3]["response"]["model"] = "some-unlisted-gateway-model"

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert "cost" not in meta


def test_a_priceable_response_model_wins_over_an_unlisted_request_alias() -> None:
    # A gateway names its own deployment alias in the request body while the
    # response reports the model actually billed.
    record = _anthropic_record("req_alias")
    record["request"]["body"]["model"] = "some-gateway-deployment-alias"

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["model"] == SONNET_4
    assert meta["cost"] > 0


def test_the_billed_response_model_wins_over_a_priceable_deployment_alias() -> None:
    """An Azure deployment name can itself be a table key at a cheaper rate.

    A deployment called `gpt-4o` answering as `gpt-4o-2024-11-20` resolves to
    `azure/gpt-4o` (2.5/10 per million) when the request name is consulted first,
    while the model actually billed is `azure/gpt-4o-2024-11-20` (2.75/11) — a 10%
    understatement on every such turn.
    """
    record = _anthropic_record("req_azure_alias")
    record["request"]["path"] = "/openai/deployments/gpt-4o/chat/completions"
    record["request"]["headers"] = {"host": "my-resource.openai.azure.com"}
    record["upstream_base_url"] = "https://my-resource.openai.azure.com"
    record["request"]["body"]["model"] = "gpt-4o"
    record["response"]["body"]["model"] = "gpt-4o-2024-11-20"
    # Neither entry carries a cache-write rate, so a write bucket would make the
    # turn unpriceable and hide which rate was chosen.
    record["response"]["body"]["usage"] = {"input_tokens": 1_000, "output_tokens": 100}

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["model"] == "gpt-4o-2024-11-20"
    assert meta["cost"] == pytest.approx(1_000 * 2.75e-06 + 100 * 1.1e-05)
    assert meta["cost"] != pytest.approx(1_000 * 2.5e-06 + 100 * 1e-05)


def test_an_unpriceable_record_still_displays_the_requested_model() -> None:
    record = _anthropic_record("req_unlisted")
    record["request"]["body"]["model"] = "some-gateway-deployment-alias"
    record["response"]["body"]["model"] = "another-unlisted-model"

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["model"] == "some-gateway-deployment-alias"
    assert "cost" not in meta


def _codex_record(request_id: str = "req_codex", **overrides: object) -> dict:
    record = _anthropic_record(request_id)
    record["request"]["path"] = "/backend-api/codex/responses"
    record["request"]["headers"] = {"host": "chatgpt.com"}
    record["upstream_base_url"] = "https://chatgpt.com/backend-api/codex"
    record.update(overrides)
    return record


def test_subscription_traffic_is_flagged_instead_of_priced() -> None:
    # Those tokens are covered by a ChatGPT plan, so a dollar figure derived from
    # OpenAI Platform rates was never charged. The flag travels so the viewer can
    # say why the turn carries no cost rather than implying an unknown price.
    meta = _extract_metadata_from_record(_codex_record())

    assert meta is not None
    assert meta["subscription"] is True
    assert "cost" not in meta

    index = _build_cost_index([_codex_record()])
    assert index == {"req_codex": {"subscription": True}}

    attached = attach_cost_to_record(_codex_record())
    assert attached["_cost_index"] == {"req_codex": {"subscription": True}}


def test_subscription_traffic_is_recognised_from_the_connect_host_alone() -> None:
    # A forward-proxy capture records no upstream, so the CONNECT host plus the
    # Codex route on it is what identifies the subscription upstream.
    record = _codex_record("req_fwd")
    record.pop("upstream_base_url")

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["subscription"] is True


def test_code_assist_quota_traffic_is_flagged_instead_of_priced() -> None:
    """Gemini CLI's default OAuth flow answers from a Code Assist account quota.

    Its usage block carries real token counts, so pricing it at Gemini API rates
    produces a charge the user never incurred. The reverse-mode capture names the
    local listener as the host, so the `/v1internal:` route has to identify the
    quota upstream on its own.
    """
    for request_id, host, upstream in (
        ("req_ca_fwd", "cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"),
        ("req_ca_daily", "daily-cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"),
        ("req_ca_local", "127.0.0.1:19527", ""),
    ):
        record = _anthropic_record(request_id)
        record["request"]["path"] = "/v1internal:streamGenerateContent?alt=sse"
        record["request"]["headers"] = {"Host": host}
        record["upstream_base_url"] = upstream

        meta = _extract_metadata_from_record(record)
        assert meta is not None, request_id
        assert meta["subscription"] is True, request_id
        assert "cost" not in meta, request_id


def test_api_key_gemini_traffic_is_still_priced() -> None:
    """The Code Assist host is what separates quota from billed usage.

    An API key against generativelanguage.googleapis.com is billed per token, so
    classifying Gemini by model name would zero out real charges.
    """
    for host in ("generativelanguage.googleapis.com", "us-central1-aiplatform.googleapis.com"):
        record = _anthropic_record("req_gemini_billed")
        record["request"]["path"] = "/v1beta/models/gemini-3-flash-preview:streamGenerateContent"
        record["request"]["headers"] = {"Host": host}
        record["upstream_base_url"] = f"https://{host}"

        meta = _extract_metadata_from_record(record)
        assert meta is not None, host
        assert "subscription" not in meta, host
        assert meta["cost"] > 0, host


def test_other_openai_traffic_on_the_same_host_is_still_priced() -> None:
    record = _anthropic_record("req_api")
    record["request"]["headers"] = {"host": "api.openai.com"}
    record["upstream_base_url"] = "https://api.openai.com"

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert "subscription" not in meta
    assert meta["cost"] > 0


def test_openrouter_record_uses_openrouter_rates_not_the_direct_provider() -> None:
    # The request model is the shared DeepSeek id. Looking it up without the
    # captured OpenRouter host would bill DeepSeek's 2.8e-7 input rate.
    record = {
        "timestamp": "2026-08-19T10:00:00+00:00",
        "request_id": "req_or",
        "turn": 1,
        "duration_ms": 10,
        "upstream_base_url": "https://openrouter.ai/api/v1",
        "request": {
            "method": "POST",
            "path": "/api/v1/chat/completions",
            "headers": {"host": "openrouter.ai"},
            "body": {"model": "deepseek/deepseek-chat", "messages": []},
        },
        "response": {
            "status": 200,
            "headers": {},
            "body": {
                "model": "deepseek/deepseek-chat",
                "usage": {"prompt_tokens": 100, "completion_tokens": 0},
            },
        },
    }

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["priced_model"] == "openrouter/deepseek/deepseek-chat"
    assert meta["cost"] == pytest.approx(100 * 1.4e-07)
    assert meta["cost"] != pytest.approx(100 * 2.8e-07)


def test_gemini_developer_api_record_uses_the_gemini_namespace() -> None:
    record = {
        "timestamp": "2026-08-19T10:00:00+00:00",
        "request_id": "req_gemini",
        "turn": 1,
        "duration_ms": 10,
        "upstream_base_url": "https://generativelanguage.googleapis.com",
        "request": {
            "method": "POST",
            "path": "/v1beta/models/gemini-2.0-flash-001:generateContent",
            "headers": {"host": "generativelanguage.googleapis.com"},
            "body": {},
        },
        "response": {
            "status": 200,
            "headers": {},
            "body": {"usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 0}},
        },
    }

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["priced_model"] == "gemini/gemini-2.0-flash-001"
    assert meta["cost"] == pytest.approx(100 * 1e-07)
    assert meta["cost"] != pytest.approx(100 * 1.5e-07)


def test_websocket_usage_sum_survives_non_finite_token_counts() -> None:
    # normalize_usage copies a direct token field through; summing with int()
    # would raise OverflowError on inf (from 1e309) and abort viewer generation.
    record = _ws_record()
    events = record["response"]["ws_events"]
    events[1]["response"]["usage"]["input_tokens"] = float("inf")

    meta = _extract_metadata_from_record(record)
    assert meta is not None
    assert meta["input_tokens"] == 2_000
    assert meta["output_tokens"] == 20
    second = 2_000 * 3e-06 + 10 * 1.5e-05
    first_output_only = 10 * 1.5e-05
    assert meta["cost"] == pytest.approx(first_output_only + second)

    events[1]["response"]["usage"]["input_tokens"] = 10**400
    huge = _extract_metadata_from_record(record)
    assert huge is not None
    assert huge["input_tokens"] == 2_000


def test_web_search_calls_are_counted_once_across_output_and_events() -> None:
    output = [{"type": "web_search_call", "status": "completed"}]
    events = [
        {
            "event": "response.output_item.done",
            "data": {"item": {"type": "web_search_call", "status": "completed"}},
        }
    ]
    assert _completed_web_search_calls(output=output, events=events) == 1
    assert _completed_web_search_calls(output=None, events=events) == 1
    assert _completed_web_search_calls(output=output, events=None) == 1


def test_an_unpriceable_record_is_handed_over_untouched() -> None:
    record = _anthropic_record()
    record["request"]["body"]["model"] = "some-unlisted-gateway-model"
    record["response"]["body"]["model"] = "some-unlisted-gateway-model"

    attached = attach_cost_to_record(record)
    assert "_cost_index" not in attached
    assert attach_cost_to_record("not a dict") == "not a dict"  # type: ignore[arg-type]
