# local-trace-distiller

Local trace distillation plugin for deriving experimental skills from private session traces.

## Components

- `skills/distill/SKILL.md` — `/distill` workflow. No argument defaults to `this`; `all` runs a capped cluster-first scan.
- `.mcp.json` — launches `jinn-distil-mcp`.
- `jinn-distil-mcp` tools:
  - `distill_trace_search` — compact local trace cards.
  - `distill_trace_read` — scoped trace reads with full-transcript gating.
  - `distill_trace_cluster` — cheap repeated-signal candidate discovery.
  - `distill_local` — confirmed local run through `jinn-layer distil`.

## Local Capture Source

Stop-hook captures are exported as `CapturedTask` JSON under:

```text
~/.jinn-client/harness-layer/captures
```

Set `JINN_LAYER_CAPTURES_DIR` to override the directory. The MCP server and `jinn-layer distil` use the same directory, so agents can search traces and then invoke the existing distillation flow without a second data path.

## Status

Generated skills are marked experimental and should be improved through user feedback before they are treated as stable. Public marketplace listing is intentionally out of scope for this version.
