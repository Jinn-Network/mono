# claude-code-learner plugin simplification + harness-decoupling — design spec

**Version:** 1.1
**Date:** 2026-05-06
**Author:** adrianobradley + Claude
**Tracks:** `jinn-mono-2zk`
**Supersedes:** v1.0 (2026-05-06) — same file; prior commit in git history. v1.0 covered only the layout simplification; v1.1 adds full Jinn-vocabulary decoupling per design discussion 2026-05-06.

**Related:**

- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1 — defines the seven-phase pipeline, artifact contracts, and constitution span. **The pipeline semantics, artifact paths, and JSON shapes are unchanged.** The vocabulary used to describe them in plugin prose is what changes here.
- `client/plugins/claude-code-learner/` — current plugin layout (8 skills + 7 agents + 1 hook).
- `client/src/harnesses/impls/claude-code-learner/adapters/claude-code.ts` — Claude Code harness adapter (translates Jinn-side concepts to plugin-side inputs).
- `client/src/harnesses/impls/claude-code-learner/harvest.ts` — Jinn-side artifact harvester; owns solverType-specific enforcement.
- Upstream reference: `obra/superpowers@main` — the conventional shape for a skill that orchestrates subagent dispatches (`skills/subagent-driven-development/` with sibling prompt files).

---

## 1. Purpose

Two changes, landed together because they touch the same files:

1. **Layout simplification.** Replace the 8 skills + 7 agent role files + a coordinator-loads-phase-skill-dispatches-named-subagent triple-hop with one orchestrator skill (`skills/learn/`) and seven sibling subagent prompts. Matches the convention upstream `obra/superpowers` uses for `subagent-driven-development`. Removes the parallel `agents/` registry. Improves portability across harnesses (Claude Code, Codex, Gemini CLI, OpenCode) by avoiding reliance on Claude Code's named-subagent registry.

2. **Jinn-vocabulary decoupling.** The plugin currently embeds Jinn-specific concepts (`solverType`, `prediction.v1`, "restoration intent," `Polymarket`/`HL` tool examples, `walkArtifacts`, `jinn.state_transition` span name, the `JINN_*` env var prefix) inside its prompt content. The plugin should be **agnostic to the goal it's learning toward and to the harness running it**: it takes a goal description, runs the seven-phase loop, learns across runs. Other domains' specifics belong in domain-specific plugins (e.g. `jinn-prediction-plugin/`) or in the harness layer (`harvest.ts` already owns the prediction.v1 contract).

Both threads preserve every existing artifact path, every JSON shape, every phase-flow rule. The pipeline doesn't change; the file structure and prose around it do.

---

## 2. Scope and non-goals

**In scope:**

- Restructure `client/plugins/claude-code-learner/` from 8 skills + 7 agents to 1 skill (`skills/learn/`) + 7 sibling prompt files.
- Strip Jinn-specific vocabulary from every plugin file (skills, agents-now-prompts, hooks, plugin.json description, README/CLAUDE/AGENTS docs).
- Rename `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE` everywhere it appears (plugin docs, harvester, types, tests).
- Rename the SessionStart hook's git-author email `claude-code-learner@jinn.local` → `claude-code-learner@local`.
- Update the harness adapter's initial prompt: invoke `claude-code-learner:learn`, drop solverType-specific lines, use generic input names (`goal`, not `task`/`intent`).
- Update plugin-level docs (`README.md`, `CLAUDE.md`, `AGENTS.md`) to describe a generic plugin without Jinn framing.

**Out of scope (explicit non-goals):**

- Daemon code changes outside the harness adapter and harvester. The daemon stays runtime-agnostic.
- Adapter env-var contract beyond the one rename above. Names like `IMPL_STATE_DIR`, `WORKING_DIR`, `DAEMON_API_URL`, `DESIRED_STATE_*`, `RESTORATION_REQUEST_ID` are set by the adapter as the plugin's runtime environment; renaming them ripples into many tests and harness layers and is its own follow-up. The plugin's *prose content* doesn't reference those names by string, so the plugin is decoupled regardless.
- Phase semantics, artifact paths under `workingDir/.<phase>/`, JSON schemas, the constitution-span design, the `pre-execute`/`post-execute` phase-range protocol semantics, or any subagent's role *behavior*. Each subagent's prompt body moves locations, gets vocabulary normalized, and gets minor frontmatter normalization, but its instructions, inputs, outputs, and boundaries stay verbatim.
- Per-phase `allowed-tools` frontmatter on the orchestrator. Tool scoping moves down a level: subagents (which is where actual tool work happens) keep their tool restrictions; the orchestrator skill grants the union.
- Renaming the plugin itself or the input field name `intent` → `goal` at the *harness adapter / TypeScript* level. Inside plugin prose we use the word "goal" because that's what the plugin sees conceptually; the adapter still has a TypeScript field named `taskBody` (or whatever) — that contract is unchanged.

---

## 3. Layering recap (constraint that drives the design)

Three nested layers:

1. **Daemon** (`client/src/`) — runtime-agnostic. Spawns a harness session with a goal, working dir, state dir, and deadline; harvests artifacts on exit. Knows nothing about phases or learning loops.
2. **Harness adapter + harvester** (`client/src/harnesses/impls/claude-code-learner/`) — the *Jinn-aware* layer. Translates Jinn concepts (intent, solverType, restoration, daemon API) into plugin-side inputs (a generic goal). Owns solverType-specific artifact enforcement (`harvest.ts:398` already throws if `prediction.v1` is missing its solution JSON).
3. **Plugin** (`client/plugins/claude-code-learner/`) — generic. Defines the seven-phase learning loop. Loaded into whatever harness is running. **Knows nothing about Jinn, solverTypes, or the surrounding protocol.** Takes a goal, runs the loop, mutates `implStateDir` to learn across runs.

The simplification target is layer 3 only. Layers 1 and 2 are touched only to:
- Update the harness adapter's initial prompt string.
- Rename one env var (`JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE`) in the harvester, types, and tests.

---

## 4. Target plugin layout

```
client/plugins/claude-code-learner/
├── .claude-plugin/
│   └── plugin.json                  # description rewritten to be generic; author preserved
├── hooks/
│   ├── hooks.json                   # unchanged
│   └── session-start                # author email → claude-code-learner@local
├── skills/
│   └── learn/
│       ├── SKILL.md                 # the orchestrator (replaces coordinator + 7 phase skills)
│       ├── explorer-prompt.md       # was agents/explorer.md (vocabulary scrubbed)
│       ├── strategist-prompt.md     # was agents/strategist.md (scrubbed)
│       ├── planner-prompt.md        # was agents/planner.md (scrubbed)
│       ├── step-worker-prompt.md    # was agents/step-worker.md (scrubbed)
│       ├── analyst-prompt.md        # was agents/analyst.md (scrubbed)
│       ├── promoter-prompt.md       # was agents/promoter.md (scrubbed)
│       └── consolidator-prompt.md   # was agents/consolidator.md (scrubbed)
├── README.md                         # rewritten generic
├── CLAUDE.md                         # rewritten generic
└── AGENTS.md                         # rewritten generic
```

**Removed:** `skills/coordinator/`, `skills/{orient,strategize,plan,execute,debrief,improve,memory-consolidation}/` (8 dirs), `agents/` (7 files).

**Added:** `skills/learn/SKILL.md`, `skills/learn/<role>-prompt.md` (×7).

Net file count: 8 SKILL.md + 7 agent files = 15 → 1 SKILL.md + 7 prompt files = 8.

---

## 5. `skills/learn/SKILL.md` structure

The orchestrator is one document the harness loads and the model executes end-to-end.

### 5.1 Frontmatter

```yaml
---
name: learn
description: Use when running a goal end-to-end through a seven-phase learning loop. Sequences Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation, dispatching specialized subagents per phase, and improves itself between runs by mutating its own state directory.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
---
```

`Task` is the harness's generic-subagent-dispatch primitive. The body is written tool-neutrally ("spawn a fresh-context subagent with the prompt body from `<file>`") so the same skill works on any harness that exposes any subagent primitive.

### 5.2 Inputs

The orchestrator binds these from the harness's session inputs (passed via the harness adapter's initial prompt or environment):

- `goal` — `{ id, description, kind?, deadline?, spec? }`. Free-form payload that describes what to achieve. The plugin reads `description` to know the task and may organize prior runs by `kind` if present.
- `workingDir` — ephemeral path; the harness harvests it for delivery when the orchestrator returns.
- `implStateDir` — the agent's persistent self-state. Git-backed by the SessionStart hook. Mutations here persist across runs and constitute "learning."
- `msUntilDeadline` — function returning remaining time.
- An abort signal that fires at the goal's deadline (if any).

The plugin does **not** know what `goal.kind` means semantically; it's an opaque string used for organizing artifacts.

### 5.3 Body sectioning

```
1. Boot                   — bind session inputs; write boot.json
2. Phase-range guard      — branch on LEARNER_PHASE_RANGE env var (if set)
3. Orient                 — dispatch parallel explorer-prompt subagents per topic; collate summary
4. Strategize             — dispatch strategist-prompt subagent; freeze constitution
5. Plan                   — dispatch planner-prompt subagent; persist plan.json
6. Execute                — walk plan; per work step dispatch step-worker-prompt subagent
                            (decide continue/retry-step/replan/abort inline)
7. Debrief                — optional explorer-prompt subagents for post-execution probes;
                            dispatch analyst-prompt subagent
8. Improve                — dispatch promoter-prompt subagent; commit implStateDir mutations
9. Memory consolidation   — dispatch consolidator-prompt subagent
10. Verify and return     — assert primary artifact for each completed phase exists; return.
11. Failure handling      — same semantics as today's coordinator
```

Each section is short. The bulk content (subagent instructions) lives in its sibling `*-prompt.md`. The orchestrator section says "spawn with prompt at `<file>`, pass these inputs, expect this output path."

### 5.4 Subagent dispatch pattern

Uniform across all sections:

```
Spawn a fresh-context subagent with the prompt body from
${PLUGIN_ROOT}/skills/learn/<role>-prompt.md. Pass these inputs:

  goal                = <copy>
  workingDir          = <path>
  implStateDir        = <path, read-only unless this role mutates it>
  outputPath          = workingDir/.<phase>/<artifact>.json
  msUntilDeadline     = <current value>
  ... role-specific inputs ...

The subagent reads the prompt, follows it, writes outputPath, and returns
a one-line summary plus artifactPath.
```

Claude Code's `Agent` tool with `subagent_type:` is **not** used. The named-subagent registry is intentionally avoided.

### 5.5 Phase-range branching

Read the optional env var `LEARNER_PHASE_RANGE`:

- `pre-execute` — run sections 3–5 only (Orient, Strategize, Plan), then return. Lets the harness wrap a domain-specialist Execute path between meta-pre and meta-post.
- `post-execute` — run sections 7–9 only (Debrief, Improve, Memory consolidation). The harness has already populated `workingDir/.execute/` from the specialist.
- unset / `full` — run all eleven sections.

### 5.6 Verify-and-return checklist

Before returning, assert each primary artifact exists:

- `workingDir/.orient/summary.json`
- `workingDir/.strategize/strategy.json`
- `workingDir/.plan/plan.json`
- `workingDir/.execute/summary.json`
- `workingDir/.debrief/analysis.json`
- `workingDir/.improve/summary.json`
- `workingDir/.memory-consolidation/consolidation_record.json`

**No goal-kind-specific assertions.** The harness owns goal-kind enforcement (e.g. `client/src/harnesses/impls/claude-code-learner/harvest.ts:398` already throws if `prediction.v1`'s solution JSON is missing). The plugin verifies only its own seven generic phase artifacts.

Return when the pipeline finishes — whether all sections completed cleanly, an abort signal fired, or a section reported failure. Never modify anything outside `implStateDir/**` or `workingDir/**`.

### 5.7 Constitution span

After Strategize, read `workingDir/.strategize/constitution.json`. If the harness exposes an OTel tracer, emit the constitution fields as attributes on a state-transition span (the harness defines the span name). Otherwise the file itself is the constitution record. The plugin does not hardcode a span name like `jinn.state_transition`.

---

## 6. Subagent prompt files

Each `*-prompt.md` is the body of an `agents/<role>.md` file from today, with these changes:

1. **Frontmatter normalized.** Drop the `name:` field (sibling prompts are not registered subagent types). Keep `description` as a one-line "what this prompt is for" header. Keep `tools:` as documentation of intended tool scope.
2. **Vocabulary scrubbed.** Apply the substitutions listed below.
3. **Cross-references updated.** Any "the coordinator skill" or "your spawning skill" → "the dispatching section of `skills/learn/SKILL.md`."

**Vocabulary substitutions (apply to every prompt file's body):**

| Replace | With | Reason |
|---|---|---|
| `intent` (in plugin-input sense) | `goal` | Generic English; matches the spec input name. |
| `restoration intent` / `restoration` | `goal` | "Restoration" is a Jinn protocol concept. |
| `solverType` | `goal.kind` (or drop if not load-bearing) | The plugin organizes by kind opaquely; doesn't reason about the value. |
| `Jinn` / `Jinn daemon` / `the daemon` | `the harness` | The plugin is harness-agnostic. |
| `walkArtifacts` (mention) | "the harness's artifact harvester" | Implementation name leaks into prose. |
| "knowledge-tree query" | "the harness's history-of-runs query, if exposed" | Tool name leaks into prose. |
| `HL`, `Polymarket`, `on-chain`, "venue / market" examples | "whatever tools the harness exposes for this goal" | Domain-specific examples bind the plugin to predictions/finance. |
| `prediction.v0`, `prediction.v1`, `portfolio.v0` | (drop the example list entirely) | Specific solverTypes shouldn't appear. |
| `jinn.state_transition` | "a state-transition span (name defined by harness)" | Span-name binding. |
| `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` | `LEARNER_PHASE_RANGE` | Drop Jinn from env var name. |
| `RestorerImpl`, `buildRestorerImpls` | (drop entirely) | These are TypeScript-side names, not plugin concerns. |

Subagent **behavior** (inputs, outputs, boundaries, the actual instructions) is preserved verbatim except for the vocabulary substitutions above. No new logic, no removed checks beyond those flagged in the table.

Mapping (current → new):

| Current path | New path |
|---|---|
| `agents/explorer.md` | `skills/learn/explorer-prompt.md` |
| `agents/strategist.md` | `skills/learn/strategist-prompt.md` |
| `agents/planner.md` | `skills/learn/planner-prompt.md` |
| `agents/step-worker.md` | `skills/learn/step-worker-prompt.md` |
| `agents/analyst.md` | `skills/learn/analyst-prompt.md` |
| `agents/promoter.md` | `skills/learn/promoter-prompt.md` |
| `agents/consolidator.md` | `skills/learn/consolidator-prompt.md` |

---

## 7. Harness adapter changes

`client/src/harnesses/impls/claude-code-learner/adapters/claude-code.ts` builds the initial prompt. Today the prompt names the coordinator skill, lists task inputs with names like `task.id`/`solverType`, restates the phase-artifact contract, and embeds the `prediction.v1` JSON-output rule.

**New initial prompt (~12 lines):**

```
You are running a task through the claude-code-learner harness.
Use the `claude-code-learner:learn` skill end-to-end. The skill defines
the seven-phase learning loop; follow it.

Session inputs:
- goal.id = <taskId>
- goal.cid = <taskCid>          (omit line if not present)
- workingDir = <path>
- implStateDir = <path>
- deadline = <windowEndTs>      (ms since epoch)
- msUntilDeadline = <msUntilEndTs>

goal (full body):
<JSON of taskBody>
```

Removed lines:
- The phase-artifact list (it's in `SKILL.md` now).
- The `prediction.v1` JSON-output rule (the plugin doesn't enforce solverType; the harvester already does).
- The daemon-API/submission prohibitions (solverType-specific concerns).
- The `solverType` line (the plugin reads `goal.kind` from the body if it cares; no need to surface it separately).
- The `claudeModel` line (Claude-Code-specific; not a plugin concern).
- The `windowStartTs` line (use `deadline` only).
- The `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` line (the env var is read by the plugin from the environment, not the prompt).

Env-var contract (`IMPL_STATE_DIR`, `WORKING_DIR`, `DAEMON_API_URL`, `DAEMON_API_TOKEN`, `JINN_CORPUS_*`, `DESIRED_STATE_*`, etc.) is unchanged. The plugin's *prose* doesn't reference these names; the adapter sets them in the spawned process's environment as it does today.

**Harvester rename:** in `client/src/harnesses/impls/claude-code-learner/harvest.ts:257` and `:337`, in `types.ts`, and in `client/test/harnesses/impls/claude-code-learner/harvest.test.ts` (lines 83, 173, 174, 182, 183), rename `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE`. The harvester continues to read this env var at call time. Test fixtures use the new name.

---

## 8. Hook + manifest changes

**`hooks/session-start`:** rename git author email:

```diff
-git config user.email "claude-code-learner@jinn.local"
+git config user.email "claude-code-learner@local"
```

Author *name* (`"claude-code-learner"`) stays. The local domain-segment is the only thing that referenced Jinn.

**`.claude-plugin/plugin.json`:** rewrite the `description` to be generic:

```json
{
  "name": "claude-code-learner",
  "description": "Generic learning agent plugin — runs a goal through a seven-phase pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation) and self-improves between runs by mutating its own state directory.",
  "version": "0.1.0",
  "author": {
    "name": "Jinn Network",
    "url": "https://github.com/Jinn-Network/mono"
  }
}
```

Author attribution stays — the plugin is Jinn-Network-authored generic-purpose software; that's a factual provenance claim, not a content binding.

---

## 9. Plugin-level docs

- `README.md` — rewritten generic. "Implements the Jinn default learning restorer end-to-end" → "A generic learning-loop plugin that takes a goal and runs a seven-phase pipeline." The "What this plugin does NOT contain" bullets that mention `RestorerImpl`/`buildRestorerImpls` are removed (they were noting absent Jinn-side glue; irrelevant once the plugin is generic).
- `CLAUDE.md` — single-skill component listing. No "Jinn restoration session" framing.
- `AGENTS.md` — generic harness-tool-mapping table; no "Jinn restoration session" framing. Tool-mapping table updates the dispatch row from registered `Agent` to generic `Task`/`spawn_agent`.
- `validate-plugin.mjs` — README mentions a validator that doesn't exist. Drop the references in the install instructions.

---

## 10. Migration plan

Discrete, in order. Each step is its own commit.

1. **Add new prompt files alongside existing agents** — `cp agents/<role>.md skills/learn/<role>-prompt.md` for all 7 roles, normalize frontmatter (drop `name:` field), apply vocabulary substitutions per §6.
2. **Compose orchestrator `skills/learn/SKILL.md`** — assemble from coordinator + 7 phase skills; uniform dispatch shape; verify-and-return drops solverType bullet; phase-range section reads `LEARNER_PHASE_RANGE`; no `jinn.state_transition` span name.
3. **Update plugin manifest, hook, and docs** — `.claude-plugin/plugin.json` description; `hooks/session-start` author email; rewrite `README.md`/`CLAUDE.md`/`AGENTS.md`; drop `validate-plugin.mjs` references.
4. **Switch the harness adapter and tests to the new skill** — TDD: update `default-prediction-agent.test.ts` and `plugin-path.test.ts` to assert new layout; rewrite `buildInitialPrompt()` per §7.
5. **Rename `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE`** — TDD: update `harvest.test.ts`; update `harvest.ts:257`/`:337` and `types.ts`.
6. **Delete the old plugin layout** — remove `skills/coordinator/`, the 7 phase-skill directories, and `agents/`.
7. **Full e2e verification** — `yarn typecheck`, `yarn test`, `yarn e2e`; final inventory check; walk acceptance criteria.

---

## 11. Tradeoffs and rejected alternatives

**Why fold the Jinn decoupling into the layout simplification:**
The two changes touch the same files (every skill and every agent). Doing them as separate PRs would require either (a) decoupling the old-shape files first, then doing the layout shuffle, or (b) layout-shuffling the old-shape vocabulary, then scrubbing it. Both create churn and a confusing diff. Folding lands the new shape and the new vocabulary in one coherent migration.

**Why keep `intent`-flavored env var names (`DESIRED_STATE_*`, `RESTORATION_REQUEST_ID`):**
These are set by the harness adapter as the spawned process's environment. The plugin's prose never references them by string. Renaming them ripples into many tests, types, and CI fixtures across the harness layer; it's a separate decoupling pass with its own review surface.

**Why not move the residual harvester knowledge of solverTypes out:**
`harvest.ts:398` knows about `prediction.v1` because it's the gatekeeper that translates plugin-emitted JSON to the daemon-side Solution payload. That knowledge has to live somewhere; the harvester is the right place — it's daemon-adjacent, harness-aware code. Pushing it into the plugin would re-introduce the coupling we're removing.

**Why one skill instead of keeping the 8 per-phase skills:**
Skill-loads-skill isn't a documented pattern in any harness's plugin convention; relying on it is a portability risk. The audit story is preserved in the new design via `SKILL.md` sectioning and the per-phase artifact files; per-phase tool scoping is preserved via subagent dispatch arguments.

**Why not collapse subagent prompts into `SKILL.md`:**
Inlining would inflate `SKILL.md` past 1,000 lines and conflate orchestrator prose with subagent instructions. Sibling files keep each prompt under ~120 lines and let a reader page the orchestrator separately from the role definitions. Matches `subagent-driven-development`'s structure.

**Why not keep `agents/` and use named-subagent dispatch (Claude Code's `Agent`-with-`subagent_type`):**
Cross-harness portability. Codex, Gemini CLI, and OpenCode use generic Task-style dispatch with inline prompt strings; Claude Code's named-subagent registry doesn't transfer.

**Why not change the daemon:**
The daemon is intentionally agnostic to phases AND to harnesses; pushing orchestration into TypeScript breaks the bring-your-own-harness-and-plugins model. Orchestration belongs in the plugin.

---

## 12. Acceptance criteria

The migration is complete when all of the following hold:

- `client/plugins/claude-code-learner/skills/learn/SKILL.md` exists and is the only skill.
- `client/plugins/claude-code-learner/skills/learn/<role>-prompt.md` exists for all 7 roles.
- `client/plugins/claude-code-learner/agents/` directory does not exist.
- `client/plugins/claude-code-learner/skills/{coordinator,orient,strategize,plan,execute,debrief,improve,memory-consolidation}/` do not exist.
- The harness adapter's initial prompt names `claude-code-learner:learn`.
- **Vocabulary scrub verified**: `grep -ri 'jinn\|restoration\|restorer\|solverType\|prediction\.v\|polymarket\| HL \|on-chain\|knowledge-tree\|walkArtifacts\|RestorerImpl\|buildRestorerImpls\|jinn\.state_transition' client/plugins/claude-code-learner/` returns empty (or matches only the `Jinn Network` author attribution in `plugin.json`, which is intentional).
- `LEARNER_PHASE_RANGE` is the only env-var name used for phase-range hinting in the plugin, the harvester, and the tests; no `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` references remain.
- `hooks/session-start` sets git author email to `claude-code-learner@local`.
- `yarn typecheck`, `yarn test`, and `yarn e2e` pass on `client/`.
- The prediction-v1 default-prediction-agent harness test passes (it asserts `claude-code-learner:learn` in the prompt; it no longer asserts plugin-internal prediction.v1 enforcement).
- A successful `prediction.v1` run produces all seven phase artifacts plus `workingDir/.execute/prediction-v1-solution.json` (the latter enforced by `harvest.ts`, not the plugin).
- `README.md` no longer references a non-existent `validate-plugin.mjs`.

---

## 13. Cross-reference

- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1, §2 (architecture), §10 (constitution span). Phase semantics, artifact contracts, and learning loop are unchanged.
- `obra/superpowers@main/skills/subagent-driven-development/` — convention reference for skill-with-sibling-prompts.
- `client/src/harnesses/impls/claude-code-learner/harvest.ts:398` — owns solverType-specific artifact enforcement, which is why the plugin doesn't need to.
