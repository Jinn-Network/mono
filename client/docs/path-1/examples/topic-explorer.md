# Worked example: topic-explorer

**Example package:** [`examples/learner-plug-ins/@jinn-examples/news-context-topic`](../../../../examples/learner-plug-ins/@jinn-examples/news-context-topic)

## Recruit shape

You're a context-aggregation builder. You curate news, macro signals, social sentiment, on-chain flow data — whatever feeds *into* a forecaster's reasoning. You don't run the forecaster yourself; you produce the context it consumes.

A topic explorer is the natural shape: Orient fans out across topics; you add one.

## What the slot does

The `topic-explorer` slot adds a topic to either `orient` or `debrief`. The phase's coordinator fans out across the registered topics, including yours, and your agent fills `workingDir/.<phase>/<topic>.json` for the next phase to consume (Strategize for Orient topics; Improve for Debrief topics).

The news-context-topic example adds a `news-context` topic to Orient for `prediction.v0` intents. When Orient runs, our agent fetches relevant news for the prediction window, extracts entities + sentiment, and writes `workingDir/.orient/news-context.json` for Strategize to absorb.

## Manifest

```jsonc
{
  "schemaVersion": "1.0.0",
  "name": "@jinn-examples/news-context-topic",
  "version": "0.1.0",
  "compatibility": {
    "claudeCodeLearner": ">=0.1.0 <0.2.0",
    "supportedKinds": ["prediction.v0"]
  },
  "slots": [
    {
      "type": "topic-explorer",
      "phase": "orient",
      "topic": "news-context",
      "scope": { "matchKinds": ["prediction.v0"] },
      "entry": "agents/news-context-explorer.md"
    }
  ]
}
```

A real package would commonly bundle a `topic-explorer` slot with an `mcp-tool` slot (the news fetcher itself) — both go in the same `slots[]` array. The example keeps them separate to keep the walkthrough focused.

## Slot entry walkthrough

`agents/news-context-explorer.md` is a markdown agent. The harness spawns it under the Orient phase with the topic name + the intent + the working dir. The agent's frontmatter lists the tools it uses (commonly `Bash`, `Read`, `Write`, plus any MCP tools the package's other slots register).

The agent writes the topic artefact to `workingDir/.orient/news-context.json`. Strategize's coordinator reads the entire `.orient/` directory at phase start; your topic appears alongside the bundled topics with no special handling.

## Test → install → run

```bash
cd examples/learner-plug-ins/@jinn-examples/news-context-topic
yarn install
yarn test

cd ~/your-daemon-config
yarn add file:.../examples/learner-plug-ins/@jinn-examples/news-context-topic
jinn plug-ins add @jinn-examples/news-context-topic

# Restart daemon. Orient now fans out to news-context as one of its topics.
```

## Replace the stub

1. **Edit the agent body** to call your real news API (via an MCP tool you bundle in the same package, or via existing harness capabilities like `Bash` + `curl`).
2. **Define your topic's output schema** — Strategize and downstream phases will rely on it. Document it in the agent's frontmatter or a sibling `SCHEMA.md`.
3. **If your fetcher needs an API key**, publish a separate `mcp-tool` slot whose server reads the key from its own env. The harness won't read secrets for you (Path 1 inherits the harness's capability surface and adds none).

Builders who need to extend the topic to *Debrief* (asking "what did the news context look like at the time, in retrospect?") add a second `topic-explorer` slot in the same manifest with `phase: "debrief"`.
