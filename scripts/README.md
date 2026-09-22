# Token Flow maintenance scripts

Only scripts used by the current product belong here.

## Refresh model prices

`refresh_model_prices.py` refreshes the bundled model-pricing data used by the
capture/export backend. Review its generated diff before committing it.

```bash
uv run python scripts/refresh_model_prices.py
```

UI build and sync scripts live in `ui/scripts/` because `ui/` is the canonical
frontend source.
