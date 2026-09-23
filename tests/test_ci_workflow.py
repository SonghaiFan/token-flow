"""Static checks for Token Flow's small, product-focused CI contract."""

from __future__ import annotations

import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ci.yml"
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"


def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def _pyproject() -> dict:
    return tomllib.loads(PYPROJECT_PATH.read_text(encoding="utf-8"))


def test_package_and_cli_use_token_flow_identity() -> None:
    project = _pyproject()["project"]

    assert project["name"] == "token-flow"
    assert project["scripts"] == {"token-flow": "token_tap.commands.cli:main_entry"}
    assert _pyproject()["dependency-groups"]["dev"] == ["token-flow[dev]"]


def test_ci_checks_python_and_vite_ui() -> None:
    workflow = _workflow_text()

    assert "ruff check ." in workflow
    assert "python -m pytest tests/ -x --timeout=60" in workflow
    assert "working-directory: ui" in workflow
    assert "npm ci" in workflow
    assert "npm run lint" in workflow
    assert "npm run build" in workflow


def test_ci_has_no_upstream_release_or_evidence_policy() -> None:
    workflow = _workflow_text()

    assert "check_pr_policy" not in workflow
    assert "check_screenshots" not in workflow
    assert "publish" not in workflow
    assert "claude-tap" not in workflow
