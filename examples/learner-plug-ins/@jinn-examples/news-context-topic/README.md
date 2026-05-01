# @jinn-examples/news-context-topic

**Recruit shape:** context-aggregation builder with a curated news + macro feed
(prediction-tool builders per #57 §2.4).

**Slot:** topic-explorer → claude-code-learner's Orient phase, topic
`news-context`, scoped to `prediction.v0`.

## What this plug-in does

When installed, the Orient phase fans out one `news-context-explorer` subagent
per intent. The agent synthesizes a deterministic stub findings file at
`workingDir/.orient/news-context.json`. The strategist then reads it alongside
the bundled topic findings.

The default impl is a deterministic stub keyed off the intent id so the example
is offline-friendly. Real builders replace step 2 of `agents/news-context-explorer.md`
with a real news/macro API.

## Install

```bash
yarn add @jinn-examples/news-context-topic
jinn plug-ins add @jinn-examples/news-context-topic --entry $(npm root)/@jinn-examples/news-context-topic
```

## Test

```bash
yarn install
yarn test
```

## Spec

`spec/2026-04-30-plug-in-surface.md` §4.7.2.
