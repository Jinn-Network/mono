---
name: plan
description: Use when the coordinator reaches the Plan phase. Launch one planner subagent with the strategy; receive the plan; persist it under workingDir/.plan/.
allowed-tools: Bash, Read, Write, Agent
---

# Plan skill

Launch the planner; persist its output.

## Inputs

- `workingDir/.strategize/strategy.json`
- `workingDir/.orient/summary.json` for grounding
- `implStateDir/plans/<kind>/` if any prior promoted plan templates
- The intent

## Launch the planner

```
Use the Agent tool to spawn a fresh-context subagent with role `planner`.
Pass it inputs:
  intent              = <copy of intent>
  strategyPath        = workingDir/.strategize/strategy.json
  orientSummaryPath   = workingDir/.orient/summary.json
  priorPlanTemplatesPath = implStateDir/plans/<kind>/ (or null)
  workingDir          = <path>
  implStateDir        = <path, read-only>
  outputPath          = workingDir/.plan/plan.json
  msUntilEndTs        = <current value>
```

## After it returns

Verify `workingDir/.plan/plan.json` exists. If not, write `workingDir/.errors/plan.json` and abort.

Return to the coordinator: a one-line summary ("plan with N steps, M parallel batches, K wait checkpoints") and the path to `plan.json`.

## Boundaries

- Do not change success criteria or timing posture — frozen in Strategize
- Do not execute — Execute does that
- Do not modify `implStateDir`

## Cross-reference

Spec: §4.3, §5.
