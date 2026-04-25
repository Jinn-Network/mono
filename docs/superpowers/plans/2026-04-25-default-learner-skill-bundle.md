# Default learning restorer — Skill-bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **markdown-only skill bundle** that is the default learning restorer's actual product — one coordinator meta-skill plus seven phase skills, drop-in installable into any agent harness that supports skill loading + subagent spawning + filesystem + Bash. No TypeScript, no orchestrator class, no path-guard utility, no harness-adapter interface — those concepts live as instructions inside the skills themselves; harnesses provide the runtime via native tools (Skill, Agent, Bash, Read, Write, etc.).

**Architecture:** Eight `SKILL.md` files under `client/skills/`, each in its own directory matching the existing `jinn-operator` convention. The coordinator (`jinn-default-learner`) is the entry point invoked by the daemon; it sequences the seven phase skills (`jinn-orient`, `jinn-strategize`, `jinn-plan`, `jinn-execute`, `jinn-debrief`, `jinn-improve`, `jinn-memory-consolidation`) by spawning fresh-context subagents via the Agent tool — except Execute, which runs inline at session level because harnesses don't nest subagents (workers spawn from Execute, so Execute can't itself be a worker). State propagates by writing artifacts under `workingDir/.<phase>/` between phases. Self-modification + audit trail use git CLI directly on `implStateDir` from inside Improve / Memory consolidation skills.

**Tech Stack:** Markdown with YAML frontmatter (`name`, `description`, `allowed-tools`). Distribution: ships inside `@jinn-network/client` per the package's existing `"files": ["skills/", ...]`. No build step.

**Spec reference:** `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.

**Existing convention reference:** `client/skills/jinn-operator/SKILL.md` (frontmatter shape + body style).

---

## File structure

All paths relative to repo root (worktree `/Users/adrianobradley/harbor/jinn-learner/`):

| File | Role |
|---|---|
| `client/skills/jinn-default-learner/SKILL.md` | Coordinator meta-skill — entry point; sequences phases |
| `client/skills/jinn-default-learner/README.md` | What this bundle is, how to install per harness |
| `client/skills/jinn-orient/SKILL.md` | Phase 1 — gather intent + world-state + history |
| `client/skills/jinn-strategize/SKILL.md` | Phase 2 — pick approach, freeze success criteria + timing posture |
| `client/skills/jinn-plan/SKILL.md` | Phase 3 — concrete steps with optional time anchors |
| `client/skills/jinn-execute/SKILL.md` | Phase 4 — session-level; spawns workers per plan step |
| `client/skills/jinn-debrief/SKILL.md` | Phase 5 — post-execution analysis (own + others' history + outcomes) |
| `client/skills/jinn-improve/SKILL.md` | Phase 6 — write changes to `implStateDir`, git-commit, emit promotion records |
| `client/skills/jinn-memory-consolidation/SKILL.md` | Phase 7 — curate durable + ephemeral, separate git commit |

**Test/validation file:**

| File | Role |
|---|---|
| `client/scripts/validate-skill-frontmatter.mjs` | Smoke-validator — every SKILL.md must have `name`, `description`, `allowed-tools`; names must match directory names |

---

## Cross-skill conventions (read these before authoring any skill)

Every phase skill follows the same body structure:

1. **One-line purpose** (echoes the frontmatter `description`)
2. **Inputs** — what's already on disk under `workingDir/.<prior-phase>/` and what's in `implStateDir`
3. **Your job** — the work the agent does
4. **Parallelism** — when to spawn explorer/worker subagents vs do it inline
5. **Outputs** — files to write under `workingDir/.<this-phase>/`, with their JSON shape
6. **Boundaries** — what this phase does NOT do (and which other phase covers it)
7. **Cross-reference** — pointer to the spec section that grounds this phase

Frontmatter `allowed-tools` is conservative — each skill lists only the tools its body actually invokes.

Subagent-spawning convention: when the coordinator (or Execute) spawns a subagent via the Agent tool, the prompt is `"You are the <phase> phase of a Jinn restoration. Load the jinn-<phase> skill via the Skill tool and carry out the work it describes. Inputs: intent={...}, workingDir=<path>, implStateDir=<path>, msUntilEndTs=<n>, prior-phase outputs at <paths>."` This shape is identical across phases — only the phase name + inputs change.

---

## Task 1: Bundle directory + README

**Files:**
- Create: `client/skills/jinn-default-learner/README.md`

- [ ] **Step 1: Create the directory and write `README.md`**

```bash
mkdir -p client/skills/jinn-default-learner
```

`client/skills/jinn-default-learner/README.md`:

````markdown
# Jinn default-learner skill bundle

A drop-in skill bundle for running Jinn restoration intents end-to-end. Eight skills: one coordinator + seven phases.

## What this is

When a Jinn daemon dispatches an intent to the default-learner restorer, the harness loads this bundle. The agent invokes `jinn-default-learner`, which sequences the pipeline:

```
Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation
```

Each non-Execute phase runs as a fresh-context subagent that loads its own phase skill. Execute runs at session level and spawns per-step worker subagents.

## Skills in this bundle

| Skill | Phase |
|---|---|
| `jinn-default-learner` | Coordinator (entry point) |
| `jinn-orient` | Gather intent + world-state + history |
| `jinn-strategize` | Pick approach, freeze success criteria + timing posture |
| `jinn-plan` | Concrete steps, optionally time-anchored |
| `jinn-execute` | Session-level work; spawns per-step workers |
| `jinn-debrief` | Post-execution analysis |
| `jinn-improve` | Edit `implStateDir`, git-commit per change |
| `jinn-memory-consolidation` | Curate durable + ephemeral; separate git commit |

## Installing

These skills ship inside the `@jinn-network/client` npm package under `node_modules/@jinn-network/client/skills/`.

**Claude Code:**

```bash
mkdir -p ~/.claude/skills
for skill in jinn-default-learner jinn-orient jinn-strategize jinn-plan jinn-execute jinn-debrief jinn-improve jinn-memory-consolidation; do
  cp -r "$(npm root -g)/@jinn-network/client/skills/$skill" ~/.claude/skills/
done
```

**Pi.dev:**

```bash
mkdir -p ~/.pi/agent/skills
for skill in jinn-default-learner jinn-orient jinn-strategize jinn-plan jinn-execute jinn-debrief jinn-improve jinn-memory-consolidation; do
  cp -r "$(npm root -g)/@jinn-network/client/skills/$skill" ~/.pi/agent/skills/
done
```

For other harnesses, copy the eight skill directories into wherever your harness loads skills from.

## What the harness must provide

These skills assume the harness exposes (using Claude Code tool names; substitute equivalents on other harnesses):

- `Skill` — invoke a named skill in the current session (loads its content as instructions)
- `Agent` — spawn a fresh-context subagent with a prompt
- `Bash` — for git commands and any process invocation
- `Read`, `Write`, `Edit` — filesystem
- `Glob`, `Grep` — search
- A `wait` primitive — block until duration / deadline / condition (Claude Code: `Monitor`; Pi.dev: equivalent)

If your harness is missing any of the first six, this bundle won't work. The seventh (`wait`) gates time-anchored plans only — bundles can run without it for `early-return`-only kinds.

## What this bundle does NOT contain

- Kind-specific tools (HL MCP, prediction APIs, etc.) — those come from the Jinn daemon's MCP setup, not from these skills.
- Restorer registration — the Jinn daemon's `RestorerImpl` shim (separate plan) wires this bundle in via `buildRestorerImpls`.
- A `wait` primitive implementation — provided by the harness.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` (v1.1)
````

- [ ] **Step 2: Verify the file is well-formed markdown**

Run: `cd /Users/adrianobradley/harbor/jinn-learner && head -3 client/skills/jinn-default-learner/README.md`
Expected: shows the title heading.

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-default-learner/README.md
git commit -m "feat(default-learner): bundle README + install instructions"
```

---

## Task 2: Coordinator meta-skill

The entry point. Tells the agent how to sequence the seven phases.

**Files:**
- Create: `client/skills/jinn-default-learner/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

`client/skills/jinn-default-learner/SKILL.md`:

````markdown
---
name: jinn-default-learner
description: Use when running a Jinn restoration intent end-to-end. Sequences the seven-phase pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation). The Jinn daemon invokes this skill at the start of every restoration attempt for kinds that route to the default learner.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Jinn default-learner — coordinator

You are running one Jinn restoration intent end-to-end. This skill establishes the pipeline; sub-skills carry out each phase.

## Inputs (handed to you by the daemon)

- `intent` — `{ id, description, kind, window: { startTs, endTs }, spec, eligibility? }`
- `workingDir` — ephemeral; the engine harvests it for delivery when you return
- `implStateDir` — your operator-private durable self; persists across runs
- `msUntilEndTs` — function returning remaining time in the run window
- An abort signal that fires at `window.endTs`

## Boot

Before invoking phases:

1. **Load self-state.** Read `implStateDir/` to load any operator-promoted skills, hooks, tools, and configs from prior runs. Note what's there; the phase skills will reference it.
2. **Ensure `implStateDir` is a git repo** (idempotent):
   ```bash
   cd "$IMPL_STATE_DIR"
   if [ ! -d .git ]; then
     git init --initial-branch=main --quiet
     git config user.name "jinn-default-learner"
     git config user.email "default-learner@jinn.local"
     git commit --allow-empty -m "init implStateDir" --quiet
   fi
   ```
3. **Capture `implStateDir` HEAD sha.** Strategize will record it in the constitution. `git -C "$IMPL_STATE_DIR" rev-parse HEAD`.
4. **Note the `skill_bundle` CID.** Strategize will record it. If your harness doesn't have native CIDs for skill bundles, hash this directory with `find . -type f | sort | xargs sha256sum | sha256sum | cut -d' ' -f1`.

## Pipeline — invoke phases in this exact order

For each phase, write a one-line entry to `workingDir/.coordinator/log.jsonl` before invoking, and another after the phase returns. This gives Debrief a clean phase-boundary timeline.

### 1. Orient (subagent)

```
Use the Agent tool to spawn a fresh-context subagent with prompt:
"You are the Orient phase of a Jinn restoration. Load the jinn-orient
skill via the Skill tool and carry out the work it describes.
Inputs:
  intent = <copy of the intent>
  workingDir = <path>
  implStateDir = <path>
  msUntilEndTs = <current value>
Return a structured summary plus the artifact paths you wrote."
```

When it returns, read `workingDir/.orient/summary.json` and confirm the phase wrote its artifacts. Hold its returned summary for the next phase.

### 2. Strategize (subagent)

Same Agent-tool pattern, prompt names jinn-strategize, inputs include the Orient summary path. After return, read `workingDir/.strategize/strategy.json` and `workingDir/.strategize/constitution.json`.

### 3. Plan (subagent)

Same pattern. Inputs include the strategy path. After return, read `workingDir/.plan/plan.json`.

### 4. Execute (session-level — DO NOT spawn as subagent)

Load the jinn-execute skill via the Skill tool *in this session*. Workers (per-step subagents) spawn from inside Execute. You stay in-session because most harnesses (including Claude Code) don't permit nested subagent spawning — if Execute were a subagent, it couldn't spawn workers.

When Execute returns control, confirm `workingDir/.execute/` has its outputs.

### 5. Debrief (subagent)

Same pattern as Strategize. Inputs include all prior phase output paths.

### 6. Improve (subagent)

Same pattern. Improve will write to `implStateDir` and git-commit per change.

### 7. Memory consolidation (subagent)

Same pattern. Memory consolidation will git-commit again on `implStateDir` (separate commit).

## Returning

When all seven phases complete, return. The Jinn daemon will call its `walkArtifacts` packaging on `workingDir`. Do not modify anything outside `implStateDir/**` or `workingDir/**`.

If a phase reports a hard problem (Execute can decide `replan` and retry; other phases write an error artifact under `workingDir/.errors/<phase>.json` and abort the pipeline). On abort, still invoke Memory consolidation so partial work gets curated.

## Constitution span

After Strategize, the contents of `workingDir/.strategize/constitution.json` should be emitted as attributes on a `jinn.state_transition` span at run-start time. If your harness has an OTel tracer integration, do this. If not, the constitution.json file is itself the constitution record — Debrief reads it from there.

## Cross-reference

Spec: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1, sections §2, §10.
````

- [ ] **Step 2: Validate the frontmatter parses**

Run: `cd /Users/adrianobradley/harbor/jinn-learner && head -7 client/skills/jinn-default-learner/SKILL.md`
Expected: shows the YAML frontmatter block bounded by `---` markers with `name`, `description`, `allowed-tools` fields.

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-default-learner/SKILL.md
git commit -m "feat(default-learner): coordinator meta-skill"
```

---

## Task 3: jinn-orient

**Files:**
- Create: `client/skills/jinn-orient/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-orient
```

`client/skills/jinn-orient/SKILL.md`:

````markdown
---
name: jinn-orient
description: Use when the jinn-default-learner coordinator invokes the Orient phase. Gather intent + world-state + on-demand history before Strategize commits to an approach.
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

# Jinn Orient phase

Gather everything Strategize will need to commit to an approach. You are a fresh-context subagent — your only context is the prompt the coordinator handed you.

## Inputs

- `intent` — `{ id, description, kind, window, spec, eligibility? }`
- `workingDir` — write findings here
- `implStateDir` — read-only in this phase
- `msUntilEndTs` — remaining time in run window

## Your job

Decide for yourself what to gather based on the intent. Common reads, in priority order:

1. **Intent parse** — what's being asked? Resolve `intent.spec.kind`. If the intent has eligibility constraints, list them. If the spec carries kind-specific parameters (target ratios, prediction markets, etc.), capture them. Note `window.startTs` and `window.endTs`.
2. **World state** — for kinds with a venue (portfolio.v0 → Hyperliquid, prediction.v0 → Polymarket, prediction-apy.v0 → various lending venues, etc.), pull current relevant state via the kind's tools. Be conservative on volume — Strategize doesn't need raw history, just current snapshot + a couple of recent reference points.
3. **Own run history** — list prior runs of this kind by this operator. If `implStateDir/runs/index.json` exists, read it. Otherwise, attempt a subgraph query if the harness has access. Note success/failure trends and any flagged regressions.
4. **Others' run history** — only if the operator's policy file (`implStateDir/policy.json`) sets `allowCrossOperatorReads: true` AND the harness exposes a knowledge-tree query tool. Pull recent runs of this kind by other operators; annotate which evidence tier (`self-signed`, `committed`, `attested`) each carries.

## Parallelism

If gathering tasks are independent (intent parse, world-state, own history are typical), spawn explorer subagents in parallel via the Agent tool — one per task. Each gets a fresh context, gathers its slice, returns a structured summary. Synthesize their results into the final summary.

For very small intents (description-only health checks), do everything inline.

Each explorer's prompt should be of the form: `"You are an Orient explorer for topic <topic>. Gather <topic-specific specifics>. Write findings to workingDir/.orient/<topic>.json. Return: { summary: '...', artifactPath: '...', flags: ['...'] }."`

## Outputs

Under `workingDir/.orient/`:

- One file per explorer/topic — recommended names: `intent-parse.json`, `world-state.json`, `own-history.json`, `others-history.json`. Shape is topic-specific; include a top-level `topic` field for traceability.
- `summary.json` — your distillation, with the shape:
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
- Do not assume parallel explorers can spawn their own subagents — most harnesses (including Claude Code) don't permit nested subagents

## Cross-reference

Spec: §4.1.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-orient/SKILL.md
git commit -m "feat(default-learner): orient phase skill"
```

---

## Task 4: jinn-strategize

**Files:**
- Create: `client/skills/jinn-strategize/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-strategize
```

`client/skills/jinn-strategize/SKILL.md`:

````markdown
---
name: jinn-strategize
description: Use when the jinn-default-learner coordinator invokes the Strategize phase. Pick an approach for THIS run and freeze success criteria + timing posture.
allowed-tools: Bash, Read, Write
---

# Jinn Strategize phase

Pick the approach for this run and commit to it. You are a fresh-context subagent.

## Inputs

You can read:
- `workingDir/.orient/summary.json` and per-topic files — Orient's findings
- `implStateDir/strategies/<kind>/` — prior promoted strategies for this kind, if any
- `implStateDir/policy.json` — operator policy (timing-posture preferences, conservatism, etc.)
- The intent (handed in your prompt)

## Your job

**Diverge first.** Generate 2–4 candidate approaches given Orient's findings. For each, name:

- The angle (one sentence)
- What success would look like
- What could go wrong
- The timing posture this approach implies

**Converge second.** Pick one. Articulate the reason it beats the alternatives — the rationale, not just the pick.

**Freeze invariants for this run:**

- **Success criteria** — a concrete, measurable "we'll judge this attempt successful if X" statement. This is what Debrief judges against; do not redefine it later.
- **Timing posture** — exactly one of:
  - `early-return` — finish work and exit before window end. Default for kinds where late information doesn't help.
  - `hold-and-revise` — work, wait until late in the window, optionally revise based on world-state evolution, then exit.
  - `continuous-observation` — submit something early, monitor across the window, occasionally adjust, exit at end.
- **Acknowledged constraints + trade-offs** — explicit list, so Debrief has grounded attribution targets.

## Parallelism

Single subagent. Do not fan out — synthesis benefits from coherent reasoning.

## Outputs

Under `workingDir/.strategize/`:

- `strategy.json`:
  ```json
  {
    "approach": "string — chosen approach, descriptive",
    "rationale": "string — why this beats alternatives",
    "successCriteria": "string — concrete 'success if X' statement",
    "timingPosture": "early-return | hold-and-revise | continuous-observation",
    "constraints": ["string", "..."],
    "rejectedAlternatives": [
      { "approach": "string", "reason": "string" }
    ]
  }
  ```
- `constitution.json`:
  ```json
  {
    "successCriteriaCid": "sha256:<hex of successCriteria string>",
    "timingPosture": "...",
    "skillBundleCid": "<from coordinator boot>",
    "implStateDirSha": "<from coordinator boot>",
    "editableScope": ["<implStateDir>/**", "<workingDir>/**"]
  }
  ```

Compute `successCriteriaCid` via `printf '%s' "<successCriteria>" | sha256sum | cut -d' ' -f1` then prefix with `sha256:`.

Return to the coordinator: a one-paragraph statement of the chosen approach, success criteria, and timing posture, plus the paths to both files.

## Boundaries

- Do not gather more info — Orient already did
- Do not detail per-step actions — Plan does that
- Do not execute — Execute does that
- Do not modify `implStateDir`

## Cross-reference

Spec: §4.2, §10 (constitutional snapshot).
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-strategize/SKILL.md
git commit -m "feat(default-learner): strategize phase skill"
```

---

## Task 5: jinn-plan

**Files:**
- Create: `client/skills/jinn-plan/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-plan
```

`client/skills/jinn-plan/SKILL.md`:

````markdown
---
name: jinn-plan
description: Use when the jinn-default-learner coordinator invokes the Plan phase. Turn the strategy into concrete, ordered, optionally time-anchored execution steps.
allowed-tools: Bash, Read, Write
---

# Jinn Plan phase

Decompose the strategy into steps Execute can drive. You are a fresh-context subagent.

## Inputs

You can read:
- `workingDir/.strategize/strategy.json` — chosen approach + success criteria + timing posture + constraints
- `workingDir/.orient/summary.json` — for grounding
- `implStateDir/plans/<kind>/` — prior promoted plan templates for this kind, if any
- The intent

## Your job

Produce a plan Execute can follow without re-reading the strategy. Each step must be specific enough that a worker subagent can carry it out with no other context.

For each step, specify:

- A unique step id (`step-1`, `step-2`, ...)
- Sequential or parallelizable (a parallelizable step can run concurrently with the previous step's batch)
- Brief description (one sentence — what is the worker doing)
- Inputs the worker reads (paths or structured payloads)
- Tools / MCPs the worker needs
- Expected outputs (paths under `workingDir/`)
- Per-step success signals — how does the orchestrator know this step succeeded
- Per-step abort/recovery conditions

If the strategy's timing posture is `hold-and-revise` or `continuous-observation`, include one or more **time-anchored steps**:

- `wait` step — `{ kind: "wait", durationMs?: N, untilTs?: T, condition?: { kind: "...", ... } }`
- The orchestrator (Execute) honors these via the harness's `wait` primitive

## Parallelism

Single subagent. Do not fan out.

## Outputs

`workingDir/.plan/plan.json`:

```json
{
  "successCriteria": "<copied from strategy.json>",
  "timingPosture": "<copied>",
  "steps": [
    {
      "id": "step-1",
      "kind": "work | wait",
      "concurrency": "sequential | parallel-batch-A",
      "description": "string",
      "inputs": { "...": "..." },
      "toolsNeeded": ["string", "..."],
      "expectedOutputs": ["workingDir/<path>", "..."],
      "successSignal": "string — what proves this step succeeded",
      "abortCondition": "string — when to give up"
    }
  ]
}
```

For wait-kind steps, only the wait fields are required (no inputs/tools/outputs).

Return to the coordinator: a one-line summary ("plan with N steps, M parallel batches, K wait checkpoints") and the path to `plan.json`.

## Boundaries

- Do not change success criteria or timing posture — those were frozen in Strategize
- Do not execute — Execute does that
- Do not modify `implStateDir`

## Cross-reference

Spec: §4.3, §5 (timing model).
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-plan/SKILL.md
git commit -m "feat(default-learner): plan phase skill"
```

---

## Task 6: jinn-execute (session-level)

This is the only phase that runs in-session (not as a subagent). The coordinator loads it via the Skill tool, follows it, and stays in session while spawning workers.

**Files:**
- Create: `client/skills/jinn-execute/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-execute
```

`client/skills/jinn-execute/SKILL.md`:

````markdown
---
name: jinn-execute
description: Use when the jinn-default-learner coordinator reaches the Execute phase. Walk the plan, spawn worker subagents per step, honor wait steps, decide at runtime when stuck.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill
---

# Jinn Execute phase

This phase runs **at session level** — you are the coordinator, not a fresh subagent. Execute spawns workers; if Execute were itself a subagent, it could not spawn workers (most harnesses do not permit nested subagents).

## Inputs

You can read:
- `workingDir/.plan/plan.json` — the steps to drive
- `workingDir/.strategize/strategy.json` — the success criteria + timing posture
- `workingDir/.orient/summary.json` — for grounding
- The intent + window + remaining time budget

## Your job

Walk the plan. For each step:

### Work steps

Spawn a worker subagent via the Agent tool with a prompt scoped to that step only:

```
"You are a worker for step <id> of a Jinn restoration. Inputs: <step.inputs>.
Tools available: <step.toolsNeeded>. Your job: <step.description>.
Write outputs to: <step.expectedOutputs>. Return when you have written them
or when you cannot proceed (with an explanation)."
```

For parallel-batch steps, spawn the whole batch concurrently and wait for all to return before advancing.

After a worker returns:
- Check the success signal — did the step succeed by the plan's own criteria?
- If yes: log the step result to `workingDir/.execute/log.jsonl`, advance.
- If no: see "When stuck" below.

### Wait steps

Use the harness's `wait` primitive (Claude Code: `Monitor`; Pi.dev: equivalent — refer to your harness docs). Honor `durationMs`, `untilTs`, and `condition` per the plan step. The abort signal from the daemon (`window.endTs`) overrides any wait.

### When stuck

When a step fails its success signal or a worker returns without writing expected outputs, choose:

- **Continue** — accept the partial result if the plan tolerates it; advance.
- **Retry-step** — spawn a fresh worker for the same step. Cap retries at 2 unless the plan's `abortCondition` says otherwise.
- **Replan** — invoke the jinn-plan skill again with the failure as context to produce a revised plan, then resume Execute on the revised plan.
- **Abort** — write `workingDir/.errors/execute.json` with the failure context and exit Execute. The coordinator continues to Debrief / Improve / Memory consolidation so partial work is harvested and the failure is learned from.

The judgment is yours; explain it in `workingDir/.execute/log.jsonl`.

## Outputs

Throughout the phase:
- `workingDir/.execute/log.jsonl` — append one JSONL entry per step boundary: `{ ts, step, decision, summary, retryCount }`
- Per-step outputs as the plan declared (under `workingDir/...`)

At end of phase:
- `workingDir/.execute/summary.json`:
  ```json
  {
    "stepsCompleted": ["step-1", "step-2"],
    "stepsFailed": [],
    "decisions": ["continue", "retry-step", "continue", ...],
    "elapsedMs": 0,
    "returnReason": "all-steps-completed | hold-and-revise-window-end | abort"
  }
  ```

When complete, return control to the coordinator. The coordinator's session is still alive — it will invoke Debrief next.

## Delivery timing

The coordinator returns to the daemon when **all phases finish**, not when Execute finishes. The daemon harvests `workingDir` for delivery at that point. So Execute's `returnReason` mostly tells Debrief whether work completed cleanly, partially, or aborted — not when delivery happens.

## Boundaries

- Do not invoke jinn-strategize — strategy is frozen
- Do not write to `implStateDir` — that's Improve's job
- Do not run Debrief / Improve / Memory consolidation — coordinator does that after you return
- Do not call `wait()` for arbitrarily long with no plan justification — every wait must come from a plan step or be a bounded retry

## Cross-reference

Spec: §4.4, §5 (timing model).
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-execute/SKILL.md
git commit -m "feat(default-learner): execute phase skill (session-level)"
```

---

## Task 7: jinn-debrief

**Files:**
- Create: `client/skills/jinn-debrief/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-debrief
```

`client/skills/jinn-debrief/SKILL.md`:

````markdown
---
name: jinn-debrief
description: Use when the jinn-default-learner coordinator invokes the Debrief phase. Post-execution analysis — read this run + prior runs + others' runs (when accessible) + fresh world-state, produce diagnosis Improve can act on.
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

# Jinn Debrief phase

Mirrors Orient — gather + sense-make in hindsight. You are a fresh-context subagent.

## Inputs

You can read:
- `workingDir/.execute/summary.json` + `log.jsonl` — what just happened
- `workingDir/.plan/plan.json` — what was intended
- `workingDir/.strategize/strategy.json` + `constitution.json` — the frozen criteria + timing posture
- `workingDir/.orient/summary.json` — pre-execution context
- All step outputs under `workingDir/...` produced by Execute
- `implStateDir/runs/` — prior runs by this operator (if cached)
- The knowledge tree via subgraph (if the harness exposes it) — others' runs of this kind, optionally filtered by evidence tier
- Fresh world-state — re-pull venue / market / on-chain state to see post-execution outcome

## Your job

Produce an analysis Improve can act on. Cover four things:

1. **Did this run meet its success criteria?** Compare `workingDir/.execute/...` outputs against `successCriteria` from `strategy.json`. Yes / no / partial. If partial, where did it fall short?
2. **Where did execution diverge from plan, and why?** Walk `log.jsonl`. For each retry / replan / abort decision, attribute the cause: prompt? tool choice? subagent delegation? model limitation? insufficient context? plan was wrong? world-state changed?
3. **What signals from others' runs are relevant?** If you queried the knowledge tree: were others doing this kind successfully with a different approach? Are there patterns in the attested-tier corpus that suggest this run's approach was suboptimal?
4. **Trend — am I improving at this kind?** Compare against own prior runs. Pull last 5–10 by this operator for this kind. Trending up, flat, down? Note any specific kind+intent shape that this operator does poorly on.

## Parallelism

Can fan out: one explorer for own-history reading, one for cross-operator query, one for world-state probe, one for diagnosis-of-this-run. Synthesizer combines. Or do it inline if the data is small. Same prompt convention as Orient explorers.

## Outputs

Under `workingDir/.debrief/`:

- `analysis.json`:
  ```json
  {
    "successCriteriaMet": "yes | no | partial",
    "successCriteriaShortfall": "string — null if met",
    "divergencesFromPlan": [
      {
        "stepId": "step-3",
        "what": "string",
        "attributedCause": "prompt | tool-choice | delegation | model | context | plan-wrong | world-state-changed",
        "evidence": "string"
      }
    ],
    "crossOperatorSignals": [
      {
        "envelopeCid": "...",
        "tier": "attested | committed | self-signed",
        "lesson": "string"
      }
    ],
    "trend": {
      "kind": "...",
      "lastNRuns": 10,
      "passRate": 0.6,
      "direction": "improving | flat | declining",
      "notableFailureShapes": ["string", "..."]
    },
    "recommendationsForImprove": [
      "string — concrete suggestion (e.g. 'add a retry-on-stale-quote skill', 'tighten the slippage threshold in workflow.yaml')"
    ]
  }
  ```
- One file per explorer/topic if you fanned out (e.g., `own-history.json`, `cross-operator.json`, `world-state-post.json`).

Return to the coordinator: a one-paragraph plain-English summary plus the path to `analysis.json`.

## Boundaries

- Do not change `successCriteria` — they were frozen in Strategize and are what you're judging against
- Do not modify `implStateDir` — Improve does that
- Do not invent recommendations not grounded in this run + history — every recommendation needs a basis in the analysis

## Cross-reference

Spec: §4.5.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-debrief/SKILL.md
git commit -m "feat(default-learner): debrief phase skill"
```

---

## Task 8: jinn-improve

**Files:**
- Create: `client/skills/jinn-improve/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-improve
```

`client/skills/jinn-improve/SKILL.md`:

````markdown
---
name: jinn-improve
description: Use when the jinn-default-learner coordinator invokes the Improve phase. Edit / add / create skills, hooks, tools, configs under implStateDir based on Debrief; git-commit per change. Changes take effect NEXT run.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Jinn Improve phase

Act on the Debrief analysis by mutating `implStateDir`. You are a fresh-context subagent.

**Critical:** changes take effect on the **next run**, not this one. The current run already happened under the old `implStateDir` state; Strategize's frozen criteria were judged under it. Mutating mid-run would invalidate the causal chain Debrief just produced.

## Inputs

You can read:
- `workingDir/.debrief/analysis.json` — recommendations + trend
- `implStateDir/` — current durable self
- `implStateDir/policy.json` — operator policy (what Improve may touch, retention rules)
- The intent (for context — Improve's changes can be scoped to this kind)

## Action surface

Allowed targets, in increasing risk order:

1. **Skill edits** — modify `implStateDir/skills/<name>/SKILL.md` to refine prompts, success signals, etc.
2. **Hook edits** — modify `implStateDir/hooks/*.sh` (if the harness reads them)
3. **Tool config edits** — modify `implStateDir/configs/<name>.json` (e.g., MCP tool configs, threshold parameters)
4. **New skills / hooks / configs** — add files, not just edit
5. **New tool source** — write a new tool implementation under `implStateDir/tools/<name>/` (TS/JS/etc.) that the harness can register
6. **Operator-access requests** — emit deferred artifacts under `workingDir/.operator-requests/<name>.json` describing things you'd like the operator to add (new MCP servers, API keys, RPC URLs, etc.). Never blocks — the operator reviews these between runs.
7. **Harness install patches** — only if the harness adapter (separate, daemon-side) explicitly permits and `policy.json` allows. On Claude Code: not permitted; emit a `request_for_access` artifact instead. On Pi.dev / Codex: may be allowed.

Anywhere outside `implStateDir/**` and `workingDir/**` is forbidden. The harness adapter (daemon-side) enforces this; you should not even attempt it.

## Your job

For each Debrief recommendation, decide:

- Is this change worth making? (Some recommendations may be too speculative; ignore them.)
- Which target category does it fall into?
- What's the minimal change that addresses it?

Then, **for each accepted change**:

1. Make the change (edit / write the file).
2. Stage and commit:
   ```bash
   cd "$IMPL_STATE_DIR"
   git add -A
   git commit -m "improve: <one-line description>

   Run: <intent.id>
   Cause: <attributed cause from Debrief>
   Recommendation: <Debrief recommendation source>" --quiet
   ```
3. Record a `promotion_record` under `workingDir/.improve/promotions/`:
   ```json
   {
     "ts": <unix-ms>,
     "implStateDirShaBefore": "<from prior run / coordinator boot>",
     "implStateDirShaAfter": "<git rev-parse HEAD post-commit>",
     "changeKind": "skill-edit | hook-edit | config-edit | new-skill | new-tool | operator-request",
     "target": "implStateDir/<path> | workingDir/.operator-requests/<name>.json",
     "summary": "string",
     "debriefSource": "string — pointer into analysis.json"
   }
   ```

Promotions emit one commit each so `git log` and `git revert` operate on logical changes.

## Operator-access requests

If a recommendation requires something only the operator can grant (a new venue API key, expanded RPC access, additional MCP server install, etc.), don't try to take it — emit:

```json
{
  "ts": <unix-ms>,
  "what": "string — what's needed",
  "why": "string — Debrief grounding",
  "howToGrant": "string — concrete steps the operator should take",
  "blocksKinds": ["portfolio.v0"]
}
```

Under `workingDir/.operator-requests/<short-name>.json`. The daemon's harvest surfaces these to the operator UI between runs.

## Parallelism

Single subagent. Promotion is a series of decisions; don't parallelize.

## Outputs

Under `workingDir/.improve/`:
- `promotions/<n>.json` — one per change made
- `summary.json`:
  ```json
  {
    "implStateDirShaBefore": "...",
    "implStateDirShaAfter": "...",
    "changesAccepted": <count>,
    "changesRejected": <count>,
    "operatorRequests": <count>,
    "rejectionsRationale": [{ "recommendation": "string", "reason": "string" }]
  }
  ```

Return to the coordinator: a one-paragraph summary of what changed (or didn't) and why.

## Boundaries

- Never write outside `implStateDir/**` (except `workingDir/.improve/` and `workingDir/.operator-requests/`)
- Never do anything that should take effect this run — every change is for next run
- Don't accept recommendations that the trend signal contradicts (e.g., don't add a skill that previously got reverted)

## Cross-reference

Spec: §4.6, §6.2 (git-backed implStateDir), §6.4 (mid-run mutation rule), §7.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-improve/SKILL.md
git commit -m "feat(default-learner): improve phase skill"
```

---

## Task 9: jinn-memory-consolidation

**Files:**
- Create: `client/skills/jinn-memory-consolidation/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```bash
cd /Users/adrianobradley/harbor/jinn-learner && mkdir -p client/skills/jinn-memory-consolidation
```

`client/skills/jinn-memory-consolidation/SKILL.md`:

````markdown
---
name: jinn-memory-consolidation
description: Use when the jinn-default-learner coordinator invokes the Memory consolidation phase. Curate durable (implStateDir) and ephemeral (workingDir public/private) state; commit consolidation changes as a separate git commit on implStateDir.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Jinn Memory consolidation phase

Curate state. Two workstreams. You are a fresh-context subagent.

## Inputs

You can read:
- `workingDir/.debrief/analysis.json` — trend signals, regression flags
- `workingDir/.improve/summary.json` + `promotions/` — what Improve just changed
- `implStateDir/` — full current durable self
- `workingDir/` — full current ephemeral state
- `implStateDir/policy.json` — retention rules, size caps, prune thresholds

## Workstream 1 — Curate durable self (`implStateDir`)

Now that Improve added/edited stuff, what's stale on the other end?

- **Unused skills / hooks / tools** — anything not invoked in the last N runs (default N=20; check `implStateDir/policy.json` for override). Move to `implStateDir/.archive/<ts>/` or delete per policy.
- **Regressed promotions** — if the trend in `analysis.json` indicates a recent change made things worse, `git revert` it. Be specific: revert the exact commit identified, not a bulk rollback.
- **Noisy notes / records** — if `implStateDir/notes/` has accumulated more than `policy.maxNotesBytes` (default 1 MB), compact: keep the last K (default K=50) by mtime, archive the rest.
- **Conflicts between recent promotions** — Improve may have promoted two skills with conflicting prompts. Detect and resolve (favor newer; flag the conflict in `consolidation_record`).

After all durable curation, commit the consolidation as ONE commit on `implStateDir`:

```bash
cd "$IMPL_STATE_DIR"
git add -A
git commit -m "consolidate: <one-line summary>

Pruned: <n> | Reverted: <n> | Compacted: <n> | Conflicts resolved: <n>

Run: <intent.id>" --quiet
```

This is intentionally one commit, distinct from Improve's per-change commits — so `git log` shows the two intents separately.

## Workstream 2 — Curate ephemeral run (`workingDir`)

Decide what's harvestable for delivery vs operator-private:

- **Declared kind outputs** — must remain at the harvestable paths the kind contract expects (don't move).
- **Per-phase artifacts** under `workingDir/.<phase>/` — generally harvestable as trajectory signal; can stay as-is.
- **Session transcripts containing operator-private reasoning** — if a worker subagent's transcript reveals proprietary strategy details, move under `workingDir/.private/<phase>/` or migrate to `implStateDir/transcripts/<runId>/`.
- **Operator-requests** under `workingDir/.operator-requests/` — these are operator-private, never delivery; move to `implStateDir/operator-requests/<runId>/`.
- **Errors** under `workingDir/.errors/` — keep public (buyers benefit from honest failure signal).

The engine's `walkArtifacts` will harvest whatever remains under `workingDir` per the kind's output contract; you've set the public/private boundary by where you place files.

## Parallelism

Single subagent.

## Outputs

Under `workingDir/.memory-consolidation/`:
- `consolidation_record.json`:
  ```json
  {
    "ts": <unix-ms>,
    "implStateDirShaBefore": "<from Improve summary>",
    "implStateDirShaAfter": "<git rev-parse HEAD post-consolidation-commit>",
    "durable": {
      "skillsArchived": ["string", "..."],
      "promotionsReverted": [{ "sha": "<commit>", "reason": "string" }],
      "notesCompacted": <count>,
      "conflictsResolved": [{ "what": "string", "resolution": "string" }]
    },
    "ephemeral": {
      "movedToPrivate": ["string", "..."],
      "migratedToImplState": ["string", "..."]
    }
  }
  ```

Return to the coordinator: a one-paragraph summary of what was pruned, archived, reverted, moved.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or Debrief output — those are run history, untouchable
- Do not delete declared kind outputs from `workingDir`
- Do not git-commit anything that wasn't in either Improve's mutation set or this consolidation's curation set

## Cross-reference

Spec: §4.7, §6.1 (public/private boundary).
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/skills/jinn-memory-consolidation/SKILL.md
git commit -m "feat(default-learner): memory consolidation phase skill"
```

---

## Task 10: Frontmatter validator + acceptance run

A small Node script checks every SKILL.md has valid frontmatter and that `name` matches the directory name.

**Files:**
- Create: `client/scripts/validate-skill-frontmatter.mjs`

- [ ] **Step 1: Write the validator**

`client/scripts/validate-skill-frontmatter.mjs`:

```javascript
#!/usr/bin/env node
// Validate SKILL.md frontmatter for the default-learner bundle.
// Fails (exit 1) on any error; reports each finding.
//
// Required fields: name, description, allowed-tools.
// Required match: frontmatter `name` equals the parent directory name.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_ROOT = new URL('../skills/', import.meta.url).pathname;
const REQUIRED_FIELDS = ['name', 'description', 'allowed-tools'];
const BUNDLE_NAMES = [
  'jinn-default-learner',
  'jinn-orient',
  'jinn-strategize',
  'jinn-plan',
  'jinn-execute',
  'jinn-debrief',
  'jinn-improve',
  'jinn-memory-consolidation',
];

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    out[key] = val;
  }
  return out;
}

let errors = 0;
for (const name of BUNDLE_NAMES) {
  const dir = join(SKILLS_ROOT, name);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    console.error(`MISSING: ${dir}`);
    errors++;
    continue;
  }
  if (!stat.isDirectory()) {
    console.error(`NOT_DIR: ${dir}`);
    errors++;
    continue;
  }
  const skillFile = join(dir, 'SKILL.md');
  let text;
  try {
    text = readFileSync(skillFile, 'utf8');
  } catch {
    console.error(`MISSING: ${skillFile}`);
    errors++;
    continue;
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    console.error(`NO_FRONTMATTER: ${skillFile}`);
    errors++;
    continue;
  }
  for (const f of REQUIRED_FIELDS) {
    if (!fm[f]) {
      console.error(`MISSING_FIELD ${f}: ${skillFile}`);
      errors++;
    }
  }
  if (fm.name && fm.name !== name) {
    console.error(`NAME_MISMATCH: ${skillFile} — frontmatter name="${fm.name}" but dir="${name}"`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s)`);
  process.exit(1);
}
console.log(`OK — ${BUNDLE_NAMES.length} skills validated`);
```

- [ ] **Step 2: Run the validator**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
node scripts/validate-skill-frontmatter.mjs
```

Expected: `OK — 8 skills validated`

If anything fails, fix the offending SKILL.md and re-run.

- [ ] **Step 3: Add a yarn script alias**

Modify `client/package.json` to add a `validate-skills` script. Use the Edit tool to add the entry under `"scripts"`:

```json
"validate-skills": "node scripts/validate-skill-frontmatter.mjs"
```

After editing, verify:
```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn validate-skills
```
Expected: `OK — 8 skills validated`

- [ ] **Step 4: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/scripts/validate-skill-frontmatter.mjs client/package.json
git commit -m "test(default-learner): skill bundle frontmatter validator"
```

---

## Plan acceptance

When all 10 tasks are committed:

- [ ] `cd client && yarn validate-skills` returns `OK — 8 skills validated`
- [ ] All eight `client/skills/jinn-<name>/SKILL.md` files exist with required frontmatter and bodies covering: purpose, inputs, your job, parallelism, outputs, boundaries, cross-reference
- [ ] `client/skills/jinn-default-learner/README.md` describes install instructions for at least Claude Code and Pi.dev
- [ ] No TypeScript was added; no entry in `buildRestorerImpls` was touched; daemon behavior is unchanged
- [ ] An operator can `cp -r` the eight skill directories into their harness's skill dir per the README, and a manual session-start of jinn-default-learner inside the harness will read the skills and follow them (full end-to-end with a real intent comes in Plan 2 — needs the daemon-side shim to dispatch)

---

## What Plan 2 will pick up

- TypeScript `RestorerImpl` shim (`client/src/restorer/impls/default-learner/restorer.ts`) — small, ~50–100 lines — that spawns the harness CLI with this skill bundle loaded and an initial prompt invoking `jinn-default-learner` with the intent + paths
- Per-harness shim variants if needed (Claude Code first; Pi.dev later)
- Optional `jinn install-skills <harness>` CLI command that does the `cp -r` for the operator
- Real OTel tracing integration if the harness exposes a tracer (the constitution span emission)

## What Plan 3 will pick up

- `buildRestorerImpls` registry wiring per spec §12 first-match-wrapper recommendation (or whichever option locks)
- Portfolio.v0 end-to-end acceptance test on Anvil fork
- Replan-path acceptance test
- Out-of-scope-write block test (synthetic worker tries to write outside `implStateDir`/`workingDir`; harness/adapter rejects it)
