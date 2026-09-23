# Static UI migration architecture boundary

This document defines the runtime boundary for serving the compiled static
client from Token Flow's Python process.
It records the intended ownership of data and behavior; it does not describe
every detail of the current implementation.

## Runtime shape

```text
Agent clients
    ↓
Python capture and trace store
    ↓
Python analysis and same-origin HTTP / SSE API
    ↓
Browser running compiled static UI
```

The installed product runs one Python process. That process owns capture,
persistence, analysis, HTTP and SSE endpoints, and serving the compiled UI. It
does not require a Node.js server at runtime. Node.js and the frontend toolchain
remain development-time build dependencies.

`ui/` is the Vite + React frontend source. Its build output is packaged under
`claude_tap/static_ui/` and served by Python. Generated files in that directory
must not be edited by hand. The `claude_tap` namespace remains an implementation
and compatibility boundary; this migration does not rename it.

## Ownership

### Python owns

- Capture lifecycle and agent-specific capture adapters.
- Raw trace evidence and durable trace storage.
- Parsing, normalization, turn and conversation grouping, and usage analysis.
- Token, cache, and cost values, including explicit unknown or unavailable
  values when evidence is insufficient.
- API payloads, filtering and aggregation over stored data, exports, and SSE
  change notifications.
- Serving the compiled UI and same-origin API routes.

The browser must not become an alternate source of truth for trace meaning or
derived numeric facts. In particular, token and cache totals, pricing, parsing,
and data aggregation belong to Python. The browser may format and visualize
values received from Python but must not silently recalculate authoritative
values from raw protocol objects.

### Browser owns

- Rendering the supplied data and visualizations.
- Layout, responsive reflow, animations, and interaction state.
- User controls such as selection, search input, and filter input. Data-backed
  filtering is requested from Python when it affects the stored collection;
  purely presentational filtering may remain local.
- Subscribing to SSE notifications and fetching current data from the API after
  relevant changes.

The browser does not read the trace database, launch capture subprocesses, or
interpret provider protocols as an independent backend.

## API and event boundary

The browser communicates with Python through same-origin HTTP endpoints and
SSE. API responses carry the values and classifications required for display;
SSE announces that relevant state changed and carries only small event
metadata. After an event, the client fetches updated data through the API rather
than treating an event stream as the full trace transport.

Capture controls are API operations. The browser requests a capture state
change; Python validates the request and owns the capture process. The command
line and browser interface should share Python capture lifecycle logic rather
than duplicate it.

## Migration constraints

- Preserve raw captured evidence while adding normalized and visual views.
- Keep public API behavior stable while the frontend runtime changes. Document
  route, query, payload, error, and event contracts before removing a route.
- Keep the dashboard and conversation workspace one coherent flow.
- A static-client replacement should preserve current user-visible workflows
  before redesign or unrelated backend restructuring.
- Remove Next.js runtime dependencies only after the static client covers the
  existing workflows and Python serves its production build.

## Current implementation gaps to close deliberately

- `ui/lib/token-model.ts` currently derives display turns, token categories,
  and related values in the browser. The target boundary places authoritative
  parsing and analysis in Python; migration must compare results against the
  existing UI and preserve evidence when moving this logic.
- The Python server still has routes for the legacy HTML viewer alongside the
  current dashboard API. Their callers and compatibility purpose must be
  established before any route is removed.

The dashboard session query, summary, redaction, and display-turn logic now
lives in `claude_tap/analysis/sessions.py`. `claude_tap/dashboard.py` remains a
compatibility import surface for existing callers and owns dashboard HTML
template loading. HTTP handlers call the analysis module directly.

FastAPI now owns the public HTTP route table and SSE streaming responses.
Endpoint handlers live in `claude_tap/server/api.py`, SSE connections and
notifications live in `claude_tap/server/events.py`, server lifecycle plus
record broadcast state live in `claude_tap/server/app.py`, and managed capture
processes are owned by `claude_tap/capture/manager.py`. `LiveViewerServer` is
exported from `claude_tap.server.app` and the package root. A small
request/response adapter preserves legacy handler response behavior. There is
one externally bound server and no internal HTTP listener.

Cursor capture and local transcript import are no longer supported. Existing
Cursor trace records remain readable so removing the importer does not make
stored conversations disappear.

Provider record parsing, metadata extraction, user-text analysis, cost-index
attachment, and export normalization live in `claude_tap/analysis/records.py`.
Pricing and subscription-cost decisions live in `claude_tap/analysis/costs.py`.
Bedrock EventStream decoding is shared through `claude_tap/trace_encoding.py`,
so the capture proxies and session analysis no longer import private parser code
from `viewer.py`. `viewer.py` now owns template/assets, pricing metadata
serialization, and legacy HTML generation; it re-exports record-analysis
helpers for compatibility with existing imports.

These gaps describe observed implementation, not exceptions to the target
ownership boundary.
