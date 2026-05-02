---
name: strategize
description: Use when the coordinator reaches the Strategize phase. Launch one strategist subagent with the Orient summary; receive a strategy + constitution; persist them under workingDir/.strategize/.
allowed-tools: Bash, Read, Write, Agent
---

# Strategize skill

Launch the strategist; persist its outputs.

## Inputs

- `workingDir/.orient/summary.json` (and per-topic files for context)
- `implStateDir/strategies/<solverType>/` if any prior promoted strategies exist
- The intent

## Launch the strategist

```
Use the Agent tool to spawn a fresh-context subagent with role `strategist`.
Pass it inputs:
  intent                 = <copy of intent>
  orientSummaryPath      = workingDir/.orient/summary.json
  priorStrategiesPath    = implStateDir/strategies/<solverType>/   (or null if absent)
  workingDir             = <path>
  implStateDir           = <path, read-only>
  outputDir              = workingDir/.strategize/
  skillBundleCid         = <from coordinator boot>
  implStateDirShaAtStart = <from coordinator boot>
  msUntilEndTs           = <current value>
The subagent loads its `strategist` role, does the divergent/convergent
selection, and writes strategy.json + constitution.json. Return its summary.
```

## After it returns

Verify both files exist:
- `workingDir/.strategize/strategy.json`
- `workingDir/.strategize/constitution.json`

If either is missing, write `workingDir/.errors/strategize.json` with the failure context and abort.

Return to the coordinator: a one-paragraph summary of the chosen approach + success criteria + timing posture, plus paths to both files.

## Boundaries

- Do not generate the strategy yourself — that's the strategist agent's job in fresh context
- Do not modify `implStateDir`
- Never run a second strategist after the first has committed (no re-strategizing mid-run)

## Cross-reference

Spec: §4.2, §10.
