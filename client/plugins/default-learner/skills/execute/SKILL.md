---
name: execute
description: Use when the coordinator reaches the Execute phase. Walk the plan, launch one step-worker subagent per work step, honor wait steps, decide at runtime when stuck.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill
---

# Execute skill

Walk the plan and drive it. Workers are spawned by you (the coordinator session via this skill); they do not nest further.

## Inputs

- `workingDir/.plan/plan.json` — the steps
- `workingDir/.strategize/strategy.json` — success criteria + timing posture
- `workingDir/.orient/summary.json` — grounding
- The intent + window + remaining time budget

## Walk the plan

For each step in order, respecting `concurrency` markings:

### Work steps

Spawn a `step-worker` subagent via the Agent tool:

```
Use the Agent tool to spawn a fresh-context subagent with role `step-worker`.
Pass it inputs:
  stepSpec     = <the entire step object from plan.json>
  intent       = <copy of intent>
  workingDir   = <path>
  implStateDir = <path, read-only>
  msUntilEndTs = <current value>
```

For parallel-batch steps (steps sharing a `concurrency: parallel-batch-X` label), spawn the whole batch concurrently if your harness supports it; wait for all to return before advancing.

After a worker returns:
- Check the `successSignal` from the step spec — did the step succeed?
- If yes: append to `workingDir/.execute/log.jsonl` and advance.
- If no: see "When stuck."

### Wait steps

Use the harness's wait primitive (Claude Code: `Monitor`; Pi.dev: equivalent). Honor `durationMs`, `untilTs`, and `condition`. The abort signal from the daemon (`window.endTs`) overrides any wait.

### When stuck

When a step fails its success signal or a worker returns without expected outputs, judge:

- **Continue** — accept partial; advance.
- **Retry-step** — spawn a fresh worker for the same step. Cap at 2 retries unless step `abortCondition` says otherwise.
- **Replan** — load the `plan` skill via `Skill plan` again with the failure as added context, write the new plan to a versioned path (`workingDir/.plan/plan-v2.json`), continue Execute on the new plan.
- **Abort** — write `workingDir/.errors/execute.json` with failure context; exit Execute. Coordinator continues to Debrief / Improve / Memory consolidation so partial work is harvested.

Explain your judgment in `workingDir/.execute/log.jsonl`.

## Outputs

Throughout the phase:
- `workingDir/.execute/log.jsonl` — one entry per step boundary: `{ ts, stepId, decision, summary, retryCount }`
- Per-step outputs as the plan declared

At end:
- `workingDir/.execute/summary.json`:
  ```json
  {
    "stepsCompleted": ["step-1", "step-2"],
    "stepsFailed": [],
    "decisions": ["continue", "retry-step", "continue"],
    "elapsedMs": 0,
    "returnReason": "all-steps-completed | hold-and-revise-window-end | abort"
  }
  ```

## Boundaries

- Do not invoke Strategize — strategy is frozen
- Do not write to `implStateDir` — Improve does that
- Do not run Debrief / Improve / Memory consolidation — coordinator does that next
- Do not call wait for arbitrarily long with no plan justification
- Do not spawn agents that themselves spawn agents (your workers are one level deep)

## Cross-reference

Spec: §4.4, §5.
