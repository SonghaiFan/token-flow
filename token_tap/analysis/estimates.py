"""Local token-count estimates for prompt blocks the provider did not count.

Providers report measured totals; only some report per-block counts. For the
rest, the dashboard sizes blocks with tiktoken's ``o200k_base`` encoding and
scales the result to the measured total, so an estimate never changes a total.
Counts run locally; tiktoken downloads its encoding file once and caches it.
"""

from __future__ import annotations

import hashlib
import threading

ESTIMATE_ENCODING = "o200k_base"
MAX_ESTIMATE_TEXTS = 5000
MAX_ESTIMATE_CHARS = 20_000_000

_encoding_lock = threading.Lock()
_encoding = None
# Counts by text digest; harnesses resend the same blocks every turn.
_counts: dict[str, int] = {}
_MAX_CACHED_COUNTS = 50_000


class EstimatesUnavailable(RuntimeError):
    """tiktoken or its encoding file is not available."""


def _get_encoding():
    global _encoding
    with _encoding_lock:
        if _encoding is None:
            try:
                import tiktoken

                _encoding = tiktoken.get_encoding(ESTIMATE_ENCODING)
            except Exception as exc:  # missing package or offline first download
                raise EstimatesUnavailable(
                    f"Token estimates need tiktoken's {ESTIMATE_ENCODING} encoding: {exc}"
                ) from exc
        return _encoding


def estimate_token_counts(texts: list[str]) -> list[int]:
    """Return one estimated token count per text, in order."""
    encoding = _get_encoding()
    counts = []
    for text in texts:
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        count = _counts.get(digest)
        if count is None:
            count = len(encoding.encode(text, disallowed_special=()))
            if len(_counts) >= _MAX_CACHED_COUNTS:
                _counts.clear()
            _counts[digest] = count
        counts.append(count)
    return counts
