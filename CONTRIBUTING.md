# Contributing to Token Flow

Keep changes small, evidence-led, and local-first. Token Flow handles request
bodies, credentials, traces, and generated certificates, so privacy and
backward compatibility matter more than broad rewrites.

## Setup

```bash
uv sync --extra dev
cd ui && npm ci
```

## Checks

```bash
uv run ruff check .
uv run ruff format --check .
uv run pytest tests/ -x --timeout=60

cd ui
npm run lint
npm run build
```

Sync a successful UI build before testing the packaged Python server:

```bash
cd ui && npm run sync
```

## Pull requests

- Explain the user problem and the behavior changed.
- List the checks and real flows exercised.
- Add tests for behavior changes.
- Include narrow and wide screenshots for material UI changes.
- Never attach API keys, cookies, unredacted traces, private prompts, or local
  file contents.

The current repository contract is in [AGENTS.md](AGENTS.md). The separate
`../claude-tap` checkout is reference material and must not become a runtime
dependency.
