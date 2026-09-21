"""Tests for the GitHub-native star-history chart updater."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from scripts.check_screenshots import analyze_file
from scripts.update_star_history import fetch_stargazer_timestamps, render_charts


def test_fetch_stargazer_timestamps_paginates_and_authenticates():
    requests = []
    first_page = {
        "data": {
            "repository": {
                "stargazers": {
                    "edges": [{"starredAt": "2026-01-01T00:00:00Z"}],
                    "pageInfo": {"hasNextPage": True, "endCursor": "next-page"},
                }
            }
        }
    }
    second_page = {
        "data": {
            "repository": {
                "stargazers": {
                    "edges": [{"starredAt": "2026-01-03T00:00:00Z"}],
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                }
            }
        }
    }

    def request_json(request):
        requests.append(request)
        cursor = json.loads(request.data)["variables"]["cursor"]
        return first_page if cursor is None else second_page

    timestamps = fetch_stargazer_timestamps(
        "liaohch3/claude-tap",
        token="test-token",
        request_json=request_json,
    )

    assert len(timestamps) == 2
    assert timestamps[0] == datetime(2026, 1, 1, tzinfo=UTC)
    assert timestamps[-1] == datetime(2026, 1, 3, tzinfo=UTC)
    assert [json.loads(request.data)["variables"]["cursor"] for request in requests] == [
        None,
        "next-page",
    ]
    assert all(request.full_url == "https://api.github.com/graphql" for request in requests)
    assert requests[0].headers["Authorization"] == "Bearer test-token"
    assert requests[0].headers["Content-type"] == "application/json"


def test_fetch_stargazer_timestamps_rejects_malformed_payload():
    with pytest.raises(RuntimeError, match="omitted starredAt"):
        fetch_stargazer_timestamps(
            "liaohch3/claude-tap",
            token="test-token",
            request_json=lambda _request: {
                "data": {
                    "repository": {
                        "stargazers": {
                            "edges": [{"node": {"login": "example"}}],
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                        }
                    }
                }
            },
        )


@pytest.mark.parametrize("repo", ["claude-tap", "owner/repo/extra", "../repo"])
def test_fetch_stargazer_timestamps_rejects_invalid_repo(repo):
    with pytest.raises(ValueError, match="OWNER/REPO"):
        fetch_stargazer_timestamps(repo, token="test-token", request_json=lambda _request: {})


def test_fetch_stargazer_timestamps_requires_token():
    with pytest.raises(RuntimeError, match="GITHUB_TOKEN is required"):
        fetch_stargazer_timestamps("liaohch3/claude-tap", token=None)


def test_render_charts_persists_valid_light_and_dark_pngs(tmp_path, monkeypatch):
    def reject_duplicate_title(*_args, **_kwargs):
        raise AssertionError("the README section already provides the chart title")

    monkeypatch.setattr("matplotlib.axes.Axes.set_title", reject_duplicate_title)
    timestamps = [
        datetime(2025, 1, 1, tzinfo=UTC),
        datetime(2025, 6, 1, tzinfo=UTC),
        datetime(2026, 1, 1, tzinfo=UTC),
    ]

    render_charts("liaohch3/claude-tap", timestamps, tmp_path)

    light = tmp_path / "star-history-light.png"
    dark = tmp_path / "star-history-dark.png"
    for chart in (light, dark):
        result = analyze_file(chart)
        assert result.status == "PASS", result.failures + result.warnings
        assert result.info is not None
        assert (result.info.width, result.info.height) == (1600, 900)
        assert chart.stat().st_size > 10_000
    assert light.read_bytes() != dark.read_bytes()


def test_star_history_workflow_publishes_to_asset_branch():
    workflow = (Path(__file__).resolve().parent.parent / ".github" / "workflows" / "star-history.yml").read_text()

    assert 'cron: "0 19 * * *"' in workflow
    assert workflow.count("contents: read") == 1
    assert workflow.count("contents: write") == 1
    assert "needs: generate" in workflow
    assert "ref: star-history-assets" in workflow
    assert "scripts/update_star_history.py" in workflow
    assert "scripts/check_screenshots.py" in workflow
    assert "matplotlib==3.11.1" in workflow
    assert "secrets.RELEASE_BOT_TOKEN" not in workflow
    assert "GITHUB_TOKEN: ${{ github.token }}" in workflow
    assert "actions/upload-artifact@v4" in workflow
    assert "actions/download-artifact@v4" in workflow
    assert workflow.index("contents: read") < workflow.index("matplotlib==3.11.1")
    assert workflow.index("contents: write") > workflow.index("matplotlib==3.11.1")
    assert "timeout-minutes: 10" in workflow
    assert "git diff --cached --quiet" in workflow
    assert workflow.index("git add star-history-light.png") < workflow.index("git diff --cached --quiet")
    assert "git push" in workflow
