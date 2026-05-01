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

## Consult slot registry

Before spawning the bundled consolidator, check `workingDir/.coordinator/slots.json` (if present) for a `phase-agent-override` entry where `slot.phase === "memory-consolidation"` AND `slot.agent === "consolidator"` AND (`slot.scope` absent OR `intent.spec.kind` ∈ `slot.scope.matchKinds`). If a match exists, spawn the agent at `<entry.packageRoot>/<entry.slot.entry>` with the same inputs as the bundled consolidator. Otherwise proceed with the bundled `consolidator` agent.

## Plug-in memory backends

Also consult `slots.json.memoryBackends`. Each entry exposes MCP tools `embed(text)`, `query(vector, k)`, and `prune(maxAgeDays)` under the namespace `memory-<plugInName>` (per `client/src/restorer/impls/claude-code-learner/mcp-config.ts`). During curation, if a backend is the policy match for this kind (consult `implStateDir/policy.json`'s `memoryBackend.default` or `memoryBackend.perKind[kind]`), call `mcp__memory-<plugInName>__embed` to index relevant artifacts and `mcp__memory-<plugInName>__query` to retrieve analogous prior cases. Multiple backends can coexist; each is a distinct MCP namespace. If no `memoryBackends` entries are present, fall back to the bundled file-based curation (the existing behaviour).

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

Verify the consolidation_record exists. If the consolidator made a commit, `implStateDirShaAfter` must match `git -C <implStateDir> rev-parse HEAD`. If no commit was made (empty curation set), `implStateDirShaAfter` must equal `implStateDirShaBefore` and HEAD remains at that sha.

Return to the coordinator: a one-paragraph summary.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or analysis

## Cross-reference

Spec: §4.7, §6.1.
