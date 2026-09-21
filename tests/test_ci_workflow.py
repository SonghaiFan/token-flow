"""Regression tests for the CI workflow's dependency and browser-cache contract.

The Playwright browser cache used to miss on every run, making one step take
20 minutes at the median and over two hours at the worst. Two independent
defects caused it, and both are cheap to assert on statically:

1. The cache key hashed `uv.lock` while pip installed from `pyproject.toml`,
   where playwright was declared in a PEP 735 `[dependency-groups]` table that
   pip cannot read. pip therefore resolved an unpinned latest playwright whose
   browser revision was never the one in the restored cache.
2. `restore-keys` let a stale prefix satisfy the restore, while the unchanging
   primary key still counted as a hit and suppressed the post-step save, so the
   cache could never converge on the revision actually in use.
"""

from __future__ import annotations

import ast
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ci.yml"
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"
TESTS_DIR = Path(__file__).resolve().parent


def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def _pyproject() -> dict:
    return tomllib.loads(PYPROJECT_PATH.read_text(encoding="utf-8"))


def test_playwright_is_pinned_where_pip_can_read_it() -> None:
    """pip only reads [project.optional-dependencies], never PEP 735 groups."""
    dev_extra = _pyproject()["project"]["optional-dependencies"]["dev"]
    pins = [spec for spec in dev_extra if spec.replace("-", "_").startswith("playwright")]

    assert pins, "playwright must live in the dev extra so `pip install -e '.[dev]'` resolves it"
    assert pins == ["playwright==1.58.0"], (
        "playwright must stay exactly pinned: the browser cache key hashes pyproject.toml, "
        "and a floating spec would install a version whose browser revision is not cached"
    )


def test_dependency_group_does_not_redeclare_dev_tooling() -> None:
    """The uv group aliases the extra so both installers agree on one list."""
    assert _pyproject()["dependency-groups"]["dev"] == ["claude-tap[dev]"]


def test_browser_cache_key_hashes_the_file_that_pins_playwright() -> None:
    workflow = _workflow_text()

    assert "${{ runner.os }}-playwright-${{ hashFiles('pyproject.toml') }}" in workflow
    assert "${{ runner.os }}-playwright-${{ hashFiles('uv.lock') }}" not in workflow


def test_browser_cache_has_no_prefix_fallback() -> None:
    """A prefix hit restores a directory missing the current browser revision."""
    workflow = _workflow_text()

    # Match the YAML key, not prose: the workflow comments explain the pitfall.
    assert "restore-keys:" not in workflow


def test_browser_download_is_skipped_on_a_cache_hit() -> None:
    workflow = _workflow_text()

    assert "steps.playwright-cache.outputs.cache-hit != 'true'" in workflow
    assert "python -m playwright install chromium" in workflow
    # System libraries live outside the cached path, so they install every run.
    assert "python -m playwright install-deps chromium" in workflow
    assert "playwright install --with-deps chromium" not in workflow


def test_coverage_job_does_not_reinstall_playwright_outside_the_pin() -> None:
    """`pip install ... playwright` next to the extra would defeat the pin."""
    workflow = _workflow_text()

    assert 'pip install -e ".[dev]" playwright' not in workflow


def _test_files_launching_a_browser() -> list[Path]:
    """Return test files that start chromium, found by call rather than by name.

    `launch`/`launch_persistent_context` on a browser type is the only way these
    tests reach the binary, so matching that attribute finds every such file
    without depending on how each one imports or aliases playwright.
    """
    launching = []
    for path in sorted(TESTS_DIR.glob("test_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("launch", "launch_persistent_context")
            ):
                launching.append(path)
                break
    return launching


def test_every_browser_test_file_checks_for_the_browser_not_just_the_package() -> None:
    """The package and the chromium binary install separately.

    Once playwright moved into the dev extra, guards that only caught ImportError
    stopped skipping — the import succeeded on a runner with no browser and the
    tests hard-failed instead. Every file that launches chromium has to consult
    the shared guard, which probes the executable itself.
    """
    unguarded = [
        path.name
        for path in _test_files_launching_a_browser()
        if "playwright_skip_reason" not in path.read_text(encoding="utf-8")
    ]

    assert unguarded == [], f"these files launch chromium without the browser guard: {unguarded}"


def test_the_browser_guard_is_wired_to_every_launching_file() -> None:
    """Guard the discovery itself: an empty match would make the test above vacuous."""
    launching = {path.name for path in _test_files_launching_a_browser()}

    assert "test_bedrock_viewer.py" in launching
    assert "test_dashboard.py" in launching
    assert len(launching) >= 10
