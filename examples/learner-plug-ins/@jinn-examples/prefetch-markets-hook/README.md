# @jinn-examples/prefetch-markets-hook

**Recruit shape:** infrastructure-tool author with a pre-fetch optimization
(saves Orient explorer subagents the latency of fetching market state during
their fan-out).

**Slot:** hook → claude-code-learner harness, event `pre-phase`, phase
`orient`, scoped to `prediction.v0`.

## What this plug-in does

Runs a bash hook before the Orient phase fans out, writing
`workingDir/.cache/markets.json` so Orient explorer subagents can read cached
market state instead of re-fetching from the API. The default impl is a
deterministic stub keyed off `JINN_INTENT_ID`. Real builders replace the
heredoc with a real API call (curl, jq pipeline, etc.).

## Install

```bash
yarn add @jinn-examples/prefetch-markets-hook
jinn plug-ins add @jinn-examples/prefetch-markets-hook --entry $(npm root)/@jinn-examples/prefetch-markets-hook
```

## Test

```bash
yarn install
yarn test
```

The tests run the hook in an isolated tempdir and assert the cache file is
written for `prediction.v0` intents (and skipped for other kinds).

## Spec

`spec/2026-04-30-plug-in-surface.md` §4.7.6.
