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
