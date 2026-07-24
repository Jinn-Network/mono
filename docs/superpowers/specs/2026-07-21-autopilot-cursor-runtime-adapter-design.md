# Design: Autopilot Cursor CLI runtime adapter

- **Version:** 0.1 (spike)
- **Date:** 2026-07-21
- **Author:** Autopilot spike (Cursor runtime)
- **Status:** Accepted — ready for feat
- **Component:** `packages/autopilot` dispatcher and `.claude/skills/autopilot-runtime`
- **Supersedes:** none
- **Related:** [`2026-07-17-autopilot-canonical-implement-issue-runtime-adapters-design.md`](2026-07-17-autopilot-canonical-implement-issue-runtime-adapters-design.md), [`docs/engineering/handbook.md`](../../engineering/handbook.md) §Routing axes

## Motivation

Autopilot today supports two process-wide runtimes: Claude (`claude -p`) and
Hermes (`jinn-hermes-stateless.py chat -q`). Operators with a Cursor
subscription can run the Cursor Agent CLI (`agent`) headlessly, but Autopilot
does not spawn it. Skills are already symlinked into `.cursor/skills/` for
interactive Cursor use; the gap is dispatch mechanics and Effort semantics.

Goal: validate whether Cursor Agent CLI can be a third process-wide Autopilot
runtime (`JINN_AUTOPILOT_RUNTIME=cursor`) with the same lifecycle contract as
Claude and Hermes, and define how board **Effort** maps under Cursor.

This spike does **not** ship production wiring.

## Locked decisions

| Decision | Choice |
|----------|--------|
| Work shape | Spike — design + probe evidence only |
| Routing | Process-wide only (`claude` \| `hermes` \| `cursor`) |
| Per-issue / per-stage runtime | Not in scope (deferred #887 lineage stays deferred) |
| Worktree ownership | Autopilot worktrees; use `agent --workspace`, not `agent -w` |
| Sync shim for v1 | **Not required** — see Findings |

## Spike probe log

Environment: Cursor Agent CLI `2026.07.17-3e2a980`, macOS arm64, Pro+
subscription, logged in via `agent login` (`agent status` → ✓).

### Auth

| Probe | Result |
|-------|--------|
| `agent status` | ✓ Logged in; prints email |
| `agent about` | Reports subscription tier, default model |
| `CURSOR_API_KEY` | Documented in `--help`; alternative to login |
| Boot gate (proposed) | `agent status` or `agent about` non-zero → fail loud at dispatcher start (mirror Hermes `assertHermesRuntimeReady`) |

### Headless contract (`-p`)

| Probe | Command / prompt | Result |
|-------|------------------|--------|
| Workspace isolation | `agent -p --force --trust --sandbox disabled --workspace <tmpdir> "Read test.txt…"` | ✓ `PROBE_OK` (~11s) |
| Session lifetime | Same | Process exits after task completes; no early detach |
| Single Task child | Prompt: launch one `Task` subagent, wait, reply `PARENT_RECEIVED: CHILD_SYNC_OK` | ✓ Exact match (~19s) |
| Parallel Task children | Prompt: two `Task` subagents in one turn, wait for both | ✓ `PARALLEL_OK` (~24s) |
| Nested Task redelegation | Parent → child Task → nested grandchild Task | ✓ `CHILD_GOT: NESTED_OK` (~31s) |
| Skill discovery | Prompt: list skills containing `implement-issue` or `autopilot` | ✓ `implement-issue`, `autopilot-runtime` (repo `.cursor/skills` symlinks) |
| Output `text` | default | Plain stdout |
| Output `json` | `--output-format json` | Single JSON object with `result`, `duration_ms`, `usage` |
| Output `stream-json` | `--output-format stream-json --stream-partial-output` | NDJSON events; suitable for live dispatcher logs |

**Conclusion:** `agent -p` is a finite request/response surface that **joins**
Task subagent work synchronously, including **one level of nested Task
redelegation** (parent → child → grandchild). No Jinn-owned launcher shim is
required for v1 (contrast with Hermes `async_delivery=False` binding).

**Caveat on nesting depth:** Autopilot still must not rely on deep in-process
Task trees for depth-needing stages. Claude and Hermes reset depth at the OS
process boundary via `stage:run`. Cursor should do the same — nested Task is a
bonus for stage-internal fan-out, not a substitute for fresh-root stages.

### Effort / model parameterization

| Probe | Result |
|-------|--------|
| `claude-opus-4-8-thinking[effort=low]` | **Rejected** — CLI lists available models; bracket syntax not accepted |
| `claude-opus-4-8-thinking-low` | Usage limit on probe account (Opus quota exhausted) |
| `gpt-5.3-codex-low` | Usage limit on probe account |
| `composer-2.5` | ✓ Works; no effort suffix variants except `composer-2.5-fast` |

**Conclusion:** Bracket `--model '…[effort=…]'` is not usable on the tested CLI.
v1 Autopilot Effort routing therefore picks **whole catalog models** (Composer
vs Grok tiers) — see the fixed table below — rather than family suffixes or
bracket params.

### Worktree semantics

Autopilot must pass `--workspace "$WORKTREE_PATH"` (absolute path to the
dispatcher-created worktree). Do **not** use `agent -w/--worktree` — Cursor
would create its own worktree under `~/.cursor/worktrees/`, conflicting with
Autopilot's branch/worktree lifecycle.

### MCP / approvals

Headless runs use `--force` / `--yolo` (alias) and `--trust` for workspace
approval. `--approve-mcps` was not required in probes (no MCP-dependent
prompts). Feat should pass `--approve-mcps` when Autopilot stages rely on MCP
tools, or document that MCP servers must be pre-approved in operator config.

## Effort semantics across runtimes

Board Effort (`Low` \| `Medium` \| `High` \| `XHigh` \| `Max`) is the
**implementation reasoning-depth signal** ([handbook §Routing axes](../../engineering/handbook.md)).
Review and merge-prep sessions do not receive Effort today.

### Claude

`--effort <tier>` on `claude -p`, lowercased board value (`Max` → `max`).
Unset Effort → omit flag → Claude default.

### Hermes

`reasoning_effort` in per-session `$HERMES_HOME/config.yaml` via
`hermesReasoningEffort()` ([`hermes-home.ts`](../../../packages/autopilot/src/dispatcher/hermes-home.ts)).
`Max` collapses to `xhigh` (Hermes has no `max` tier). Unset → omit key.

### Cursor (proposed) — cross-family Effort routing

Cursor has no separate effort flag. Autopilot maps board Effort to **distinct
catalog models** (not suffixes within one family). This is intentional: Low
work stays on a cheap/fast Composer path; Medium+ steps up to Grok 4.5.

**Semantic mismatch vs Claude/Hermes:** those vary reasoning depth on a fixed
model; Cursor Effort routing **selects the model**. Effort remains the Project
field — operators must not encode Effort into env overrides.

### Board Effort → Cursor model mapping (v1 default)

Implement `cursorModelForEffort(effort)` in a future `cursor-runtime.ts` with
this **fixed** table (catalog ids from `agent models`, 2026-07-21):

| Board Effort | Cursor `--model` value | Rationale |
|--------------|------------------------|-----------|
| Low | `composer-2.5` | Cheap/fast path for light issues |
| Medium | `cursor-grok-4.5-medium` | Mid-tier Grok |
| High | `cursor-grok-4.5-high` | Top Grok tier |
| XHigh | `cursor-grok-4.5-high` | No higher Grok slug — collapse to High |
| Max | `cursor-grok-4.5-high` | Same as High (operator request) |
| unset | `cursor-grok-4.5-high` | Same as XHigh when Effort absent |

Review / merge-prep: no Effort mapping — use
`JINN_DISPATCHER_CURSOR_MODEL` if set, else default `cursor-grok-4.5-high`.

#### Fast variants

Do **not** map Effort to `-fast` slugs (`composer-2.5-fast`,
`cursor-grok-4.5-high-fast`, …) in v1. Optional later:
`JINN_DISPATCHER_CURSOR_FAST=1`.

#### Overrides

`JINN_DISPATCHER_CURSOR_MODEL` is **not** an implement Effort base family.
It only pins review/merge-prep (and any session that passes `effort: null`).
Implement sessions always use the table above unless a future env override
table is added.

### Effort validation at boot

On `JINN_AUTOPILOT_RUNTIME=cursor`, probe that the three models in the table
(`composer-2.5`, `cursor-grok-4.5-medium`, `cursor-grok-4.5-high`) appear in
`agent models` (or fail loud with remediation). Do not require Opus/Codex
families for the default route.

## Mechanism mapping

Autopilot mechanisms ([`autopilot-runtime/SKILL.md`](../../../.claude/skills/autopilot-runtime/SKILL.md))
map to Cursor as follows.

| Mechanism | Claude | Hermes | Cursor (proposed) |
|-----------|--------|--------|-------------------|
| fresh-root | `yarn stage:run` → `claude -p` | `yarn stage:run` → stateless Hermes | `yarn stage:run` → `agent -p …` |
| sync-parallel child | Multiple Agent-tool calls, one turn | `delegate_task` sync batch | Multiple `Task` tool calls, one turn |
| lightweight child | One Agent-tool child | One `delegate_task` | One `Task` child |
| coordinator-root | In-process coordinator | In-process coordinator | In-process coordinator |

**Depth / fan-out:** Stages that need internal fan-out must still use
**fresh-root** (`stage:run` → new `agent -p` process), same as Claude/Hermes.
Do not rely on nested Task depth alone — each fresh root is depth-0.

**Sync shim:** Not required. Probes show `-p` waits for Task completion
(including nested grandchild Tasks).

**v1 restriction if probes regress on other accounts:** coordinator-root +
fresh-root only; disable in-process Task fan-out in the Cursor skill reference.
Not needed given current probe results.

## Systems matchup: implement-issue topology

`implement-issue` does **not** require unbounded nesting of in-process
subagents. It requires a **two-layer** topology (from the Hermes adapter
design):

```text
coordinator root (OS process A)
├── lightweight child          ← Stages 2, 6, 7, 8
└── stage:run → fresh root     ← Stages 1, 3, 4, 5  (OS process B, depth-0)
    ├── optional stage-internal children (TDD / parallel agents)
    └── return stage report to coordinator
```

Depth-needing stages are fresh OS processes so each stage may fan out
internally without hitting a depth-2 ceiling. Lightweight stages stay
in-process under the coordinator.

### Stage-by-stage Cursor fit

| Stage | Mechanism | Cursor match |
|-------|-----------|--------------|
| Coordinator | OS `agent -p` | ✓ Same as Claude/Hermes coordinator role |
| 1 Design | fresh-root | ✓ `yarn stage:run` → new `agent -p` |
| 2 Plan | lightweight child | ✓ Task child under coordinator; sync join verified |
| 3 Implement | fresh-root (+ optional internal fan-out) | ✓ Fresh `agent -p`; nested Task redelegation verified for stage-internal children |
| 4 Code review | fresh-root | ✓ |
| 5 Independent review | **separate** fresh-root | ✓ New `agent -p` (independence = new process, not nested Task) |
| 6 Security | lightweight child | ✓ Task child |
| 7 App test | lightweight child | ✓ Task child |
| 8 Verify + PR | lightweight child | ✓ Task child |

### What matches closely

- Process-wide runtime switch (no mixed Claude coordinator + Cursor stages).
- Fresh-root via `stage:run` resetting depth at the OS boundary.
- Sync join for in-process children (and at least one nested Task level).
- Skill loading from repo skill dirs.
- Headless decide-don't-ask via `--force` / `--trust` (analogous to Claude print-mode + Hermes `--yolo`).
- Stage 3 ≠ Stage 5 as separate OS processes (independence invariant).

### Where Cursor diverges (manageable)

| Concern | Claude / Hermes | Cursor | Impact |
|---------|-----------------|--------|--------|
| Effort | Separate flag / config key | Cross-family model pick (Composer / Grok) | Fixed Effort→model table; Effort stays Project-field |
| Depth policy | Hermes `max_spawn_depth=1` explicit | Nested Task worked in probe; ceiling undocumented | Still use `stage:run` for depth-needing stages — do not depend on deep Task trees |
| Sync delivery | Hermes needed Jinn launcher | Native `-p` joins Tasks | Simpler than Hermes |
| Auth / billing | Claude Max / Codex OAuth guards | Cursor login / `CURSOR_API_KEY`; usage limits fail loud | Boot probe + fail issue on `ActionRequiredError` |
| Method skills | Claude/Hermes skill names | Same canonical skills via `.cursor/skills` symlinks | Closest-skill resolution same as Hermes |
| Subagent types | Claude Agent tool / Hermes `delegate_task` | Cursor `Task` + `subagent_type` | Adapter reference maps names; checklist gates stay in `implement-issue` |

### What Autopilot must not do under Cursor

1. Launch Stages 1/3/4/5 as Task children of the coordinator (would burn nesting
   budget and break Stage 5 independence).
2. Use `agent -w` for isolation (Autopilot owns worktrees).
3. Treat nested Task as a substitute for `stage:run`.
4. Use `JINN_DISPATCHER_CURSOR_MODEL` to override implement Effort routing
   (that env is review/merge-prep only; implement uses the fixed table).

### Residual risk (feat should re-probe)

- Nesting was verified to **depth 2** (parent → child → grandchild) on
  `composer-2.5`. Deeper trees, or nesting under Opus/Sol families, were not
  probed. If a Stage 3 skill tries depth-3 Task chains, prefer shelling out to
  `yarn stage:run` for the inner fan-out that needs its own children.
- Parallel nested grandchildren (A→B→C and A→D→E concurrently) were not probed.

## Proposed headless argv

```bash
agent -p --force --trust --sandbox disabled \
  --workspace "$WORKTREE_PATH" \
  --model "$CURSOR_MODEL" \
  --output-format text \
  "$PROMPT"
```

Dispatcher sets `JINN_AUTOPILOT_RUNTIME=cursor`. Prompt composition mirrors
Claude/Hermes: canon (`CLAUDE.md` + handbook) + headless override (reframed
for `` `agent -p` ``) + `Use the <skill> skill…` + scenario.

### Proposed env surface (feat)

| Env | Purpose |
|-----|---------|
| `JINN_AUTOPILOT_RUNTIME=cursor` | Process-wide runtime |
| `JINN_DISPATCHER_CURSOR_MODEL` | Fixed model for review/merge-prep only (default `cursor-grok-4.5-high`); does **not** change implement Effort routing |
| `JINN_DISPATCHER_CURSOR_BIN` | Optional path to `agent` (default: `agent` on `PATH`) |
| `CURSOR_API_KEY` | Optional; else `agent login` session |

No `cursor-home` directory — implement Effort selects `--model` from the fixed
table; review/merge-prep use `JINN_DISPATCHER_CURSOR_MODEL` or `cursor-grok-4.5-high`.

## Integration sketch (follow-up feat)

Extend the existing if/else spawn sites (same pattern as Hermes):

1. [`packages/autopilot/src/autopilot-runtime.ts`](../../../packages/autopilot/src/autopilot-runtime.ts) — add `'cursor'` to union + parser
2. [`packages/autopilot/src/dispatcher/coordinator-session.ts`](../../../packages/autopilot/src/dispatcher/coordinator-session.ts) — third branch in `spawnCoordinatorSession`
3. [`packages/autopilot/src/dispatcher/run-stage.ts`](../../../packages/autopilot/src/dispatcher/run-stage.ts) — third branch in `runStageHeadless`
4. **New** `packages/autopilot/src/dispatcher/cursor-runtime.ts` — `cursorAgentArgs()`, `cursorModelForEffort(effort)` (fixed Composer/Grok table), `assertCursorRuntimeReady()`
5. [`packages/autopilot/src/headless.ts`](../../../packages/autopilot/src/headless.ts) — `buildCursorHeadlessPrompt()`, extend `headlessOverrideFor('cursor')`
6. [`packages/autopilot/scripts/run-autopilot.ts`](../../../packages/autopilot/scripts/run-autopilot.ts) — parse env, boot probe
7. [`.claude/skills/autopilot-runtime/SKILL.md`](../../../.claude/skills/autopilot-runtime/SKILL.md) + **new** `references/cursor.md`
8. [`docs/engineering/handbook.md`](../../engineering/handbook.md) — Effort sentence for Cursor runtime
9. Tests mirroring Hermes: `dispatch.test.ts`, `run-stage.test.ts`, `coordinator-session.test.ts`, `autopilot-runtime.test.ts`

Lifecycle dispatch files (`dispatch.ts`, `review-dispatch.ts`, `merge-prep-dispatch.ts`)
stay runtime-agnostic — they already call `spawnCoordinatorSession`.

## Non-goals

- Shipping `JINN_AUTOPILOT_RUNTIME=cursor` in this spike
- Per-issue implementer routing
- Cursor `-w` worktree creation
- Hermes → Cursor Composer via xAI OAuth
- Plugin registry / `RuntimeAdapter` interface refactor

## Follow-up feat acceptance criteria

1. `JINN_AUTOPILOT_RUNTIME=cursor` selects Cursor for coordinator, stages, review, and merge-prep.
2. Boot fails loud when `agent` is missing or not authenticated.
3. Implement sessions map board Effort → `--model` per the Composer/Grok table
   (`Low` → `composer-2.5`; `Medium` → `cursor-grok-4.5-medium`;
   `High`/`XHigh`/`Max`/`unset` → `cursor-grok-4.5-high`).
4. Review/merge-prep use `JINN_DISPATCHER_CURSOR_MODEL` or default `cursor-grok-4.5-high`
   (no Effort mapping).
5. `spawnCoordinatorSession` and `runStageHeadless` use `--workspace` pointing at Autopilot worktree.
6. Headless prompt uses `` `agent -p` `` framing in override block.
7. `references/cursor.md` documents fresh-root / Task / coordinator-root mechanisms.
8. Contract tests cover effort mapping, argv builder, and invalid runtime rejection.
9. Handbook updated with Cursor Effort behavior.

## Open questions (resolved by spike)

| Question | Answer |
|----------|--------|
| Does `-p` wait for Task children? | Yes |
| Parameterized `[effort=…]` syntax? | Not on tested CLI; use suffix slugs |
| Skills visible headless? | Yes (`.cursor/skills` symlinks) |
| Sync shim needed? | No for v1 |
| `cursor-home` needed? | No |

## Remaining open questions (for feat)

1. Pass `--approve-mcps` unconditionally or only when MCP config detected?
2. Dispatcher logging: `text` vs `json` vs `stream-json` for production?
3. Usage-limit errors (`ActionRequiredError`) — retry policy or fail issue?
4. Should `XHigh` ever diverge from `High`/`Max` if a higher Grok (or other) slug appears later?
