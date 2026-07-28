---
name: learn
description: Use when running a goal end-to-end through a seven-phase learning loop. Sequences Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation, dispatching specialized subagents per phase, and improves itself between runs by mutating its own state directory.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
---

# Learn — claude-code-learner orchestrator

You are running one goal end-to-end through a seven-phase learning loop. This single skill drives the full pipeline. Each phase below dispatches a fresh-context subagent whose prompt body is read from a sibling `*-prompt.md` file in this skill directory; you collect the subagent's output and proceed.

## Inputs (from the harness)

- `goal` — `{ id, description, kind?, deadline?, spec? }`. Free-form payload describing what to achieve. The plugin reads `description` to know the task and may organize prior runs by `kind` if present. The plugin does not interpret `kind` semantically; it is an opaque string used for organizing artifacts.
- `workingDir` — ephemeral path; the harness harvests it for delivery when this skill returns.
- `taskWorkspaceDir` — optional absolute path for the Task's authoritative mutable workspace. When present, repository inspection, mutation, and verification happen only here. This is distinct from `workingDir`.
- `implStateDir` — the agent's persistent self-state. Git-backed by the SessionStart hook. Mutations here persist across runs and constitute "learning."
- `msUntilDeadline` — function returning remaining time.
- `mode` — `train` or `frozen`. Default to `train` if absent. In `frozen` mode, the learning loop must not mutate `implStateDir`.
- An abort signal that fires at the goal's deadline (if any).

The session-start hook (`hooks/session-start`) has already initialized `implStateDir` as a git repo with the `claude-code-learner` author identity.

When `taskWorkspaceDir` is present, bind it once and pass that exact absolute
path to every dispatched subagent. Task files belong under
`taskWorkspaceDir`; learner telemetry remains under `workingDir`, including
`.coordinator`, `.orient`, `.strategize`, `.plan`, `.execute`, `.debrief`,
`.improve`, and `.memory-consolidation`. Never resolve a relative repository
path against the episode root.

## 1. Boot

The session-start hook (`hooks/session-start`) has already run with `IMPL_STATE_DIR` set, so:
- `implStateDir` is a git repo
- The claude-code-learner git author identity is configured
- HEAD sha is the implStateDir state at run start

Capture it for the constitution span:

```bash
IMPL_STATE_DIR_SHA=$(git -C "$IMPL_STATE_DIR" rev-parse HEAD)
SKILL_BUNDLE_CID=$(find "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.mjs' \) | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
```

The plugin root is provided by Claude Code as `${CLAUDE_PLUGIN_ROOT}`. Other harnesses may set `$PLUGIN_ROOT` from their session-start hook (the claude-code-learner hook does both for portability — sets and exports `PLUGIN_ROOT`). If neither is set, hash the loaded skills from their loaded paths.

Write `workingDir/.coordinator/boot.json` (downstream phases — particularly Strategize — read it for the constitution span). The directory name is `coordinator` for backward compatibility with the existing on-disk artifact layout consumed by Strategize and Debrief; do not rename it. The shape is:

```json
{
  "implStateDirShaAtStart": "<git HEAD sha of implStateDir at run start>",
  "skillBundleCid": "sha256:<plugin bundle digest>",
  "goalId": "<goal.id>",
  "deadline": <goal.deadline as milliseconds since epoch>
}
```

The harness hands you `goal`, `workingDir`, optional `taskWorkspaceDir`, and
`implStateDir` as session inputs (not POSIX env vars). Bind them to the
variables this section uses, then write the file:

```bash
# Bind session inputs into shell variables (substitute your harness's
# mechanism — e.g., values pulled from the initial prompt context or a
# harness-provided JSON input):
WORKING_DIR="<workingDir from session inputs>"
GOAL_ID="<goal.id from session inputs>"
DEADLINE="<goal.deadline from session inputs>"

mkdir -p "$WORKING_DIR/.coordinator"
cat > "$WORKING_DIR/.coordinator/boot.json" <<EOF
{
  "implStateDirShaAtStart": "$IMPL_STATE_DIR_SHA",
  "skillBundleCid": "sha256:$SKILL_BUNDLE_CID",
  "goalId": "$GOAL_ID",
  "deadline": $DEADLINE
}
EOF
```

`deadline` is the goal's deadline in milliseconds since epoch.

## 2. Phase-range guard

*Phase-range hint:* if the env var `LEARNER_PHASE_RANGE` is set, run only the corresponding subset:

- `full` (or unset) — run all seven phases (sections 3–9), then verify and return (sections 10–11).
- `pre-execute` — run only sections 3–5 (Orient, Strategize, Plan), then return. The harness's specialist wrapper will run Execute itself and invoke this skill again with `post-execute`.
- `post-execute` — run section 7 (Debrief), plus sections 8–9 (Improve, Memory consolidation) only when `mode = train`. The harness's specialist wrapper has already populated `workingDir/.execute/` from a domain-specialist Execute path before invoking this pass.

This protocol exists so the harness's first-match wrapper can wrap domain-specialist Execute paths in the learning envelope without the specialist needing to know about the wrapper.

Mode controls whether the self-improving phases are allowed:

- `mode = train` — run Improve and Memory consolidation when phase-range includes sections 8–9.
- `mode = frozen` — run Orient, Strategize, Plan, Execute, and Debrief only. Skip Improve and Memory consolidation, do not mutate `implStateDir`, and return with no `.improve/` or `.memory-consolidation/` requirement. The daemon enforces this with a freeze fence and rejects any envelope that mutates the frozen implementation state.

For each section below, in order:

1. Dispatch the section's subagent(s) per the uniform shape (see "Uniform dispatch shape" below).
2. Collect outputs and verify the artifacts exist.
3. Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
   `{ ts, phase, status, summary }`.

## Uniform dispatch shape

Every section that dispatches a subagent uses the same shape. Spawn a fresh-context subagent. Read the prompt body from `${PLUGIN_ROOT}/skills/learn/<role>-prompt.md` (or `${CLAUDE_PLUGIN_ROOT}/skills/learn/<role>-prompt.md`) and pass it as the subagent's instructions. Pass these inputs:

```
goal             = <copy of goal>
workingDir       = <path>
taskWorkspaceDir = <absolute path or null>
implStateDir     = <path, read-only unless this role mutates it>
outputPath       = workingDir/.<phase>/<artifact>.json
msUntilDeadline  = <current value>
... role-specific inputs (see <role>-prompt.md inputs section) ...
```

The subagent reads the prompt, follows it, writes `outputPath`, and returns a one-line summary plus `artifactPath`.

Do not reference any registered-subagent registry by name. There is no `subagent_type:` argument and no `claude-code-learner:<role>` identifier. The mechanism is: read prompt file → spawn fresh-context subagent → pass prompt as instructions.

Use the dispatch, wait, and release primitives exposed by the current harness. The harness is responsible for projecting those generic operations onto its native tool surface. Keep these lifecycle rules independent of harness:

- Keep the returned handle/id for each dispatched subagent.
- Wait until every required artifact for the current phase exists; if a multi-wait returns only some completed subagents, keep waiting on the remaining handles.
- Release/close completed subagents once their outputs have been verified and their summaries have been captured, especially before spawning a later phase.
- Pass absolute filesystem paths in subagent inputs. Subagents must use those absolute paths for reads and writes rather than assuming they inherited the coordinator's current working directory.
- When `taskWorkspaceDir` is non-null, pass it unchanged to every subagent. Task inspection, mutations, outputs, and success verification use that root; learner phase artifacts use `workingDir`.

For sections that dispatch multiple subagents in parallel (Orient, optional Debrief probes), spawn one subagent per topic with its own `topic` and `outputPath`. If your harness supports it, run them concurrently; otherwise dispatch sequentially. Subagents do not spawn further subagents — they are one level deep.

## 3. Orient

Purpose: gather goal + world-state + history; produce findings Strategize will consume.

Decide what topics need gathering. Choose from these typical categories; add or omit based on the goal:

1. **goal-parse** — what's the goal, kind (if present), deadline, spec, eligibility? Always include.
2. **world-state** — for goals where the harness exposes tools to inspect external state, pull current relevant state. Include if such tools are available for this goal.
3. **own-history** — list prior runs of this kind by this operator. Include if `implStateDir/runs/index.json` exists or the harness's history-of-runs query is exposed.
4. **others-history** — recent runs of this kind by other operators. Include if the harness's history-of-runs query is exposed. (This is read-only discovery — it surfaces who ran what, with which evidence tier and score, plus the artifact list and prices; it does not acquire artifact bytes or spend anything. Cross-operator content is hash-verified at acquisition time and the agent re-verifies anything before acting on it, so there is no separate opt-in: the learner always looks at the network when it can.)

For each chosen topic, dispatch an explorer subagent in parallel. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body      = ${PLUGIN_ROOT}/skills/learn/explorer-prompt.md
topic            = <topic name, e.g. "goal-parse">
goal             = <copy of goal>
scope            = <topic-specific scope; explorer-prompt.md describes what it expects>
workingDir       = <path>
implStateDir     = <path, read-only>
outputPath       = workingDir/.orient/<topic>.json
msUntilDeadline  = <current value>
```

After all explorers return, read each `workingDir/.orient/<topic>.json` and write `workingDir/.orient/summary.json`:

```json
{
  "goal": { "id": "...", "kind": "...", "deadline": 0 },
  "topics": [
    { "topic": "goal-parse", "artifact": "workingDir/.orient/goal-parse.json", "summary": "...", "flags": [] },
    { "topic": "world-state", "artifact": "workingDir/.orient/world-state.json", "summary": "...", "flags": ["stale"] }
  ],
  "openQuestions": ["string — anything Strategize needs to know was uncertain or unavailable"]
}
```

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 4. Strategize

Purpose: pick approach, freeze success criteria + timing posture into a constitution record.

Dispatch a strategist subagent. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body            = ${PLUGIN_ROOT}/skills/learn/strategist-prompt.md
goal                   = <copy of goal>
orientSummaryPath      = workingDir/.orient/summary.json
priorStrategiesPath    = implStateDir/strategies/<goal.kind>/   (or null if absent)
workingDir             = <path>
implStateDir           = <path, read-only>
outputDir              = workingDir/.strategize/
skillBundleCid         = <from boot.json>
implStateDirShaAtStart = <from boot.json>
msUntilDeadline        = <current value>
```

After it returns, verify both files exist:
- `workingDir/.strategize/strategy.json`
- `workingDir/.strategize/constitution.json`

If either is missing, write `workingDir/.errors/strategize.json` with the failure context and abort the pipeline. In `train` mode, still run section 9, Memory consolidation, before returning. In `frozen` mode, return without running section 9.

After Strategize, read `workingDir/.strategize/constitution.json`. If the harness exposes an OTel tracer, emit the constitution fields as attributes on a state-transition span (the harness defines the span name). Otherwise the file itself is the constitution record; Debrief reads it from there.

Never run a second strategist after the first has committed (no re-strategizing mid-run). The strategy is frozen for the remainder of this run.

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 5. Plan

Purpose: produce concrete steps, optionally time-anchored.

Dispatch a planner subagent. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body              = ${PLUGIN_ROOT}/skills/learn/planner-prompt.md
goal                     = <copy of goal>
strategyPath             = workingDir/.strategize/strategy.json
orientSummaryPath        = workingDir/.orient/summary.json
priorPlanTemplatesPath   = implStateDir/plans/<goal.kind>/ (or null)
replanContextPath        = workingDir/.plan/replan-context.json (or null on first plan)
priorPlanArchives        = [workingDir/.plan/plan-v1.json, ...] (or empty on first plan)
workingDir               = <path>
taskWorkspaceDir         = <absolute path or null>
implStateDir             = <path, read-only>
outputPath               = workingDir/.plan/plan.json
msUntilDeadline          = <current value>
```

After it returns, verify `workingDir/.plan/plan.json` exists. If not, write `workingDir/.errors/plan.json` and abort the pipeline (still run section 9 before returning).

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 6. Execute

Purpose: walk the plan, dispatch one step-worker per work step, honor wait steps, decide at runtime when stuck.

Inputs you read directly:
- `workingDir/.plan/plan.json` — the steps
- `workingDir/.strategize/strategy.json` — success criteria + timing posture
- `workingDir/.orient/summary.json` — grounding
- The goal + deadline + remaining time budget

For each step in order, respecting `concurrency` markings:

### Work steps

Dispatch a step-worker subagent. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body      = ${PLUGIN_ROOT}/skills/learn/step-worker-prompt.md
stepSpec         = <the entire step object from plan.json>
goal             = <copy of goal>
workingDir       = <path>
taskWorkspaceDir = <absolute path or null>
implStateDir     = <path, read-only>
msUntilDeadline  = <current value>
```

For parallel-batch steps (steps sharing a `concurrency: parallel-batch-X` label), dispatch the whole batch concurrently if your harness supports it; wait for all to return before advancing.

After a worker returns:
- The worker's self-reported `status` and `blockers` are evidence; the authoritative verdict is your re-check of the step's `successSignal` against actual outputs on disk. When `taskWorkspaceDir` is non-null, re-check every Task mutation and repository condition there, never at the episode root.
- Check `successSignal` — did the step succeed?
- If yes: append to `workingDir/.execute/log.jsonl` (carrying the worker's `status` and `blockers` into the log entry) and advance.
- If no: see "When stuck" below.

### Wait steps

Use the harness's wait primitive (per spec §8 harness-adapter contract). Plan-emitted wait steps may include any combination of `durationMs`, `untilTs`, and `condition`; treat absent and explicit `null` identically as "not set." When multiple wakers are set, wake on the first to fire (per spec §5: `wait` wakes when any of duration / deadline / condition fires). The abort signal from the harness (the goal's `deadline`) always overrides any wait.

### When stuck

When a step fails its success signal or a worker returns without expected outputs, judge:

- **continue** — accept partial; advance.
- **retry-step** — dispatch a fresh worker for the same step. Cap at 2 retries unless step `abortCondition` says otherwise.
- **replan** — archive the current plan and re-run section 5 (Plan), then continue Execute on the new plan. Concretely: rename `workingDir/.plan/plan.json` to `workingDir/.plan/plan-v<N>.json` where N is the next unused integer (start at 1), write `workingDir/.plan/replan-context.json` with `{ failedStepId, blockers, partialOutputs[] }`, then re-dispatch the planner subagent (section 5). The new `plan.json` is grounded in what's now in `workingDir/` (including the archived prior plans, the execute log up to the failure, and the replan-context). Continue Execute on the new `plan.json`.
- **abort** — write `workingDir/.errors/execute.json` with failure context; exit Execute. Continue to Debrief and, in `train` mode only, Improve / Memory consolidation. Abort here is not a pipeline-level abort.

Explain your judgment in `workingDir/.execute/log.jsonl`.

### Outputs

Throughout the phase:
- `workingDir/.execute/log.jsonl` — one entry per step boundary: `{ ts, stepId, decision, summary, retryCount, workerStatus, workerBlockers }`. `workerStatus` and `workerBlockers` come directly from the step-worker's return shape so Debrief sees both the worker's self-assessment and Execute's verdict.
- Per-step outputs as the plan declared.

At end, write `workingDir/.execute/summary.json`:

```json
{
  "stepsCompleted": ["step-1", "step-2"],
  "stepsFailed": [],
  "decisions": ["continue", "retry-step", "continue"],
  "elapsedMs": 0,
  "returnReason": "all-steps-completed | early-return | hold-and-revise-window-end | continuous-observation-window-end | abort"
}
```

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 7. Debrief

Purpose: post-execution analysis. Mirrors Orient — gather + sense-make in hindsight.

### Optional: dispatch debrief explorers

Dispatch explorer subagents in parallel for each post-execution topic that applies. Typical topics:

- `outcome-probe` — re-pull world state via whatever tools the harness exposes for this goal, to see post-execution outcome.
- `cross-operator-comparison` — the harness's history-of-runs query, if exposed, for similar runs by other operators. Read-only discovery (same as Orient's `others-history`); include it whenever the query is exposed.

Use the uniform dispatch shape; each explorer writes `workingDir/.debrief/<topic>.json`.

### Dispatch the analyst

Dispatch an analyst subagent. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body          = ${PLUGIN_ROOT}/skills/learn/analyst-prompt.md
goal                 = <copy of goal>
strategyPath         = workingDir/.strategize/strategy.json
constitutionPath     = workingDir/.strategize/constitution.json
planPath             = workingDir/.plan/plan.json
executeSummaryPath   = workingDir/.execute/summary.json
executeLogPath       = workingDir/.execute/log.jsonl
orientSummaryPath    = workingDir/.orient/summary.json
debriefExplorerPaths = [workingDir/.debrief/<topic>.json, ...]
ownHistoryPath       = implStateDir/runs/index.json (or null)
workingDir           = <path>
implStateDir         = <path, read-only>
outputPath           = workingDir/.debrief/analysis.json
msUntilDeadline      = <current value>
```

After it returns, verify `workingDir/.debrief/analysis.json` exists. If not, write `workingDir/.errors/debrief.json` and abort the pipeline. In `train` mode, still run section 9 before returning. In `frozen` mode, return without running section 9.

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 8. Improve

Purpose: mutate `implStateDir`, commit each accepted mutation as a separate git commit. Changes take effect NEXT run.

Run this section only when `mode = train`. If `mode = frozen`, skip it entirely and append a coordinator log entry noting `{ phase: "improve", status: "skipped", summary: "mode=frozen" }`.

Dispatch a promoter subagent. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body        = ${PLUGIN_ROOT}/skills/learn/promoter-prompt.md
goal               = <copy of goal>
analysisPath       = workingDir/.debrief/analysis.json
policyPath         = implStateDir/policy.json (or null)
implStateDir       = <path, read-write for the promoter>
workingDir         = <path>
outputDir          = workingDir/.improve/
msUntilDeadline    = <current value>
```

The promoter writes mutations directly into `implStateDir`, commits each as a separate git commit (the session-start hook configured the author identity already), and writes one `promotion_record` per mutation under `workingDir/.improve/promotions/`.

After it returns, read `workingDir/.improve/summary.json`. Verify:
- `implStateDirShaAfter` matches `git -C <implStateDir> rev-parse HEAD`
- One `promotion_record` per accepted change
- Operator-access requests under `workingDir/.operator-requests/` if any

If anything is inconsistent, write `workingDir/.errors/improve.json` and abort the pipeline, then still run section 9 before returning. This section only runs in `train` mode.

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 9. Memory consolidation

Purpose: curate `implStateDir` (prune unused, revert regressions) and `workingDir` (set public/private boundary); commit durable curation as one separate commit.

Run this section only when `mode = train`. If `mode = frozen`, skip it entirely and append a coordinator log entry noting `{ phase: "memory-consolidation", status: "skipped", summary: "mode=frozen" }`. Do not create durable commits or modify `implStateDir` in frozen mode.

Dispatch a consolidator subagent. Use the uniform dispatch shape with these role-specific inputs:

```
prompt body          = ${PLUGIN_ROOT}/skills/learn/consolidator-prompt.md
goal                 = <copy of goal>
analysisPath         = workingDir/.debrief/analysis.json
improveSummaryPath   = workingDir/.improve/summary.json
improvePromotionsDir = workingDir/.improve/promotions/
policyPath           = implStateDir/policy.json (or null)
implStateDir         = <path, read-write>
workingDir           = <path, read-write>
outputPath           = workingDir/.memory-consolidation/consolidation_record.json
msUntilDeadline      = <current value>
```

The consolidator does both workstreams (durable + ephemeral), writes a single git commit on `implStateDir` for the durable curation, and produces the `consolidation_record`.

After it returns, verify the `consolidation_record` exists. If the consolidator made a commit, `implStateDirShaAfter` must match `git -C <implStateDir> rev-parse HEAD`. If no commit was made (empty curation set), `implStateDirShaAfter` must equal `implStateDirShaBefore` and HEAD remains at that sha.

Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.

## 10. Verify and return

Before returning, assert each primary artifact exists:

- `workingDir/.orient/summary.json`
- `workingDir/.strategize/strategy.json`
- `workingDir/.plan/plan.json`
- `workingDir/.execute/summary.json`
- `workingDir/.debrief/analysis.json`
- `workingDir/.improve/summary.json`
- `workingDir/.memory-consolidation/consolidation_record.json`

When `mode = frozen`, do not require `workingDir/.improve/summary.json` or `workingDir/.memory-consolidation/consolidation_record.json`; those phases are skipped by contract.

Do NOT include any goal-kind-specific assertions. The harness owns goal-kind enforcement (e.g. domain-specific solution payloads). The plugin verifies only its own seven generic phase artifacts.

When the pipeline finishes — whether all sections completed cleanly, an abort signal fired, or a section reported failure — return. Never modify anything outside `implStateDir/**` or `workingDir/**`.

## 11. Failure handling

- **Within Execute (section 6):** that section judges `continue / retry-step / replan / abort` per its own rules.
- **Execute reporting `abort` is not a pipeline-level abort** — continue to Debrief and, in `train` mode only, Improve / Memory consolidation so partial work is analyzed and curated. The Execute section writes `workingDir/.errors/execute.json` itself.
- **Other sections:** if a section reports a hard problem, write `workingDir/.errors/<phase>.json` and abort the pipeline. In `train` mode, still run section 9 (Memory consolidation) so partial work gets curated. In `frozen` mode, do not run section 9.
- **Abort signal fired (deadline reached):** stop the current section cleanly, write `workingDir/.errors/abort.json`, and return. In `train` mode, run section 9 first if there is enough time and doing so does not violate the abort signal. In `frozen` mode, do not run section 9.

## Cross-reference

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
