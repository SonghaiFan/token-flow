"""Cost and usage analysis for captured model records."""

from __future__ import annotations

import json

from token_tap.analysis.pricing import (
    _int,
    _search_cost_per_query,
    entry_cost,
    is_priced_model,
    model_from_path,
    provider_namespace,
)

# These upstreams are billed through a subscription or account quota rather
# than per token, so published API rates are not a user cost.
_SUBSCRIPTION_UPSTREAMS = ("chatgpt.com/backend-api/codex", "cloudcode-pa.googleapis.com")
_SUBSCRIPTION_ROUTES = ("/v1internal:", "/v1internal/")


def _dict_or_empty(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _event_type(event: dict) -> str:
    if not isinstance(event, dict):
        return ""
    value = event.get("event") or event.get("type")
    return value if isinstance(value, str) else ""


def _event_payload(event: dict) -> dict | None:
    if not isinstance(event, dict):
        return None
    payload = event.get("data", event)
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return None
    return payload if isinstance(payload, dict) else None


def _model_from_path(path: object) -> str:
    """Extract a model id from a request path.

    Delegates to the pricing adapter so both sides read one parser: a Bedrock id
    keeps its ``-v1:0`` version suffix (and is percent-decoded) while a Vertex
    path still drops the method after the colon.
    """
    if not isinstance(path, str):
        return ""
    return model_from_path(path)


def _first_priced_model(*candidates: object, provider: str = "", billed: object = None) -> str:
    """Return the first candidate the price table knows, else the first non-empty.

    A gateway names its own deployment alias in the request body while the
    response reports the model actually billed. Taking the first non-empty string
    leaves such a turn unpriced even though the table can price the response
    model, so the table gets consulted before the order is settled. The first
    non-empty name is still what gets displayed when none of them is priceable,
    since that is what the request asked for.

    `billed` names the model the response says was charged. It wins whenever the
    table can price it, because a deployment alias may also be a table key at a
    different rate: an Azure deployment called `gpt-4o` answering as
    `gpt-4o-2024-11-20` would otherwise bill at the undated entry's 2.5/10 rather
    than the dated 2.75/11, understating the turn by 10%.
    """
    billed_name = billed if isinstance(billed, str) and billed else ""
    if billed_name and is_priced_model(billed_name, provider=provider):
        return billed_name
    names = [value for value in candidates if isinstance(value, str) and value]
    for name in names:
        if is_priced_model(name, provider=provider):
            return name
    if billed_name:
        names.append(billed_name)
    return names[0] if names else ""


def _cache_ttl_1h(body: dict) -> bool:
    """Return True when the request asks for Anthropic's 1-hour cache TTL.

    A 1-hour cache write is billed above the default 5-minute rate, so the
    request's own cache_control breakpoints decide which write rate applies.
    """

    def _scan(value: object, depth: int = 0) -> bool:
        if depth > 6:
            return False
        if isinstance(value, dict):
            control = value.get("cache_control")
            if isinstance(control, dict) and control.get("ttl") == "1h":
                return True
            return any(_scan(item, depth + 1) for item in value.values())
        if isinstance(value, list):
            return any(_scan(item, depth + 1) for item in value)
        return False

    return _scan(body)


def _is_subscription_traffic(record: object) -> bool:
    """Return True when the record's upstream bills by subscription, not by token.

    Checked against the recorded upstream and the request Host together: reverse
    mode records the target it forwarded to, while forward-proxy mode identifies
    the destination only by the CONNECT host.
    """
    if not isinstance(record, dict):
        return False
    req = _dict_or_empty(record.get("request"))
    headers = req.get("headers")
    host = ""
    if isinstance(headers, dict):
        for key in ("Host", "host", ":authority"):
            value = headers.get(key)
            if isinstance(value, str) and value:
                host = value
                break
    signal = " ".join(
        part
        for part in (
            str(record.get("upstream_base_url") or ""),
            host,
            str(req.get("path") or ""),
        )
        if part
    ).lower()
    if not signal:
        return False
    if any(upstream in signal for upstream in _SUBSCRIPTION_UPSTREAMS):
        return True
    if any(route in signal for route in _SUBSCRIPTION_ROUTES):
        return True
    # A forward-proxy capture names only the host, so the Codex route on that
    # host is what identifies the subscription upstream.
    return "chatgpt.com" in signal and "/backend-api/codex" in signal


def _completed_web_search_calls_in_output(output: object) -> int:
    if not isinstance(output, list):
        return 0
    return sum(
        1
        for item in output
        if isinstance(item, dict)
        and item.get("type") == "web_search_call"
        and item.get("status") in (None, "completed")
    )


def _completed_web_search_calls_in_events(events: object) -> int:
    if not isinstance(events, list):
        return 0
    count = 0
    for event in events:
        if _event_type(event) != "response.output_item.done":
            continue
        payload = _event_payload(event)
        item = payload.get("item") if isinstance(payload, dict) else None
        if (
            isinstance(item, dict)
            and item.get("type") == "web_search_call"
            and item.get("status") in (None, "completed")
        ):
            count += 1
    return count


def _completed_web_search_calls(*, output: object = None, events: object = None) -> int:
    """Count completed web_search_call items once.

    The same call is typically present in both the final ``output`` array and
    the ``response.output_item.done`` stream. Adding those counts would apply
    the per-query surcharge twice.
    """
    return max(
        _completed_web_search_calls_in_output(output),
        _completed_web_search_calls_in_events(events),
    )


def _cost_fields(model: str, usage: dict, body: dict, *, record: object = None, search_calls: int = 0) -> dict:
    """Return per-entry cost fields, or an empty dict when no cost applies.

    Cost lives here rather than in the viewer so a single price table and a
    single set of tier rules serve every output path.

    Subscription traffic is deliberately left unpriced. The price table can put a
    number on those tokens, but it is a counterfactual "what the API would have
    charged", not money the user was billed, and presenting it beside real
    per-token costs in one total would misstate what the session cost. The
    ``subscription`` flag travels instead so the viewer can say why the turn
    carries no figure rather than implying the model has no known price.
    """
    if _is_subscription_traffic(record):
        return {"subscription": True}
    priced = entry_cost(
        model,
        usage,
        cache_ttl_1h=_cache_ttl_1h(body),
        provider=provider_namespace(record),
        search_calls=search_calls,
    )
    if priced is None:
        return {}
    return {
        "cost": priced.cost,
        "uncached_cost": priced.uncached_cost,
        "saved": priced.saved,
        "priced_model": priced.model,
        "long_context": priced.long_context,
    }


def _sum_usage(usages: list[dict]) -> dict:
    """Return the summed token buckets for several responses in one record.

    Only the buckets the sidebar reports are summed. ``cache_read_in_input`` is a
    shape flag rather than a count, so it is carried from the first response that
    states it — every response in one record comes from the same provider.

    Counts go through :func:`token_tap.analysis.pricing._int` so a non-finite or
    oversize value in one response cannot abort viewer generation.
    """
    totals: dict[str, object] = {}
    for key in (
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "total_tokens",
    ):
        summed = sum(_int(usage.get(key)) for usage in usages)
        if summed:
            totals[key] = summed
    for usage in usages:
        if "cache_read_in_input" in usage:
            totals["cache_read_in_input"] = usage["cache_read_in_input"]
            break
    return totals


def _aggregate_cost_fields(
    models: list[str],
    usages: list[dict],
    body: dict,
    *,
    record: object = None,
    search_calls: int = 0,
) -> dict:
    """Return cost fields covering every response in a multi-response record.

    Each response is priced on its own — the long-context tier is selected by one
    prompt's size, so pricing the summed tokens would push short responses into a
    tier they never hit — and the resulting figures are then added.

    Returns an empty dict when any response is unpriceable, matching
    :func:`token_tap.analysis.pricing.entry_cost`: a total that silently omits some of the
    responses in a record would still be displayed as if it covered all of them.
    """
    if not usages:
        return {}
    if _is_subscription_traffic(record):
        return {"subscription": True}
    ttl_1h = _cache_ttl_1h(body)
    provider = provider_namespace(record)
    total = 0.0
    total_uncached = 0.0
    total_saved = 0.0
    long_context = False
    priced_model = ""
    for model, usage in zip(models, usages):
        priced = entry_cost(model, usage, cache_ttl_1h=ttl_1h, provider=provider)
        if priced is None:
            return {}
        total += priced.cost
        total_uncached += priced.uncached_cost
        total_saved += priced.saved
        long_context = long_context or priced.long_context
        priced_model = priced_model or priced.model
    if search_calls:
        search_rate = _search_cost_per_query(priced_model or models[0], provider)
        if search_rate is None:
            return {}
        search_total = search_calls * search_rate
        total += search_total
        total_uncached += search_total
    return {
        "cost": total,
        "uncached_cost": total_uncached,
        "saved": total_saved,
        "priced_model": priced_model,
        "long_context": long_context,
    }
