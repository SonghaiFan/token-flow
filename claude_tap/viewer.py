"""Legacy self-contained HTML viewer generation."""

# ruff: noqa: F401

from __future__ import annotations

import json
from importlib.metadata import version as _pkg_version
from pathlib import Path

from claude_tap.analysis import costs as _cost_analysis
from claude_tap.analysis import records as _record_analysis
from claude_tap.analysis.records import _build_cost_index, _extract_metadata, _normalize_record_for_viewer
from claude_tap.compact_trace import (
    COMPACT_TRACE_MARKER,
    build_compact_trace_bundle,
    is_compact_trace_bundle,
    materialize_compact_trace_bundle,
)
from claude_tap.pricing import pricing_metadata

try:
    CLAUDE_TAP_VERSION = _pkg_version("token-flow")
except Exception:
    CLAUDE_TAP_VERSION = "0.0.0"

LAZY_THRESHOLD = 50
VIEWER_TEMPLATE_PATH = Path(__file__).parent / "viewer.html"
VIEWER_ASSETS_DIR = Path(__file__).parent / "viewer_assets"
VIEWER_CSS_PATH = VIEWER_ASSETS_DIR / "viewer.css"
VIEWER_JS_PATHS = (
    VIEWER_ASSETS_DIR / "token_flow_d3_layouts.min.js",
    VIEWER_ASSETS_DIR / "state.js",
    VIEWER_ASSETS_DIR / "responses.js",
    VIEWER_ASSETS_DIR / "lazy_loading.js",
    VIEWER_ASSETS_DIR / "i18n_ui.js",
    VIEWER_ASSETS_DIR / "live_bootstrap.js",
    VIEWER_ASSETS_DIR / "filters_search.js",
    VIEWER_ASSETS_DIR / "sidebar.js",
    VIEWER_ASSETS_DIR / "detail_trace.js",
    VIEWER_ASSETS_DIR / "renderers.js",
    VIEWER_ASSETS_DIR / "sections_json.js",
    VIEWER_ASSETS_DIR / "diff.js",
    VIEWER_ASSETS_DIR / "utilities_mobile.js",
)
VIEWER_I18N_PATH = Path(__file__).parent / "viewer_i18n.json"
VIEWER_STYLE_TEMPLATE_ANCHOR = "<!-- CLAUDE_TAP_VIEWER_STYLE -->"
VIEWER_SCRIPT_TEMPLATE_ANCHOR = "<!-- CLAUDE_TAP_VIEWER_SCRIPT -->"
VIEWER_SCRIPT_ANCHOR = "<script>\nconst $ = s =>"


def __getattr__(name: str):
    """Keep legacy analysis-helper imports working during the migration."""
    if name in _record_analysis.__all__ or name == "attach_cost_to_record":
        return getattr(_record_analysis, name)
    if name.startswith("_") and hasattr(_cost_analysis, name):
        return getattr(_cost_analysis, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(
        {
            *globals(),
            *_record_analysis.__all__,
            "attach_cost_to_record",
            *(name for name in vars(_cost_analysis) if name.startswith("_") and not name.startswith("__")),
        }
    )


def _load_viewer_i18n() -> dict[str, dict[str, str]]:
    data = json.loads(VIEWER_I18N_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("viewer_i18n.json must contain a JSON object.")
    for lang, entries in data.items():
        if not isinstance(lang, str) or not isinstance(entries, dict):
            raise ValueError("viewer_i18n.json must map language codes to string maps.")
        if not all(isinstance(key, str) and isinstance(value, str) for key, value in entries.items()):
            raise ValueError("viewer_i18n.json language maps must contain string keys and values.")
    return data


def _viewer_i18n_script() -> str:
    payload = json.dumps(_load_viewer_i18n(), ensure_ascii=False, separators=(",", ":"))
    return f"const __CLAUDE_TAP_I18N__ = {payload};\n"


def _read_viewer_template() -> str:
    html = VIEWER_TEMPLATE_PATH.read_text(encoding="utf-8")
    if VIEWER_STYLE_TEMPLATE_ANCHOR not in html:
        raise ValueError("viewer.html is missing the style asset anchor.")
    if VIEWER_SCRIPT_TEMPLATE_ANCHOR not in html:
        raise ValueError("viewer.html is missing the script asset anchor.")
    css = VIEWER_CSS_PATH.read_text(encoding="utf-8").rstrip()
    vendor_js = VIEWER_JS_PATHS[0].read_text(encoding="utf-8").rstrip()
    js = "".join(path.read_text(encoding="utf-8") for path in VIEWER_JS_PATHS[1:]).rstrip()
    html = html.replace(VIEWER_STYLE_TEMPLATE_ANCHOR, f"<style>\n{css}\n</style>", 1)
    html = html.replace(
        VIEWER_SCRIPT_TEMPLATE_ANCHOR,
        f"<script>\n{_viewer_i18n_script()}</script>\n<script>\n{vendor_js}\n</script>\n<script>\n{js}\n</script>",
        1,
    )
    if VIEWER_SCRIPT_ANCHOR not in html:
        raise ValueError("viewer asset script is missing the main script anchor.")
    return html


def _pricing_data_js(cost_index: dict[str, dict]) -> str:
    """Return the JS consts carrying precomputed cost and price provenance.

    The viewer formats and sums these; it never holds a price table of its own.
    """
    index_js = json.dumps(cost_index, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    meta_js = json.dumps(pricing_metadata(), ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return f"const EMBEDDED_COST_INDEX = {index_js};\nconst EMBEDDED_PRICING_META = {meta_js};\n"


def _generate_html_viewer(
    trace_path: Path,
    html_path: Path,
    *,
    display_trace_path: str | Path | None = None,
    display_html_path: str | Path | None = None,
) -> None:
    """Read viewer.html template, embed JSONL data, write self-contained HTML."""
    if trace_path.exists():
        text = trace_path.read_text(encoding="utf-8")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if is_compact_trace_bundle(parsed):
            _generate_html_viewer_from_compact_bundle(
                parsed,
                html_path,
                display_trace_path=display_trace_path if display_trace_path is not None else trace_path.absolute(),
                display_html_path=display_html_path if display_html_path is not None else html_path.absolute(),
            )
            return

    records: list[dict] = []
    if trace_path.exists():
        with open(trace_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        record = json.loads(_normalize_record_for_viewer(line))
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict):
                        records.append(record)
    _generate_html_viewer_from_compact_bundle(
        build_compact_trace_bundle(records),
        html_path,
        display_trace_path=display_trace_path if display_trace_path is not None else trace_path.absolute(),
        display_html_path=display_html_path if display_html_path is not None else html_path.absolute(),
    )


def _generate_html_viewer_from_compact_bundle(
    compact_bundle: dict,
    html_path: Path,
    *,
    display_trace_path: str | Path,
    display_html_path: str | Path,
) -> None:
    """Write a self-contained HTML viewer that embeds compact trace data."""
    if not VIEWER_TEMPLATE_PATH.exists():
        return
    if not is_compact_trace_bundle(compact_bundle):
        raise ValueError(f"Expected {COMPACT_TRACE_MARKER} compact trace bundle.")

    trace_path_label = str(display_trace_path)
    html_path_label = str(display_html_path)
    compact_js = json.dumps(compact_bundle, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    jsonl_path_js = json.dumps(trace_path_label)
    html_path_js = json.dumps(html_path_label)
    version_js = json.dumps(CLAUDE_TAP_VERSION)
    try:
        cost_index = _build_cost_index(materialize_compact_trace_bundle(compact_bundle))
    except ValueError:
        cost_index = {}
    data_js = (
        f"const EMBEDDED_TRACE_COMPACT_DATA = {compact_js};\n"
        f"const __TRACE_JSONL_PATH__ = {jsonl_path_js};\n"
        f"const __TRACE_HTML_PATH__ = {html_path_js};\n"
        f"const __CLAUDE_TAP_VERSION__ = {version_js};\n"
        f"{_pricing_data_js(cost_index)}"
    )

    html = _read_viewer_template()
    html = html.replace(
        VIEWER_SCRIPT_ANCHOR,
        f"<script>\n{data_js}</script>\n{VIEWER_SCRIPT_ANCHOR}",
        1,
    )
    html_path.write_text(html, encoding="utf-8")


def _generate_html_viewer_from_metadata(
    metadata: list[dict],
    html_path: Path,
    *,
    display_trace_path: str | Path,
    display_html_path: str | Path,
    records_api_path: str | Path,
) -> None:
    """Write an online viewer that fetches full records on demand."""
    if not VIEWER_TEMPLATE_PATH.exists():
        return

    trace_path_label = str(display_trace_path)
    html_path_label = str(display_html_path)
    records_api_label = str(records_api_path)
    meta_js = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    jsonl_path_js = json.dumps(trace_path_label)
    html_path_js = json.dumps(html_path_label)
    records_api_js = json.dumps(records_api_label)
    version_js = json.dumps(CLAUDE_TAP_VERSION)
    data_js = (
        f"const EMBEDDED_TRACE_META = {meta_js};\n"
        f"const __TRACE_JSONL_PATH__ = {jsonl_path_js};\n"
        f"const __TRACE_HTML_PATH__ = {html_path_js};\n"
        f"const __TRACE_RECORDS_API__ = {records_api_js};\n"
        f"const __CLAUDE_TAP_VERSION__ = {version_js};\n"
        # Cost already rides on each metadata record, so only provenance is added.
        f"{_pricing_data_js({})}"
    )

    html = _read_viewer_template()
    html = html.replace(
        VIEWER_SCRIPT_ANCHOR,
        f"<script>\n{data_js}</script>\n{VIEWER_SCRIPT_ANCHOR}",
        1,
    )
    html_path.write_text(html, encoding="utf-8")


def _generate_html_viewer_from_records(
    record_json_lines: list[str],
    html_path: Path,
    *,
    display_trace_path: str | Path,
    display_html_path: str | Path,
) -> None:
    """Write a self-contained HTML viewer from already-loaded JSON records."""
    if not VIEWER_TEMPLATE_PATH.exists():
        return

    # Escape </ sequences so embedded record JSON cannot prematurely close the
    # surrounding <script> / <script type="text/plain"> blocks. Forward-proxy
    # mode can capture arbitrary HTTPS upstreams whose bodies legitimately
    # contain </script>; without this, the browser closes the data block early
    # and renders the captured HTML as page content. JSON's \/ is a valid
    # escape for /, so the parsed JSON value is unchanged.
    records = [rec.replace("</", "<\\/") for rec in record_json_lines]

    trace_path_label = str(display_trace_path)
    html_path_label = str(display_html_path)
    jsonl_path_js = json.dumps(trace_path_label)
    html_path_js = json.dumps(html_path_label)
    version_js = json.dumps(CLAUDE_TAP_VERSION)

    use_lazy = len(records) > LAZY_THRESHOLD

    if use_lazy:
        # Extract metadata for sidebar rendering
        meta_list = []
        for rec in records:
            meta = _extract_metadata(rec)
            if meta is not None:
                meta_list.append(meta)

        meta_js = json.dumps(meta_list, separators=(",", ":"))

        raw_lines = "\n".join(records)

        data_js = (
            f"const EMBEDDED_TRACE_META = {meta_js};\n"
            f"const __TRACE_JSONL_PATH__ = {jsonl_path_js};\n"
            f"const __TRACE_HTML_PATH__ = {html_path_js};\n"
            f"const __CLAUDE_TAP_VERSION__ = {version_js};\n"
            # Cost already rides on each metadata record, so only provenance is added.
            f"{_pricing_data_js({})}"
        )

        html = _read_viewer_template()
        # Inject data script + raw JSONL block before the main <script> tag
        html = html.replace(
            VIEWER_SCRIPT_ANCHOR,
            f"<script>\n{data_js}</script>\n"
            f'<script type="text/plain" id="trace-raw">\n{raw_lines}\n</script>\n'
            f"{VIEWER_SCRIPT_ANCHOR}",
            1,
        )
    else:
        # Small trace: inline all data as before
        parsed_records: list[dict] = []
        for rec in record_json_lines:
            try:
                parsed = json.loads(rec)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                parsed_records.append(parsed)
        data_js = (
            "const EMBEDDED_TRACE_DATA = [\n" + ",\n".join(records) + "\n];\n"
            f"const __TRACE_JSONL_PATH__ = {jsonl_path_js};\n"
            f"const __TRACE_HTML_PATH__ = {html_path_js};\n"
            f"const __CLAUDE_TAP_VERSION__ = {version_js};\n"
            f"{_pricing_data_js(_build_cost_index(parsed_records))}"
        )

        html = _read_viewer_template()
        html = html.replace(
            VIEWER_SCRIPT_ANCHOR,
            f"<script>\n{data_js}</script>\n{VIEWER_SCRIPT_ANCHOR}",
            1,
        )

    html_path.write_text(html, encoding="utf-8")
