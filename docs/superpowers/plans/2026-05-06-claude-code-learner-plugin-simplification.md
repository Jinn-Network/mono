# claude-code-learner plugin simplification + harness-decoupling — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the `claude-code-learner` plugin from 8 skills + 7 agent role files to 1 orchestrator skill + 7 sibling prompt files, AND strip all Jinn-specific vocabulary from the plugin so it's a generic harness-agnostic learning plugin. No behavior change; preserves the seven-phase pipeline, all artifact contracts, and the daemon's runtime-agnostic design.

**Architecture:** Three layers — daemon (agnostic), harness adapter + harvester (Jinn-aware translation), plugin (generic learning loop). The plugin currently leaks Jinn vocabulary (`solverType`, `prediction.v1`, "restoration intent," `Polymarket`/`HL` examples, `walkArtifacts`, `jinn.state_transition`, `JINN_*` env var prefix) and has three indirection layers (coordinator skill → phase skill → registered named subagent). After this PR the plugin contains zero Jinn references and uses the conventional sibling-prompt subagent pattern.

**Tech Stack:** TypeScript (Node 22, Yarn, Vitest) for the harness adapter + harvester; markdown for plugin content; Claude Code's plugin system (skills + hooks).

**Spec:** `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1

---

## File Structure

**New plugin layout (target):**

```
client/plugins/claude-code-learner/
├── .claude-plugin/plugin.json       # description rewritten generic
├── hooks/
│   ├── hooks.json                   # unchanged
│   └── session-start                # author email → claude-code-learner@local
├── skills/
│   └── learn/
│       ├── SKILL.md                 # NEW — orchestrator (replaces coordinator + 7 phase skills)
│       ├── explorer-prompt.md       # was agents/explorer.md (vocabulary scrubbed)
│       ├── strategist-prompt.md     # scrubbed
│       ├── planner-prompt.md        # scrubbed
│       ├── step-worker-prompt.md    # scrubbed
│       ├── analyst-prompt.md        # scrubbed
│       ├── promoter-prompt.md       # scrubbed
│       └── consolidator-prompt.md   # scrubbed
├── README.md                         # rewritten generic
├── CLAUDE.md                         # rewritten generic
└── AGENTS.md                         # rewritten generic
```

**Files modified outside the plugin:**

- `client/src/harnesses/impls/claude-code-learner/adapters/claude-code.ts` — `buildInitialPrompt()` invokes `:learn` not `:coordinator`; uses generic vocabulary; drops solverType-specific lines.
- `client/src/harnesses/impls/claude-code-learner/harvest.ts` — `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE` (lines 257, 337).
- `client/src/harnesses/impls/claude-code-learner/types.ts` — same env-var rename (lines 6, 56).
- `client/test/harnesses/impls/claude-code-learner/plugin-path.test.ts` — assertions updated to new layout.
- `client/test/harnesses/impls/claude-code-learner/default-prediction-agent.test.ts:194-195` — assertion updated to new skill name; prediction-v1 internal-path assertion dropped.
- `client/test/harnesses/impls/claude-code-learner/harvest.test.ts` — env-var rename (lines 83, 173, 174, 182, 183).

**Vocabulary substitution table (apply to every plugin file's body, per spec §6):**

| Replace | With |
|---|---|
| `intent` (in plugin-input sense) | `goal` |
| `restoration intent` / `restoration` | `goal` |
| `solverType` | `goal.kind` (or drop if not load-bearing) |
| `Jinn`, `Jinn daemon`, `the daemon` | `the harness` |
| `walkArtifacts` (mention) | "the harness's artifact harvester" |
| "knowledge-tree query" | "the harness's history-of-runs query, if exposed" |
| `HL`, `Polymarket`, `on-chain`, "venue / market" examples | "whatever tools the harness exposes for this goal" |
| `prediction.v0`, `prediction.v1`, `portfolio.v0` | (drop the example list entirely) |
| `jinn.state_transition` | "a state-transition span (name defined by harness)" |
| `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` | `LEARNER_PHASE_RANGE` |
| `RestorerImpl`, `buildRestorerImpls` | (drop entirely) |

**Migration strategy:** Add new layout alongside old, switch the adapter and tests, rename the env var, then delete the old layout and update docs.

---

## Task 1: Add scrubbed prompt files alongside existing agents

**Files:**
- Create: `client/plugins/claude-code-learner/skills/learn/explorer-prompt.md`
- Create: `client/plugins/claude-code-learner/skills/learn/strategist-prompt.md`
- Create: `client/plugins/claude-code-learner/skills/learn/planner-prompt.md`
- Create: `client/plugins/claude-code-learner/skills/learn/step-worker-prompt.md`
- Create: `client/plugins/claude-code-learner/skills/learn/analyst-prompt.md`
- Create: `client/plugins/claude-code-learner/skills/learn/promoter-prompt.md`
- Create: `client/plugins/claude-code-learner/skills/learn/consolidator-prompt.md`
- Read source: `client/plugins/claude-code-learner/agents/<role>.md` (7 files)

- [ ] **Step 1: Make the target directory**

```bash
mkdir -p client/plugins/claude-code-learner/skills/learn
```

- [ ] **Step 2: Copy each agent file to its sibling-prompt name**

Use `cp` (not `git mv`) — originals must remain on disk until Task 6.

```bash
cp client/plugins/claude-code-learner/agents/explorer.md         client/plugins/claude-code-learner/skills/learn/explorer-prompt.md
cp client/plugins/claude-code-learner/agents/strategist.md       client/plugins/claude-code-learner/skills/learn/strategist-prompt.md
cp client/plugins/claude-code-learner/agents/planner.md          client/plugins/claude-code-learner/skills/learn/planner-prompt.md
cp client/plugins/claude-code-learner/agents/step-worker.md      client/plugins/claude-code-learner/skills/learn/step-worker-prompt.md
cp client/plugins/claude-code-learner/agents/analyst.md          client/plugins/claude-code-learner/skills/learn/analyst-prompt.md
cp client/plugins/claude-code-learner/agents/promoter.md         client/plugins/claude-code-learner/skills/learn/promoter-prompt.md
cp client/plugins/claude-code-learner/agents/consolidator.md     client/plugins/claude-code-learner/skills/learn/consolidator-prompt.md
```

- [ ] **Step 3: Normalize frontmatter in each new prompt file**

For each `skills/learn/<role>-prompt.md`, change:

```yaml
---
name: <role>
description: <text>
tools: <list>
---
```

to:

```yaml
---
description: <text>
tools: <list>
---
```

Specifically remove these lines:

- `skills/learn/explorer-prompt.md`: `name: explorer`
- `skills/learn/strategist-prompt.md`: `name: strategist`
- `skills/learn/planner-prompt.md`: `name: planner`
- `skills/learn/step-worker-prompt.md`: `name: step-worker`
- `skills/learn/analyst-prompt.md`: `name: analyst`
- `skills/learn/promoter-prompt.md`: `name: promoter`
- `skills/learn/consolidator-prompt.md`: `name: consolidator`

Do not modify other frontmatter fields.

- [ ] **Step 4: Apply the vocabulary substitution table to each prompt file's body**

For each `skills/learn/<role>-prompt.md`, scan the body and apply the substitutions in the §6 table at the top of this plan. Use `grep` to find all matches in the new files first, then apply substitutions:

```bash
grep -n -E 'intent|restoration|solverType|Jinn|walkArtifacts|knowledge-tree|HL|Polymarket|on-chain|prediction\.v|portfolio\.v|jinn\.state_transition|JINN_CLAUDE_CODE_LEARNER|RestorerImpl|buildRestorerImpls' client/plugins/claude-code-learner/skills/learn/*-prompt.md
```

Apply the table substitutions. Specifically:

**`explorer-prompt.md`** — heaviest scrub. The file currently lists kinds with venue-specific examples ("HL, Polymarket, on-chain") and references "the harness's knowledge-tree query." After substitution:

- "the restoration intent" → "the goal"
- "(HL, Polymarket, on-chain, etc.)" → "(whatever tools the harness exposes for this goal)"
- "the harness's knowledge-tree query for past runs of this kind by this operator" → "the harness's history-of-runs query, if exposed, for past runs of this kind by this operator"
- "for runs of this kind by other operators" → keep (harness/operator vocabulary is generic)

**`strategist-prompt.md`** — minimal.

- "Spec: §4.2, §10." (cross-reference to old design spec) → keep, but verify it doesn't say "Jinn"
- Any "intent" used in plugin-input sense → "goal"

**`planner-prompt.md`** — minimal.

- Any "intent" → "goal"
- Any reference to `solverType` → "goal.kind" or drop

**`step-worker-prompt.md`** — minimal.

- Any "intent" → "goal"

**`analyst-prompt.md`** — likely minimal.

- Any "intent" → "goal"
- Any reference to "restoration" → "goal"

**`promoter-prompt.md`** — likely minimal.

- Any "intent" → "goal"

**`consolidator-prompt.md`** — drop the `walkArtifacts` mention.

- "the engine's `walkArtifacts`" → "the harness's artifact harvester"
- Any "intent" → "goal"

After all substitutions, re-run the grep above to verify zero matches in `skills/learn/*-prompt.md`.

- [ ] **Step 5: Update internal cross-references**

In each prompt file, replace any references to "the coordinator skill" or "your spawning skill" with "the dispatching section of `skills/learn/SKILL.md`."

```bash
grep -n -E 'coordinator|spawning skill|phase skill' client/plugins/claude-code-learner/skills/learn/*-prompt.md
```

Update only the matches you find.

- [ ] **Step 6: Verify the new prompt files are clean**

```bash
# All seven exist:
ls client/plugins/claude-code-learner/skills/learn/*-prompt.md | wc -l
```
Expected: `7`.

```bash
# No `name:` frontmatter:
grep -l '^name:' client/plugins/claude-code-learner/skills/learn/*-prompt.md
```
Expected: empty output.

```bash
# No Jinn vocabulary:
grep -i -E 'jinn|restoration|restorer|solverType|prediction\.v|polymarket| HL |on-chain|knowledge-tree|walkArtifacts|RestorerImpl|buildRestorerImpls|jinn\.state_transition|JINN_CLAUDE_CODE_LEARNER' client/plugins/claude-code-learner/skills/learn/*-prompt.md
```
Expected: empty output.

- [ ] **Step 7: Confirm existing tests still pass**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/
```
Expected: all tests pass. The old layout is intact; the new prompt files exist alongside but no test asserts them yet.

- [ ] **Step 8: Commit**

```bash
git add client/plugins/claude-code-learner/skills/learn/
git commit -m "$(cat <<'EOF'
plugin(learner): add scrubbed sibling-prompt files alongside agents/

Stage 1 of plugin simplification + decoupling per
docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md
v1.1.

Each agents/<role>.md is copied to skills/learn/<role>-prompt.md with:
- name: frontmatter field removed (sibling prompts are not registered
  subagent types)
- Jinn-specific vocabulary stripped per the spec §6 substitution table
  (intent→goal, removal of solverType/prediction.v/Polymarket/HL/
  knowledge-tree/walkArtifacts mentions, etc.)

Old agents/ remains in place; the orchestrator skill that dispatches
these is added next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Compose the `learn` orchestrator skill

**Files:**
- Create: `client/plugins/claude-code-learner/skills/learn/SKILL.md`
- Read sources:
  - `client/plugins/claude-code-learner/skills/coordinator/SKILL.md`
  - `client/plugins/claude-code-learner/skills/{orient,strategize,plan,execute,debrief,improve,memory-consolidation}/SKILL.md`

The orchestrator is composed by inlining the orchestration logic from coordinator + 7 phase skills, applying the same vocabulary substitution table from Task 1.

- [ ] **Step 1: Write the SKILL.md frontmatter and top header**

Create `client/plugins/claude-code-learner/skills/learn/SKILL.md`:

```markdown
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
- `implStateDir` — the agent's persistent self-state. Git-backed by the SessionStart hook. Mutations here persist across runs and constitute "learning."
- `msUntilDeadline` — function returning remaining time.
- An abort signal that fires at the goal's deadline (if any).

The session-start hook (`hooks/session-start`) has already initialized `implStateDir` as a git repo with the `claude-code-learner` author identity.
```

- [ ] **Step 2: Add the Boot section**

Compose `## 1. Boot` by inlining the Boot subsection of `skills/coordinator/SKILL.md` (lines 19–67 of that file). Apply substitutions:

- "Inputs (from the daemon)" → "Inputs (from the harness)"
- "the daemon hands you `intent`" → "the harness hands you `goal`"
- "intent.id" → "goal.id"
- "intent.window.endTs" → "goal.deadline"
- The `boot.json` shape changes the field name from `intentId` → `goalId`, `windowEndTs` → `deadline`. Other fields (`implStateDirShaAtStart`, `skillBundleCid`) stay.

```json
{
  "implStateDirShaAtStart": "<git HEAD sha of implStateDir at run start>",
  "skillBundleCid": "sha256:<plugin bundle digest>",
  "goalId": "<goal.id>",
  "deadline": <goal.deadline as milliseconds since epoch>
}
```

The `boot.json` lives at `workingDir/.coordinator/boot.json` today; rename to `workingDir/.learn/boot.json` since the directory was named after the skill. Update Strategize's reference accordingly.

Wait — the existing strategize skill reads from `workingDir/.coordinator/boot.json`. The directory rename ripples. **Decision:** keep the path as `workingDir/.coordinator/boot.json` for now; the directory name is incidental and renaming ripples into Strategize and Debrief. The path-name `.coordinator` is fine even though the skill is now `learn` — it's just a directory.

(If you prefer the rename, update `skills/learn/strategist-prompt.md` and any other place that reads `boot.json` to use `.learn/boot.json`. Out-of-scope for this plan unless you flag it.)

- [ ] **Step 3: Add the Phase-range guard section**

Compose `## 2. Phase-range guard` by inlining from `skills/coordinator/SKILL.md` (paragraph beginning "*Phase-range hint:*"), applying substitutions:

- `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE`
- "the daemon-side wrapper" → "the harness's specialist wrapper"
- "kind-specific specialist Execute paths" → "domain-specialist Execute paths"

Three branches: `pre-execute` (sections 3–5), `post-execute` (sections 7–9), unset/all (sections 1–11).

- [ ] **Step 4: Add sections 3–9, one per phase**

For each phase, compose a section with:

1. `## N. <Phase Name>` heading.
2. One-sentence purpose.
3. Subagent dispatch (using uniform shape — see Step 5 below).
4. Inputs to pass.
5. Output artifact path.
6. What the orchestrator does with the result.

Source mapping — copy orchestration logic (NOT subagent role logic, which is in the sibling prompt files) from each phase skill, applying vocabulary substitutions:

| Section | Source skill file | Subagent prompt(s) dispatched |
|---|---|---|
| 3. Orient | `skills/orient/SKILL.md` | `explorer-prompt.md` (parallel, one per topic: intent-parse, world-state, own-history, others-history) |
| 4. Strategize | `skills/strategize/SKILL.md` | `strategist-prompt.md` |
| 5. Plan | `skills/plan/SKILL.md` | `planner-prompt.md` |
| 6. Execute | `skills/execute/SKILL.md` | `step-worker-prompt.md` (per work step in plan) |
| 7. Debrief | `skills/debrief/SKILL.md` | `explorer-prompt.md` (optional post-execution probes) + `analyst-prompt.md` |
| 8. Improve | `skills/improve/SKILL.md` | `promoter-prompt.md` |
| 9. Memory consolidation | `skills/memory-consolidation/SKILL.md` | `consolidator-prompt.md` |

For Section 3 Orient: the topic name "intent-parse" stays (it's a topic-name, not the input field name; the topic gathers what the goal is asking for). Body text within that topic gets `intent` → `goal` substitution.

Section 6 Execute: preserve the per-step decision logic (`continue / retry-step / replan / abort`) verbatim. Apply `intent` → `goal`. **Drop** any `prediction.v1`-specific assertions (the WIP that added these has been discarded; the harvester owns this enforcement).

After each section, append a coordinator-log line:

```markdown
Append a JSONL entry to `workingDir/.coordinator/log.jsonl`:
`{ ts, phase, status, summary }`.
```

- [ ] **Step 5: Use this uniform dispatch shape in every section**

```markdown
Spawn a fresh-context subagent. Read the prompt body from
`${PLUGIN_ROOT}/skills/learn/<role>-prompt.md` and pass it as the
subagent's instructions. Pass these inputs:

  goal                = <copy of goal>
  workingDir          = <path>
  implStateDir        = <path, read-only unless this role mutates it>
  outputPath          = workingDir/.<phase>/<artifact>.json
  msUntilDeadline     = <current value>
  ... role-specific inputs (see <role>-prompt.md inputs section) ...

The subagent reads the prompt, follows it, writes outputPath, and returns
a one-line summary plus artifactPath.
```

Replace `<role>` and `<phase>` per the table in Step 4.

**Do not** reference Claude Code's named-subagent registry. No `subagent_type:` arguments. No `claude-code-learner:explorer`-style names.

For parallel-dispatch sections (Orient, optional Debrief probes), describe the parallel pattern using the language from the current `skills/orient/SKILL.md` "Launch explorers" subsection.

- [ ] **Step 6: Add the Verify-and-return section**

Compose `## 10. Verify and return`. Inline the primary-artifact checklist from the current `skills/coordinator/SKILL.md` "Returning" subsection:

```markdown
Before returning, assert each primary artifact exists:

- `workingDir/.orient/summary.json`
- `workingDir/.strategize/strategy.json`
- `workingDir/.plan/plan.json`
- `workingDir/.execute/summary.json`
- `workingDir/.debrief/analysis.json`
- `workingDir/.improve/summary.json`
- `workingDir/.memory-consolidation/consolidation_record.json`

Do NOT include any goal-kind-specific assertions. The harness owns
goal-kind enforcement (e.g. domain-specific solution payloads). The
plugin verifies only its own seven generic phase artifacts.

When the pipeline finishes — whether all sections completed cleanly,
an abort signal fired, or a section reported failure — return. Never
modify anything outside `implStateDir/**` or `workingDir/**`.
```

**Do not** include the `prediction.v1` solverType-specific assertion that v1.0 of the spec preserved. v1.1 explicitly drops it; the harvester (`client/src/harnesses/impls/claude-code-learner/harvest.ts:398`) is the gatekeeper.

- [ ] **Step 7: Add the Failure handling section**

Compose `## 11. Failure handling` by inlining from `skills/coordinator/SKILL.md`. Preserve verbatim:

- Within Execute: that section judges `continue / retry-step / replan / abort` per its own rules.
- Execute reporting `abort` is not a pipeline-level abort — continue to Debrief / Improve / Memory consolidation as normal.
- Other sections: if a section reports a hard problem, write `workingDir/.errors/<phase>.json` and abort the pipeline. Still run Memory consolidation so partial work gets curated.
- Abort signal fired (deadline reached): stop the current section cleanly, write `workingDir/.errors/abort.json`, run Memory consolidation, return.

Apply `intent` → `goal` and `window.endTs` → `deadline` if those phrases appear.

- [ ] **Step 8: Add the Constitution-span section**

Compose `## State-transition span` (or fold into the Strategize section as a post-step). Use this generic version:

```markdown
After Strategize, read `workingDir/.strategize/constitution.json`.
If the harness exposes an OTel tracer, emit the constitution fields
as attributes on a state-transition span (the harness defines the
span name). Otherwise the file itself is the constitution record;
Debrief reads it from there.
```

Do **not** hardcode `jinn.state_transition` as the span name.

- [ ] **Step 9: Add the Cross-reference section**

```markdown
## Cross-reference

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
```

- [ ] **Step 10: Verify the SKILL.md is clean**

```bash
# Frontmatter delimiters:
grep -E '^---$' client/plugins/claude-code-learner/skills/learn/SKILL.md | wc -l
```
Expected: `2`.

```bash
# No registered-subagent dispatch:
grep -E 'claude-code-learner:(explorer|strategist|planner|step-worker|analyst|promoter|consolidator)' client/plugins/claude-code-learner/skills/learn/SKILL.md
```
Expected: empty.

```bash
# No Jinn vocabulary:
grep -i -E 'jinn|restoration|restorer|solverType|prediction\.v|polymarket| HL |on-chain|knowledge-tree|walkArtifacts|RestorerImpl|buildRestorerImpls|jinn\.state_transition|JINN_CLAUDE_CODE_LEARNER' client/plugins/claude-code-learner/skills/learn/SKILL.md
```
Expected: empty.

```bash
# No old-input vocabulary:
grep -E '\bintent\b|window\.endTs' client/plugins/claude-code-learner/skills/learn/SKILL.md
```
Expected: empty (every `intent` is replaced by `goal`; `window.endTs` is replaced by `deadline`).

- [ ] **Step 11: Run existing tests**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/
```
Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add client/plugins/claude-code-learner/skills/learn/SKILL.md
git commit -m "$(cat <<'EOF'
plugin(learner): add learn orchestrator skill

Stage 2 of plugin simplification + decoupling. skills/learn/SKILL.md
replaces the coordinator + 7 phase skills with one document.

Each phase is a section that dispatches a fresh-context subagent using
the prompt body from the matching skills/learn/<role>-prompt.md sibling
file (added in stage 1). Generic vocabulary throughout: goal not intent,
deadline not window.endTs, LEARNER_PHASE_RANGE not JINN_*, no solverType
assertions in verify-and-return, no jinn.state_transition span name.

The harness adapter still invokes :coordinator and the existing skills/*
remain in place; the switch lands in stage 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Switch the harness adapter and tests to the new skill (TDD)

**Files:**
- Modify: `client/test/harnesses/impls/claude-code-learner/default-prediction-agent.test.ts:194-195`
- Modify: `client/test/harnesses/impls/claude-code-learner/plugin-path.test.ts:10-11`
- Modify: `client/src/harnesses/impls/claude-code-learner/adapters/claude-code.ts:98-125` (`buildInitialPrompt`)

- [ ] **Step 1: Write the failing assertion in default-prediction-agent.test.ts**

Open the test, find line 194:

```ts
expect(promptArg).toContain('claude-code-learner:coordinator');
expect(promptArg).toContain('.execute/prediction-v1-solution.json');
```

Change to (single line):

```ts
expect(promptArg).toContain('claude-code-learner:learn');
```

Drops the second assertion entirely — it asserted plugin-internal content (the prediction.v1 path string in the adapter prompt) which v1.1 of the spec removes from the prompt because solverType-specific enforcement belongs in the harvester, not in adapter prose.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/default-prediction-agent.test.ts
```
Expected: FAIL — `claude-code-learner:learn` not found in prompt.

- [ ] **Step 3: Update buildInitialPrompt in claude-code.ts**

Replace the body of `buildInitialPrompt` (currently lines 98–125) with:

```ts
function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are running a task through the claude-code-learner harness.',
    'Use the `claude-code-learner:learn` skill end-to-end. The skill defines the seven-phase learning loop; follow it.',
    '',
    'Session inputs:',
    `- goal.id = ${inputs.taskId}`,
    inputs.taskCid ? `- goal.cid = ${inputs.taskCid}` : '',
    `- workingDir = ${inputs.workingDir}`,
    `- implStateDir = ${inputs.implStateDir}`,
    `- deadline = ${inputs.windowEndTs} (ms since epoch)`,
    `- msUntilDeadline = ${inputs.msUntilEndTs}`,
    inputs.taskBody
      ? `\ngoal (full body):\n${JSON.stringify(inputs.taskBody, null, 2)}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
```

Removed (relative to current adapter):
- The phase-artifact list (now in `SKILL.md`).
- The `prediction.v1` JSON-output rule (harvester owns it).
- The daemon-API/submission prohibitions (solverType-specific).
- The `solverType`/`claudeModel`/`windowStartTs` lines (plugin reads via taskBody if needed).
- The `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` line (env var, not prompt content).
- "Jinn restoration task" framing.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/default-prediction-agent.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update plugin-path.test.ts**

Open `client/test/harnesses/impls/claude-code-learner/plugin-path.test.ts` lines 10–11:

```ts
expect(existsSync(join(root, 'skills', 'coordinator', 'SKILL.md'))).toBe(true);
expect(existsSync(join(root, 'agents', 'explorer.md'))).toBe(true);
```

Change to:

```ts
expect(existsSync(join(root, 'skills', 'learn', 'SKILL.md'))).toBe(true);
expect(existsSync(join(root, 'skills', 'learn', 'explorer-prompt.md'))).toBe(true);
```

- [ ] **Step 6: Run plugin-path test**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/plugin-path.test.ts
```
Expected: PASS.

- [ ] **Step 7: Run the full learner test suite**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/
```
Expected: all 5 test files pass.

- [ ] **Step 8: Commit**

```bash
git add client/src/harnesses/impls/claude-code-learner/adapters/claude-code.ts \
        client/test/harnesses/impls/claude-code-learner/default-prediction-agent.test.ts \
        client/test/harnesses/impls/claude-code-learner/plugin-path.test.ts
git commit -m "$(cat <<'EOF'
harness(claude-code-learner): switch adapter to learn skill

Stage 3 of plugin simplification + decoupling. The adapter's initial
prompt now invokes claude-code-learner:learn, uses generic vocabulary
(goal/deadline/msUntilDeadline), and stops re-stating phase-artifact
paths or the prediction.v1 JSON rule (harvester owns that). Tests
updated to assert the new skill name and the new plugin layout. The old
skills/coordinator and skills/<phase>/ + agents/ remain on disk;
deletion lands in stage 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rename `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` → `LEARNER_PHASE_RANGE` (TDD)

**Files:**
- Modify: `client/test/harnesses/impls/claude-code-learner/harvest.test.ts` (lines 83, 173, 174, 182, 183)
- Modify: `client/src/harnesses/impls/claude-code-learner/harvest.ts` (lines 257, 337)
- Modify: `client/src/harnesses/impls/claude-code-learner/types.ts` (lines 6, 56)

- [ ] **Step 1: Write the failing assertion in harvest.test.ts**

Find every reference to `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` in `client/test/harnesses/impls/claude-code-learner/harvest.test.ts`:

```bash
grep -n JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE client/test/harnesses/impls/claude-code-learner/harvest.test.ts
```
Expected: 5 hits (lines ~83, 173, 174, 182, 183).

Rename them all to `LEARNER_PHASE_RANGE`:

```bash
sed -i.bak 's/JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE/LEARNER_PHASE_RANGE/g' \
  client/test/harnesses/impls/claude-code-learner/harvest.test.ts
rm client/test/harnesses/impls/claude-code-learner/harvest.test.ts.bak
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/harvest.test.ts -t 'phaseRange'
```
Expected: FAIL — the harvester still reads `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE`, so the new env var name doesn't influence it.

(If the failure mode is unclear, the relevant tests are the ones that set/unset the env var and assert phaseRange detection.)

- [ ] **Step 3: Rename in harvest.ts and types.ts**

```bash
sed -i.bak 's/JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE/LEARNER_PHASE_RANGE/g' \
  client/src/harnesses/impls/claude-code-learner/harvest.ts \
  client/src/harnesses/impls/claude-code-learner/types.ts
rm client/src/harnesses/impls/claude-code-learner/harvest.ts.bak \
   client/src/harnesses/impls/claude-code-learner/types.ts.bak
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/harvest.test.ts
```
Expected: PASS.

- [ ] **Step 5: Verify no `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` references remain anywhere**

```bash
grep -rn 'JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE' client/ docs/ 2>/dev/null
```
Expected: only matches in this plan (`docs/superpowers/plans/2026-05-06-...md`) and the spec (`docs/superpowers/specs/2026-05-06-...md`) — both as historical context. No production code or test references.

- [ ] **Step 6: Run typecheck and the full test suite**

```bash
cd client && yarn typecheck && yarn test
```
Expected: zero typecheck errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add client/test/harnesses/impls/claude-code-learner/harvest.test.ts \
        client/src/harnesses/impls/claude-code-learner/harvest.ts \
        client/src/harnesses/impls/claude-code-learner/types.ts
git commit -m "$(cat <<'EOF'
harness(claude-code-learner): rename phase-range env var

Stage 4 of plugin simplification + decoupling. JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE
becomes LEARNER_PHASE_RANGE — the plugin's env-var contract should not carry the
JINN_ prefix when the plugin itself is supposed to be Jinn-agnostic. Updates
harvest.ts, types.ts, and harvest.test.ts; the new skills/learn/SKILL.md (stage 2)
already uses the new name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update plugin manifest, hook, and rewrite docs

**Files:**
- Modify: `client/plugins/claude-code-learner/.claude-plugin/plugin.json`
- Modify: `client/plugins/claude-code-learner/hooks/session-start`
- Modify: `client/plugins/claude-code-learner/README.md`
- Modify: `client/plugins/claude-code-learner/CLAUDE.md`
- Modify: `client/plugins/claude-code-learner/AGENTS.md`

- [ ] **Step 1: Update plugin.json description**

Replace the `description` field in `client/plugins/claude-code-learner/.claude-plugin/plugin.json`:

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

Author attribution is preserved — that's a factual provenance claim, not a content binding.

- [ ] **Step 2: Update session-start hook author email**

Open `client/plugins/claude-code-learner/hooks/session-start`, find:

```bash
git config user.email "claude-code-learner@jinn.local"
```

Change to:

```bash
git config user.email "claude-code-learner@local"
```

- [ ] **Step 3: Rewrite README.md**

Replace the entire body of `client/plugins/claude-code-learner/README.md`:

```markdown
# claude-code-learner — generic learning agent plugin

A drop-in plugin for any agent harness that supports skills + subagent dispatch + hooks. Runs a goal through a seven-phase learning loop (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation) and self-improves between runs by mutating its own state directory.

## What it provides

- **1 orchestrator skill** — `skills/learn/SKILL.md`. Drives the seven-phase pipeline end-to-end inside one harness session.
- **7 sibling subagent prompts** — `skills/learn/<role>-prompt.md` for `explorer`, `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. Each is the prompt body the orchestrator passes to a fresh-context subagent dispatch.
- **1 hook** — `hooks/session-start` initializes `implStateDir` as a git repo and sets author identity.

## Installing

The plugin is consumed by harnesses that load skills from a plugin directory.

**Claude Code (local development — recommended for first install):**

```bash
# Point a Claude Code session at the plugin directory:
claude --plugin-dir /path/to/claude-code-learner [other args]
```

For a permanent install via the Claude Code marketplace, use `claude plugin install <plugin>@<marketplace>` once a marketplace listing is published. Until then, `--plugin-dir` is the supported path.

**Codex / OpenCode / other harnesses:** consult your harness's documentation for how to point it at a local plugin directory. The plugin layout (`.claude-plugin/plugin.json` + `skills/` + `hooks/` + `hooks/hooks.json`) is Claude-Code-shaped; harnesses with a different convention may need an adapter.

## What the harness must provide

These are the runtime primitives the plugin assumes the harness exposes (Claude Code names; substitute equivalents on other harnesses):

- `Skill` — load a named skill into the current session.
- `Task` (general-purpose) — spawn a fresh-context subagent with an inline prompt body.
- `Bash` — for git commands and other shell calls.
- `Read`, `Write`, `Edit`, `Glob`, `Grep` — filesystem.
- A wait primitive — block until duration / deadline / condition (Claude Code: `Monitor`).

If the harness lacks `Skill`, generic `Task`-style subagent dispatch, `Bash`, or filesystem read/write/edit, the plugin will not run. The wait primitive gates time-anchored plans only — the plugin can run for `early-return` postures without it.

## Inputs the harness adapter passes

The orchestrator skill expects these as session inputs (typically via the harness adapter's initial prompt or environment):

- `goal` — `{ id, description, kind?, deadline?, spec? }`. Free-form payload describing what to achieve.
- `workingDir` — ephemeral path for this run's artifacts.
- `implStateDir` — the agent's persistent self-state (git-backed).
- `msUntilDeadline` — function returning remaining time.
- An abort signal that fires at the goal's deadline.

The plugin does not interpret `goal.kind` semantically. Domain-specific behavior (e.g. how to forecast a prediction market, how to rebalance a portfolio) belongs in domain-specific plugins loaded alongside this one, OR in the harness adapter / harvester layer.

## Optional environment

- `LEARNER_PHASE_RANGE=pre-execute|post-execute|full` — limits which phases run. Used by harnesses that wrap a domain-specialist Execute path between meta-pre and meta-post passes.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
```

- [ ] **Step 4: Rewrite CLAUDE.md**

Replace the entire body of `client/plugins/claude-code-learner/CLAUDE.md`:

```markdown
# claude-code-learner plugin (Claude Code loader)

This plugin provides a generic learning-agent loop.

## Entry point

When a session starts, the harness adapter's initial prompt directs the model to use the `claude-code-learner:learn` skill. That skill drives the full seven-phase pipeline.

## Components

**Skill:**
- `skills/learn/SKILL.md` — single orchestrator. Sequences Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation. Each phase dispatches a fresh-context subagent using the prompt body from the matching sibling file.

**Subagent prompt files (siblings of SKILL.md):**
- `explorer-prompt.md` — info gatherer (used by Orient and Debrief, parallel-dispatched)
- `strategist-prompt.md`, `planner-prompt.md`, `step-worker-prompt.md`, `analyst-prompt.md`, `promoter-prompt.md`, `consolidator-prompt.md` — one per specialized role

**Hook:**
- `hooks/session-start` — runs once at session start; ensures `implStateDir` is a git repo and sets `claude-code-learner` author identity.

## Conventions

- All durable self-modification lives in `implStateDir/**` (git-backed).
- Episode artifacts live under `workingDir/**`; the harness harvests `workingDir` once the orchestrator returns.
- Subagents are one level deep only — they do not spawn further agents.
- Strategize-frozen success criteria + timing posture must not change during the run.
- Subagent dispatch is by inlined prompt body (read from a sibling `*-prompt.md`), not by named-subagent registry. This keeps the plugin portable across harnesses.
- The plugin does not interpret `goal.kind` semantically. Domain-specific knowledge belongs in other plugins or in the harness layer.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
```

- [ ] **Step 5: Rewrite AGENTS.md**

Replace the entire body of `client/plugins/claude-code-learner/AGENTS.md`:

```markdown
# claude-code-learner plugin (generic / Codex loader)

This plugin provides a generic learning-agent loop for any harness that supports skills + subagent dispatch + hooks.

## Tool name mapping

> Names below are best-effort guidance; harness tool surfaces evolve. The canonical contract is the **capability** described in the Generic column — confirm against your harness's docs before wiring.

The `learn` skill and the sibling prompt files use Claude Code tool names by default. On other harnesses, substitute equivalents:

| Claude Code | Codex | Pi.dev | Generic |
|---|---|---|---|
| `Skill` | `skill` | (extension load) | "load named instructions into current session" |
| `Task` (general-purpose) | `spawn_agent` | (subprocess) | "spawn fresh-context subagent with an inline prompt body" |
| `Bash` | `shell` | `bash` | shell tool |
| `Read`/`Write`/`Edit` | `file_read`/`file_write` | `fs` tools | filesystem |
| `Glob`/`Grep` | `glob`/`grep` | `fs` search | "filesystem search by pattern / content" |
| `Monitor` (wait) | (bespoke) | (built-in) | "block until duration/deadline/condition" |

## Entry point

The harness adapter directs the model to use the `claude-code-learner:learn` skill at session start.

## Components

See `CLAUDE.md` for the same component listing — both loaders cover the same plugin contents; this file just notes the cross-harness tool mapping.

## Spec

- Pipeline + artifacts: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
- Plugin layout + decoupling: `docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md` v1.1.
```

- [ ] **Step 6: Verify docs reference the new layout only**

```bash
grep -n -i 'coordinator\|jinn\|restoration\|restorer\|solverType\|prediction\.v\|polymarket\|on-chain\|knowledge-tree\|walkArtifacts\|RestorerImpl\|buildRestorerImpls\|jinn\.state_transition\|JINN_CLAUDE_CODE_LEARNER\|jinn\.local' \
  client/plugins/claude-code-learner/README.md \
  client/plugins/claude-code-learner/CLAUDE.md \
  client/plugins/claude-code-learner/AGENTS.md \
  client/plugins/claude-code-learner/.claude-plugin/plugin.json \
  client/plugins/claude-code-learner/hooks/session-start
```

Expected: only matches are the `Jinn Network` author attribution in `plugin.json` (intentional). No coordinator references, no `jinn.local`, no other vocabulary.

If any other match appears, fix it inline before committing.

- [ ] **Step 7: Commit**

```bash
git add client/plugins/claude-code-learner/.claude-plugin/plugin.json \
        client/plugins/claude-code-learner/hooks/session-start \
        client/plugins/claude-code-learner/README.md \
        client/plugins/claude-code-learner/CLAUDE.md \
        client/plugins/claude-code-learner/AGENTS.md
git commit -m "$(cat <<'EOF'
plugin(learner): rewrite docs + manifest + hook for generic plugin

Stage 5 of plugin simplification + decoupling. Plugin manifest
description, README, CLAUDE.md, and AGENTS.md describe a generic
learning-agent plugin — no Jinn vocabulary in plugin content. The
SessionStart hook's git-author email drops the jinn.local domain.
The Jinn Network author attribution is preserved as factual provenance.

Old skills/coordinator + 7 phase skills + agents/ are still on disk
at this point; deletion is the next stage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Delete the old plugin layout

**Files:**
- Delete: `client/plugins/claude-code-learner/skills/{coordinator,orient,strategize,plan,execute,debrief,improve,memory-consolidation}/`
- Delete: `client/plugins/claude-code-learner/agents/`

- [ ] **Step 1: Confirm nothing references the old paths**

```bash
grep -rn 'skills/coordinator\|skills/orient\|skills/strategize\|skills/plan/SKILL\|skills/execute/SKILL\|skills/debrief\|skills/improve\|skills/memory-consolidation\|claude-code-learner:coordinator\|claude-code-learner:orient\|claude-code-learner:strategize\|claude-code-learner:plan\b\|claude-code-learner:execute\|claude-code-learner:debrief\|claude-code-learner:improve\|claude-code-learner:memory-consolidation\|claude-code-learner/agents/' \
  --include='*.ts' --include='*.md' --include='*.json' \
  client/ docs/ 2>/dev/null \
  | grep -v 'docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md' \
  | grep -v 'docs/superpowers/specs/2026-05-06-claude-code-learner-plugin-simplification-design.md' \
  | grep -v 'docs/superpowers/plans/2026-05-06-claude-code-learner-plugin-simplification.md' \
  | grep -v 'client/plugins/claude-code-learner/skills/coordinator/\|client/plugins/claude-code-learner/skills/orient/\|client/plugins/claude-code-learner/skills/strategize/\|client/plugins/claude-code-learner/skills/plan/\|client/plugins/claude-code-learner/skills/execute/\|client/plugins/claude-code-learner/skills/debrief/\|client/plugins/claude-code-learner/skills/improve/\|client/plugins/claude-code-learner/skills/memory-consolidation/\|client/plugins/claude-code-learner/agents/'
```

Expected: empty output. If any remaining hit exists outside the excluded set, fix it before proceeding.

- [ ] **Step 2: Remove the old skill directories**

```bash
rm -rf client/plugins/claude-code-learner/skills/coordinator \
       client/plugins/claude-code-learner/skills/orient \
       client/plugins/claude-code-learner/skills/strategize \
       client/plugins/claude-code-learner/skills/plan \
       client/plugins/claude-code-learner/skills/execute \
       client/plugins/claude-code-learner/skills/debrief \
       client/plugins/claude-code-learner/skills/improve \
       client/plugins/claude-code-learner/skills/memory-consolidation
```

- [ ] **Step 3: Remove the agents/ directory**

```bash
rm -rf client/plugins/claude-code-learner/agents
```

- [ ] **Step 4: Confirm the new layout is the only one**

```bash
ls client/plugins/claude-code-learner/skills/
```
Expected: `learn` (only).

```bash
ls client/plugins/claude-code-learner/
```
Expected: `.claude-plugin AGENTS.md CLAUDE.md README.md hooks skills` (no `agents` directory).

- [ ] **Step 5: Run the full learner test suite**

```bash
cd client && yarn test test/harnesses/impls/claude-code-learner/
```
Expected: all tests pass.

- [ ] **Step 6: Run typecheck and the full test suite**

```bash
cd client && yarn typecheck && yarn test
```
Expected: zero errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A client/plugins/claude-code-learner/
git commit -m "$(cat <<'EOF'
plugin(learner): delete coordinator + phase skills + agents/

Stage 6 of plugin simplification + decoupling. The orchestrator skill
(skills/learn) drives the pipeline; the harness adapter (stage 3)
invokes it. Removes 8 obsolete skill directories and the agents/
subagent registry.

Net: 8 skills + 7 agents (15 files) → 1 skill + 7 prompt files (8 files).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full e2e verification

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm git status is clean**

```bash
git status --short -- client/plugins/claude-code-learner/ \
                       client/src/harnesses/impls/claude-code-learner/ \
                       client/test/harnesses/impls/claude-code-learner/
```
Expected: empty output.

- [ ] **Step 2: Run typecheck**

```bash
cd client && yarn typecheck
```
Expected: zero errors.

- [ ] **Step 3: Run unit tests**

```bash
cd client && yarn test
```
Expected: all tests pass.

- [ ] **Step 4: Run e2e**

```bash
cd client && yarn e2e
```
Expected: full loop completes on the Anvil fork. The `prediction.v1` solution payload is produced at `workingDir/.execute/prediction-v1-solution.json` (enforced by the harvester, not the plugin). All seven phase artifacts exist under `workingDir/.<phase>/`.

If `yarn e2e` cannot run locally, document that the e2e gate is owed in CI before merge.

- [ ] **Step 5: Final inventory check**

```bash
find client/plugins/claude-code-learner -type f \! -path '*/node_modules/*' | sort
```

Expected output (set, not strictly ordered):

```
client/plugins/claude-code-learner/.claude-plugin/plugin.json
client/plugins/claude-code-learner/AGENTS.md
client/plugins/claude-code-learner/CLAUDE.md
client/plugins/claude-code-learner/README.md
client/plugins/claude-code-learner/hooks/hooks.json
client/plugins/claude-code-learner/hooks/session-start
client/plugins/claude-code-learner/skills/learn/SKILL.md
client/plugins/claude-code-learner/skills/learn/analyst-prompt.md
client/plugins/claude-code-learner/skills/learn/consolidator-prompt.md
client/plugins/claude-code-learner/skills/learn/explorer-prompt.md
client/plugins/claude-code-learner/skills/learn/planner-prompt.md
client/plugins/claude-code-learner/skills/learn/promoter-prompt.md
client/plugins/claude-code-learner/skills/learn/step-worker-prompt.md
client/plugins/claude-code-learner/skills/learn/strategist-prompt.md
```

13 files total.

- [ ] **Step 6: Vocabulary-scrub verification**

```bash
grep -ri -E 'jinn|restoration|restorer|solverType|prediction\.v|polymarket| HL |on-chain|knowledge-tree|walkArtifacts|RestorerImpl|buildRestorerImpls|jinn\.state_transition|JINN_CLAUDE_CODE_LEARNER|jinn\.local' \
  client/plugins/claude-code-learner/
```

Expected: only matches are the `Jinn Network` author attribution in `plugin.json` (intentional factual provenance). No other Jinn vocabulary in plugin content.

If any other match appears, fix it before reporting the migration complete.

- [ ] **Step 7: Walk acceptance criteria from spec §12**

For each bullet in the spec's §12 acceptance criteria, verify it holds:

- `client/plugins/claude-code-learner/skills/learn/SKILL.md` exists and is the only skill ✓
- `client/plugins/claude-code-learner/skills/learn/<role>-prompt.md` exists for all 7 roles ✓
- `client/plugins/claude-code-learner/agents/` does not exist ✓
- `client/plugins/claude-code-learner/skills/{coordinator,orient,strategize,plan,execute,debrief,improve,memory-consolidation}/` do not exist ✓
- The harness adapter's initial prompt names `claude-code-learner:learn` ✓
- Vocabulary scrub grep returns only `Jinn Network` author attribution ✓
- `LEARNER_PHASE_RANGE` is the only env-var name; no `JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE` references in production code/tests ✓
- `hooks/session-start` sets git author email to `claude-code-learner@local` ✓
- `yarn typecheck`, `yarn test`, and `yarn e2e` pass ✓
- The prediction-v1 default-prediction-agent harness test passes ✓
- A successful `prediction.v1` run produces all seven phase artifacts plus `workingDir/.execute/prediction-v1-solution.json` ✓
- `README.md` no longer references a non-existent `validate-plugin.mjs` ✓

If any criterion fails, fix and re-run from Step 1.

- [ ] **Step 8: Done — no further commit**

This task only verifies state created by stages 1–6. Migration is complete when every checkbox is checked and the acceptance walk in Step 7 finishes clean.
