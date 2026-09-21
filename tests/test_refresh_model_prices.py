"""Snapshot provenance for the vendored price table.

A cost figure quoted from a generated viewer is only reproducible if the exact
upstream table can be fetched again, and ``main`` moves several times a day, so
the refresh script has to pin the commit it read.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "refresh_model_prices", REPO_ROOT / "scripts" / "refresh_model_prices.py"
)
assert _SPEC and _SPEC.loader
refresh = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(refresh)

COMMIT = "24fc3f721c4086a0ab8318f15a005309a8a55512"


def _upstream() -> dict[str, object]:
    return {
        "keeper": {
            "mode": "chat",
            "litellm_provider": "anthropic",
            "input_cost_per_token": 3e-06,
            "output_cost_per_token": 1.5e-05,
            "supports_vision": True,
        },
        "embedding-model": {"mode": "embedding", "litellm_provider": "openai"},
        "unproxyable": {"mode": "chat", "litellm_provider": "some-local-runtime"},
    }


def test_pinned_url_points_at_an_immutable_revision() -> None:
    url = refresh.pinned_url(COMMIT)

    assert url == (f"https://raw.githubusercontent.com/BerriAI/litellm/{COMMIT}/model_prices_and_context_window.json")
    assert "/main/" not in url


def test_pruning_keeps_only_capturable_chat_models_and_read_fields() -> None:
    pruned = refresh.prune(_upstream())

    assert list(pruned) == ["keeper"]
    assert "supports_vision" not in pruned["keeper"]


def test_the_written_snapshot_records_the_commit_it_came_from(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "upstream.json"
    source.write_text(json.dumps(_upstream()), encoding="utf-8")
    output = tmp_path / "model_prices.json"
    monkeypatch.setattr(refresh, "OUTPUT_PATH", output)

    assert refresh.main(["--from", str(source), "--upstream-commit", COMMIT]) == 0

    meta = json.loads(output.read_text(encoding="utf-8"))["__meta__"]
    assert meta["upstream_commit"] == COMMIT
    assert meta["source_url"] == refresh.pinned_url(COMMIT)
    assert meta["model_count"] == 1


def test_a_commit_is_required_and_validated(tmp_path: Path, monkeypatch, capsys) -> None:
    source = tmp_path / "upstream.json"
    source.write_text(json.dumps(_upstream()), encoding="utf-8")
    monkeypatch.setattr(refresh, "OUTPUT_PATH", tmp_path / "out.json")

    # A branch name would leave the snapshot unpinned, so it is rejected here
    # rather than silently recorded as if it identified a revision.
    assert refresh.main(["--from", str(source), "--upstream-commit", "main"]) == 1
    assert "not a commit sha" in capsys.readouterr().err

    with pytest.raises(SystemExit):
        refresh.main(["--from", str(source)])
