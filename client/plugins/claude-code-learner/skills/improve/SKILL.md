---
name: improve
description: Use when the coordinator reaches the Improve phase. Launch one promoter subagent with the analysis; commit each accepted mutation to implStateDir as a separate git commit; emit promotion records.
allowed-tools: Bash, Read, Write, Edit, Agent
---

# Improve skill

Launch the promoter; commit its mutations. Changes take effect NEXT run.

## Inputs

- `workingDir/.debrief/analysis.json`
- `implStateDir/policy.json` if present (operator policy on what Improve may touch)
- `implStateDir/` (current durable self)

## Consult slot registry

Before spawning the bundled promoter, check `workingDir/.coordinator/slots.json` (if present) for a `phase-agent-override` entry where `slot.phase === "improve"` AND `slot.agent === "promoter"` AND (`slot.scope` absent OR `intent.spec.kind` ∈ `slot.scope.matchKinds`). If a match exists, spawn the agent at `<entry.packageRoot>/<entry.slot.entry>` with the same inputs as the bundled promoter. Otherwise proceed with the bundled `promoter` agent.

## Launch the promoter

```
Use the Agent tool to spawn a fresh-context subagent with role `promoter`.
Pass it inputs:
  analysisPath       = workingDir/.debrief/analysis.json
  policyPath         = implStateDir/policy.json (or null)
  implStateDir       = <path, read-write for the promoter>
  workingDir         = <path>
  outputDir          = workingDir/.improve/
  msUntilEndTs       = <current value>
The promoter writes mutations directly into implStateDir, commits each as
a separate git commit (the session-start hook configured the author
identity already), and writes one promotion_record per mutation under
workingDir/.improve/promotions/.
```

## After it returns

Read `workingDir/.improve/summary.json`. Verify:
- `implStateDirShaAfter` matches `git -C <implStateDir> rev-parse HEAD`
- One `promotion_record` per accepted change
- Operator-access requests under `workingDir/.operator-requests/` if any

If anything is inconsistent, write `workingDir/.errors/improve.json` and abort.

Return to the coordinator: a one-paragraph summary of what changed (or didn't) and why.

## Boundaries

- Do not pre-judge what to mutate — that's the promoter's reasoning
- Do not commit yourself — the promoter commits as it goes
- Do not modify anything outside `workingDir/.improve/` from this skill

## Cross-reference

Spec: §4.6, §6.2, §6.4, §7.
