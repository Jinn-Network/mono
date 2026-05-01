---
name: debrief
description: Use when the coordinator reaches the Debrief phase. Optionally launch explorer subagents for cross-operator / outcome reads, then launch one analyst subagent with all evidence to produce the analysis Improve consumes.
allowed-tools: Bash, Read, Write, Agent
---

# Debrief skill

Mirrors Orient — gather + sense-make in hindsight. You may launch explorers (for cross-operator reads or fresh world-state probes) and always launch the analyst.

## Inputs

- All `workingDir/.<prior-phase>/` outputs through Execute
- Strategy + constitution from `workingDir/.strategize/`
- Plan from `workingDir/.plan/`
- `implStateDir/runs/` for own history
- The intent

## Optional: launch explorers

If the operator's policy enables cross-operator reads or fresh-world-state probes, spawn `explorer` subagents in parallel for each post-execution topic:

- `outcome-probe` — re-pull venue / market / on-chain state to see post-execution outcome
- `cross-operator-comparison` — knowledge-tree query for similar runs by other operators (only if policy allows)

Same Agent-tool spawn pattern as Orient. Outputs land under `workingDir/.debrief/<topic>.json`.

## Plug-in topic explorers

In addition to the topics above, consult `workingDir/.coordinator/slots.json` (if present). For each entry in `topicExplorers` matching `slot.phase === "debrief"` AND (`slot.scope` absent OR `intent.spec.kind` ∈ `slot.scope.matchKinds`), treat it as an additional topic to gather. Topic name is `slot.topic`; explorer agent is at `<entry.packageRoot>/<entry.slot.entry>`. Inputs match the bundled explorer (topic, intent, scope, workingDir, implStateDir, outputPath = `workingDir/.debrief/<topic>.json`, msUntilEndTs). Topic-name collisions: a plug-in's explorer replaces the bundled fan-out for that topic; surface a one-line note in the analyst's input bundle.

## Consult slot registry

Before spawning the bundled analyst, check `workingDir/.coordinator/slots.json` (if present) for a `phase-agent-override` entry where `slot.phase === "debrief"` AND `slot.agent === "analyst"` AND (`slot.scope` absent OR `intent.spec.kind` ∈ `slot.scope.matchKinds`). If a match exists, spawn the agent at `<entry.packageRoot>/<entry.slot.entry>` with the same inputs as the bundled analyst. Otherwise proceed with the bundled `analyst` agent.

## Launch the analyst

```
Use the Agent tool to spawn a fresh-context subagent with role `analyst`.
Pass it inputs:
  intent             = <copy of intent>
  strategyPath       = workingDir/.strategize/strategy.json
  constitutionPath   = workingDir/.strategize/constitution.json
  planPath           = workingDir/.plan/plan.json
  executeSummaryPath = workingDir/.execute/summary.json
  executeLogPath     = workingDir/.execute/log.jsonl
  orientSummaryPath  = workingDir/.orient/summary.json
  debriefExplorerPaths = [workingDir/.debrief/<topic>.json, ...]
  ownHistoryPath     = implStateDir/runs/index.json (or null)
  workingDir         = <path>
  implStateDir       = <path, read-only>
  outputPath         = workingDir/.debrief/analysis.json
  msUntilEndTs       = <current value>
The subagent loads its `analyst` role and writes analysis.json. Return its summary.
```

## After it returns

Verify `workingDir/.debrief/analysis.json` exists. If not, write `workingDir/.errors/debrief.json` and abort.

Return to the coordinator: a one-paragraph plain-English summary plus the path to `analysis.json`.

## Boundaries

- Do not change success criteria — frozen in Strategize
- Do not modify `implStateDir` — Improve does that
- Do not invent recommendations — every recommendation must be grounded in the evidence

## Cross-reference

Spec: §4.5.
