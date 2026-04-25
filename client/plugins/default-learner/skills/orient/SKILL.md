---
name: orient
description: Use when the coordinator reaches the Orient phase. Decide what topics to gather; launch one explorer subagent per topic; collate findings into a summary Strategize will consume.
allowed-tools: Bash, Read, Write, Agent
---

# Orient skill

You are coordinating the Orient phase. Your only jobs are: decide what topics need gathering for this intent, launch an `explorer` subagent for each topic, and collate their results.

## Inputs

- The intent and paths from the coordinator session
- `workingDir` — write findings here
- `implStateDir` — read-only in this phase

## Decide what topics to gather

Choose from these typical categories; add or omit based on the intent:

1. **intent-parse** — what's the goal, kind, window, spec, eligibility? Always include.
2. **world-state** — for kinds with a venue (portfolio.v0, prediction.v0, etc.), pull current relevant state. Include if the kind has a venue.
3. **own-history** — list prior runs of this kind by this operator. Include if `implStateDir/runs/index.json` exists or the harness exposes a knowledge-tree query.
4. **others-history** — recent runs of this kind by other operators. Include only if `implStateDir/policy.json` sets `allowCrossOperatorReads: true` AND the harness exposes the query tool.

## Launch explorers

For each topic chosen, spawn an `explorer` subagent via the Agent tool:

```
Use the Agent tool to spawn a fresh-context subagent with role `explorer`.
Pass it inputs:
  topic        = <topic name, e.g. "world-state">
  intent       = <copy of intent>
  scope        = <topic-specific scope; explorer's role definition explains what it expects>
  workingDir   = <path>
  implStateDir = <path, read-only>
  outputPath   = workingDir/.orient/<topic>.json
  msUntilEndTs = <current value>
The subagent will load its `explorer` role definition, gather, write findings, return a summary.
```

Spawn explorers in parallel if your harness supports it; otherwise spawn sequentially. The explorers themselves do not spawn further agents (no nesting).

## Collate

After all explorers return, read each `workingDir/.orient/<topic>.json` and write `workingDir/.orient/summary.json`:

```json
{
  "intent": { "id": "...", "kind": "...", "window": { "startTs": 0, "endTs": 0 } },
  "topics": [
    { "topic": "intent-parse", "artifact": "workingDir/.orient/intent-parse.json", "summary": "...", "flags": [] },
    { "topic": "world-state", "artifact": "workingDir/.orient/world-state.json", "summary": "...", "flags": ["stale"] }
  ],
  "openQuestions": ["string — anything Strategize needs to know was uncertain or unavailable"]
}
```

Return to the coordinator: a one-paragraph summary and the path to `summary.json`.

## Boundaries

- Do not pick an approach — Strategize's job
- Do not write a plan — Plan's job
- Do not execute work — Execute's job
- Do not modify `implStateDir`

## Cross-reference

Spec: §4.1.
