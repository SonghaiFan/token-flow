# Token Flow local HTTP and SSE contract

This is the observed contract implemented by the FastAPI route table in
`token_tap/server/app.py` and handlers in `token_tap/server/api.py` on
2026-09-23. Route names and payloads are not yet frozen against compatibility
tests. Do not remove or change a route based only on the current Next.js client:
legacy viewer and CLI callers also exist.

All routes are same-origin on the local server. JSON request bodies use
`Content-Type: application/json`; JSON responses use `application/json` unless
noted. Session IDs in paths are opaque strings and clients should URL-encode
them.

## Current Next.js dashboard contract

| Method and path | Query or body | Response | Errors and notes |
|---|---|---|---|
| `GET /api/sessions` | Optional `offset` (default 0, minimum 0), `limit` (default configured page size, clamped to 1–200), `agent`, `date`, `status`, `search` | `{sessions, total, total_records, total_tokens, total_errors, offset, limit, has_more, dates, has_legacy}`. `sessions` entries include at least `id`, `status`, `record_count` and available summary fields such as agent, model, timestamps, first-user preview, turn/token counts, duration, and live state. | Invalid numeric offset falls back to 0; invalid limit falls back to default. Unsupported status/date values are normalized by the query builder rather than rejected. |
| `GET /api/agents` | None | `{agents: [{key, label, sessions, records}]}` | Finalizes stale active-session state before listing. |
| `GET /api/sessions/{session_id}/records` | Optional `limit` (nonnegative integer, otherwise unlimited), `offset` (default 0); `view=turns` selects display-turn records | `{session: summary, records: [...]}`. Records preserve the captured record object and receive backend-attached cost data. | `404 {error: "Session not found"}`. `view=turns` is the current dashboard view. |
| `DELETE /api/sessions/{session_id}` | No body | Store deletion result, including deletion counts | `404` if absent; `409` if live or active. Successful deletion emits dashboard `refresh`. |
| `DELETE /api/sessions` | JSON object with either `{"clear_all":true}` or `{"session_ids":[...]}` | Deletion counts and, where applicable, `missing_sessions` and `skipped_active_sessions` | `400` invalid JSON, missing/invalid `session_ids`, or empty selection. `409` if selected sessions exist but none can be deleted. Clear-all preserves active sessions. Successful deletion emits `refresh`. |
| `GET /api/sessions/{session_id}/export/compact` | None | Compact trace JSON download (`application/json`) | `404` if absent. Current workspace Export link uses this route. |

The sessions response is the dashboard's aggregate source: `total` is the
filtered conversation count; the other aggregate fields describe that same
query. `dates` and `has_legacy` are currently included even when the client
only needs the session list.

## Dashboard service and capture routes

| Method and path | Query or body | Response | Access and errors |
|---|---|---|---|
| `GET /dashboard/health` | None | `{ok, db_path, dashboard_mode, version}`; includes `quit_token` only for a trusted same-origin localhost request in dashboard mode | Health data is readable without the mutation token. Treat `quit_token` as a secret and do not log or expose it. |
| `GET /dashboard/captures` | None | `{available, client, state, pid, started_at, exit_code, error}`; state is `idle`, `starting`, `capturing`, `stopping`, or `error` | Read-only status. `available` is currently true only for dashboard mode on macOS. |
| `POST /dashboard/captures` | No body. Requires `X-Claude-Tap-Dashboard-Token` from trusted `GET /dashboard/health` response. | Capture status; success is `202` | `403` if not dashboard mode, trusted localhost same-origin, or valid token; `501` on unsupported platform; `409` if a capture is already running; `500` if subprocess startup fails. Starts the managed Codex App capture. |
| `DELETE /dashboard/captures` | No body. Same token and origin requirements as POST. | Capture status | `403` on failed access checks. Stops the managed capture when running. |
| `POST /dashboard/quit` | No body. Requires trusted localhost same-origin and `X-Claude-Tap-Dashboard-Token`. | `{ok:true}` | `403` if not dashboard mode or access checks fail. Stops the server asynchronously. No current Next.js UI caller was found. |

The dashboard client obtains the token via health, then sends it on capture
mutations. `token_tap/capture/manager.py` owns the child process and status;
the API validates requests and translates manager results to HTTP responses.
The UI polls status. The quit token header is currently named
`X-Claude-Tap-Dashboard-Token`.

## Dashboard SSE

`GET /dashboard/events` returns `text/event-stream` and sends named events with
JSON data. It immediately sends `ready`, sends comments as keepalives, and
closes when the server shuts down.

| Event | Data | Current meaning |
|---|---|---|
| `ready` | `{"type":"ready"}` | Connection established. |
| `record` | `{"type":"record","session_id":"..."}` | A record was added; clients should refresh the affected session/list from HTTP. |
| `refresh` | `{"type":"refresh"}` | Stored session state changed, commonly after deletion or store polling; refetch data. |
| `capture` | `{"type":"capture"}` | Managed capture state changed. Current capture control polls the status endpoint rather than listening to this event. |

Events are notifications, not a durable queue. The `record` and `refresh`
handlers in the current UI refetch HTTP data; clients must tolerate reconnects
and should not assume they received every intermediate event.

## Legacy trace viewer and compatibility routes

These routes are registered by the same server but are not part of the current
Next.js dashboard's ordinary data path. Preserve them until their consumers are
identified and intentionally migrated.

| Method and path | Behavior |
|---|---|
| `GET /` | In dashboard mode, serves generated dashboard UI; otherwise serves the legacy live viewer. |
| `GET /dashboard` | Serves generated dashboard UI. |
| `GET /dashboard/session/{session_id}` | Serves the generated dashboard shell when available; fallback renders the legacy per-session HTML viewer. |
| `GET /assets/{asset_path}` | Serves a compiled Vite asset from `token_tap/static_ui/`; rejects missing paths and traversal. |
| `GET /_next/{asset_path}` | Serves generated UI assets under `token_tap/web_ui/_next/`; rejects missing paths and traversal. |
| `GET /viewer` | Legacy live viewer HTML. |
| `GET /records` | Current in-memory live records as a JSON array, with backend-attached cost data. |
| `GET /events` | Legacy live-trace SSE: sends each current in-memory record as a default unnamed `data` event, then streams new records and keepalives. |
| `GET /api/dates` | `{dates, has_legacy}` from the trace store. |
| `GET /api/traces/{date}` | Records for `YYYY-MM-DD` or `legacy`, as a JSON array with attached cost data. Other date strings return `400` text. |
| `DELETE /api/traces/{date}` | Deletes history for `YYYY-MM-DD` or `legacy`. Optional `force=1`, `true`, or `yes` changes active-session protection behavior. Invalid dates return `400` JSON error. |
| `GET /api/sessions/{session_id}/html` | Compatibility route that renders the legacy HTML viewer for one stored session. |
| `GET /api/sessions/{session_id}/export/jsonl` | JSON Lines download (`application/x-ndjson`). |
| `GET /api/sessions/{session_id}/export/log` | Plain-text log download. |
| `GET /api/sessions/{session_id}/export/html` | Generated standalone HTML viewer download. |

Session-specific legacy HTML and export routes return `404` when the session
does not exist. The HTML viewer can itself request session records and compact,
JSONL, or HTML exports. The live `/events` stream transports full record
objects; the dashboard `/dashboard/events` stream is the lightweight
notification channel.

## Current client map

- `ui/lib/api.ts`: sessions, agents, session records, deletion, capture status,
  and capture mutations.
- `ui/components/views/conversations-view.tsx`: sessions and agents; listens
  for dashboard `record` and `refresh` events.
- `ui/components/views/workspace-view.tsx`: session records, deletion, compact
  export; listens for dashboard `record` and `refresh` events and reloads the
  selected session.
- `ui/components/capture-control.tsx`: capture status polling and start/stop.
- The generated legacy viewer and Python-built standalone exports use the
  legacy routes above.

## Contract caveats

- Handler behavior is the source for this observed contract; request parsing,
  response keys, status codes, and authentication have not yet been centralized
  into a separate schema module.
- The dashboard currently calls `/dashboard/*` for service/capture operations
  as well as `/api/*` for session data. Do not assume every browser route already
  follows a single `/api/*` namespace.
- Error JSON is not fully uniform: some validation errors are JSON, while the
  invalid legacy `GET /api/traces/{date}` response is plain text.
- Record payloads preserve provider-shaped raw evidence and are intentionally
  described as open objects here rather than a closed provider schema.
