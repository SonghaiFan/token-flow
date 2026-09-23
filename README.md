# Token Flow

[简体中文](README_zh.md)

Token Flow is a local-first viewer for AI-agent conversations. It watches or
proxies supported coding agents, stores their model requests locally, and turns
raw traces into understandable conversations, turns, token composition, cache
flow, and structured request evidence.

## What Token Flow does

- Watches Codex CLI, Codex App, Claude Code, Gemini CLI, and other supported
  agent clients through the local capture backend.
- Groups captured requests into conversations, queries, and turns.
- Shows token composition and how categories change across turns.
- Keeps structured, tree, and raw evidence linked to the same selected block.
- Stores traces on the local machine and redacts common authorization headers
  before recording.

## Development setup

Token Flow requires Python 3.11+, `uv`, and Node.js 22+.

```bash
git clone https://github.com/SonghaiFan/token-flow.git
cd token-flow
uv sync --extra dev

cd ui
npm ci
npm run build
npm run sync
cd ..
```

Start the local dashboard:

```bash
uv run token-flow dashboard --tap-no-open
```

The default dashboard is `http://127.0.0.1:19527/`.

## Capture an agent

Flags after `--` are passed to the selected client.

```bash
# Codex CLI
uv run token-flow --tap-client codex --tap-no-open -- --full-auto

# Codex App
uv run token-flow --tap-client codexapp --tap-no-open

# Claude Code
uv run token-flow --tap-client claude --tap-no-open

# Gemini CLI
uv run token-flow --tap-client gemini --tap-no-open -- -p "hello"
```

To stop the shared dashboard:

```bash
uv run token-flow dashboard stop
```

## UI development

The Vite + React application in `ui/` is the static UI source served by the
Python dashboard.

```bash
cd ui
npm run dev
```

For the Python server to serve the latest production UI:

```bash
cd ui
npm run lint
npm run build
npm run sync
```

Vite output is synced to `claude_tap/static_ui/`; do not edit it directly.

## Architecture

```text
agent client
    ↓ local proxy or transcript watcher
Python capture backend (`claude_tap/`, compatibility namespace)
    ↓ SQLite + local HTTP / SSE API
Compiled static UI, served by the Python process
```

The Python package name is temporarily retained because it is part of the
working capture engine and local-data compatibility. It is not the product
identity, and the separate `../claude-tap` checkout is reference material only.
The target runtime uses one Python process for capture, storage, analysis, API,
SSE, and static UI serving; Node.js is needed to build the UI, not to serve it.
See [the static UI migration architecture boundary](.agents/docs/architecture/static-ui-migration.md)
for layer ownership and current migration gaps. The observed route, payload,
and event behavior is recorded in the
[local HTTP and SSE API contract](.agents/docs/architecture/http-api-contract.md).

## Privacy

Traces can contain prompts, tool schemas, tool results, file paths, and other
private context. Keep trace databases and exports local unless they have been
reviewed and redacted. See [SECURITY.md](SECURITY.md).

## License

MIT. Token Flow retains the original license notices for inherited code.
