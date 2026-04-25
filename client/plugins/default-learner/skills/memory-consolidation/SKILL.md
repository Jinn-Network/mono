---
name: memory-consolidation
description: Use when the coordinator reaches the Memory consolidation phase. Launch one consolidator subagent that curates implStateDir (prune unused, revert regressions) and workingDir (set public/private boundary); commits durable curation as one separate commit.
allowed-tools: Bash, Read, Write, Edit, Agent
---

# Memory consolidation skill

Launch the consolidator; verify outputs.

## Inputs

- `workingDir/.debrief/analysis.json` (trend signals, regression flags)
- `workingDir/.improve/summary.json` + `promotions/` (Improve's mutations)
- `implStateDir/` and `workingDir/` (full)
- `implStateDir/policy.json` (retention rules, size caps)

## Launch the consolidator

```
Use the Agent tool to spawn a fresh-context subagent with role `consolidator`.
Pass it inputs:
  analysisPath        = workingDir/.debrief/analysis.json
  improveSummaryPath  = workingDir/.improve/summary.json
  improvePromotionsDir = workingDir/.improve/promotions/
  policyPath          = implStateDir/policy.json (or null)
  implStateDir        = <path, read-write>
  workingDir          = <path, read-write>
  outputPath          = workingDir/.memory-consolidation/consolidation_record.json
  msUntilEndTs        = <current value>
The consolidator does both workstreams (durable + ephemeral), writes a
single git commit on implStateDir for the durable curation, and produces
the consolidation_record.
```

## After it returns

Verify the consolidation_record exists and `implStateDirShaAfter` matches `git -C <implStateDir> rev-parse HEAD`.

Return to the coordinator: a one-paragraph summary.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or analysis

## Cross-reference

Spec: §4.7, §6.1.
