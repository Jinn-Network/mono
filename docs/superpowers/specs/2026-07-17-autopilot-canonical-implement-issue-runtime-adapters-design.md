# Design: Canonical implement-issue skill with runtime adapters

- **Version:** 0.1 (design)
- **Date:** 2026-07-17
- **Author:** Ritsu
- **Status:** Proposed — awaiting review
- **Component:** `packages/autopilot` dispatcher and `.claude/skills/implement-issue`

## Motivation

The Hermes coordinator feature introduced
`.claude/skills/implement-issue-hermes/SKILL.md` as a 118-line sibling of the
542-line canonical Claude lifecycle. The sibling says its contract is
identical, but it re-describes only part of that contract. It omits or weakens
load-bearing behavior including the human-surface gate, complete triage
classification, shape variants, composed skills, root-stage topology, PR-body
requirements, and guarded worktree cleanup. The two files will continue to
drift because lifecycle changes must be copied manually.

The first live Hermes run also exposed a separate process-lifecycle failure.
The coordinator was launched as `hermes chat -q`, called `delegate_task`,
received a detached-background handle, printed that it would resume later, and
then exited. The child result had no process or delivery channel to return to,
so the issue produced neither commits nor a PR.

Goal: make Claude and Hermes execute one lifecycle contract while preserving
the runtime mechanics each harness needs. Hermes must be able to fan out from
depth-needing stages, and a finite Hermes process must not exit before its
delegated children return.

## Findings

### Hermes already has the required synchronous delegation path

The installed Hermes runtime checks
`gateway.session_context.async_delivery_supported()` before detaching a
top-level delegation. If the active surface declares asynchronous delivery
unsupported, `delegate_task` calls its existing `_execute_and_aggregate()`
path: a batch still fans out children concurrently, but the parent joins the
batch and receives one consolidated result inline.

`hermes chat -q` is a finite request/response surface but leaves that capability
unset. The default is `true`, which is correct for the interactive CLI and
wrong for a one-shot. This is the same failure class reported upstream for
Hermes Kanban workers:

- https://github.com/NousResearch/hermes-agent/issues/63169
- https://github.com/NousResearch/hermes-agent/issues/53027
- https://github.com/NousResearch/hermes-agent/pull/63218

There is no released CLI flag, environment variable, or config key that sets
this capability. The model-facing `delegate_task(background=false)` field is
explicitly ignored for top-level agents.

### A Jinn-owned launcher can bind the existing capability

A throwaway probe on 2026-07-17 invoked the installed Hermes Python environment,
called:

```python
set_session_vars(
    source="jinn-autopilot",
    cwd=os.getcwd(),
    async_delivery=False,
)
```

and then entered the normal `hermes chat -q` command path unchanged. The parent
delegated one child and returned:

```text
PARENT_RECEIVED: HERMES_SYNC_CHILD_OK
```

The probe exited successfully after 15 seconds. No file in the Hermes checkout
was modified.

### Depth is process-local

Claude avoids the depth-2 ceiling by launching Stages 1, 3, 4, and 5 through
`stage:run` as fresh `claude -p` operating-system processes. Each stage is
therefore a depth-0 root and may fan out depth-1 children.

Hermes needs the same topology. Making a depth-needing stage a
`delegate_task` child would make that stage depth 1 and prevent or constrain its
own fan-out. A process-local `max_spawn_depth=1` is sufficient only when every
depth-needing stage starts as a fresh depth-0 Hermes process.

## Decisions

### 1. One canonical lifecycle skill

`.claude/skills/implement-issue/SKILL.md` remains the only lifecycle source of
truth. `.claude/skills/implement-issue-hermes/SKILL.md` is removed.

The canonical skill owns:

- Issue and Project-field preconditions.
- Human-surface intake and PR-output gates.
- Reality-check classifications and side effects.
- Worktree, branch, status, escalation, and cleanup rules.
- The eight stage definitions and shape variants.
- Finding classification and retry behavior.
- External commit and PR guards.

The dispatcher invokes `implement-issue` for every coordinator and states which
runtime adapter is active. If an interactive invocation does not name an
adapter, the skill defaults to Claude for backward compatibility.

### 2. Thin adapter references own mechanics only

The skill gains two directly linked references:

```text
.claude/skills/implement-issue/
├── SKILL.md
└── references/
    ├── claude.md
    └── hermes.md
```

An adapter may define only:

- How to launch a fresh root stage.
- How to launch a lightweight child.
- Runtime-specific skill names that implement a canonical stage methodology.
- Required inherited environment and model/provider arguments.
- How a stage report returns to the coordinator.

An adapter must not redefine gates, stage deliverables, shape behavior,
escalation, shipping, or cleanup. Contract tests keep lifecycle markers in the
canonical file and reject their duplication in adapters.

The runtime mappings are:

| Canonical stage | Claude adapter | Hermes adapter |
|---|---|---|
| 1 Design | fresh `claude -p` root via `stage:run`; Claude brainstorming methodology | fresh stateless Hermes root via `stage:run`; Hermes planning/design methodology |
| 2 Plan | Agent-tool child | synchronous `delegate_task` child |
| 3 Implement | fresh `claude -p` root via `stage:run`; TDD + execution skills | fresh stateless Hermes root via `stage:run`; TDD + subagent-driven implementation skills |
| 4 Code review | fresh `claude -p` root via `stage:run` | fresh stateless Hermes root via `stage:run` |
| 5 Independent review | separate fresh `claude -p` root | separate fresh stateless Hermes root |
| 6 Security | Agent-tool child | synchronous `delegate_task` child |
| 7 App test | Agent-tool child | synchronous `delegate_task` child |
| 8 Verify + PR | Agent-tool child | synchronous `delegate_task` child |

The mapping changes mechanics, not deliverables or gates.

### 3. A temporary stateless Hermes launcher

Add a small Python entry point owned by `packages/autopilot`. It:

1. Binds Hermes session context with `async_delivery=False`.
2. Preserves the command arguments used by the normal Hermes CLI.
3. Calls `hermes_cli.main.main()` in the installed Hermes Python environment.
4. Clears the session context in a `finally` block.

The launcher neither implements delegation nor waits/polls itself. It selects
Hermes's existing synchronous behavior. This keeps fan-out concurrency inside
Hermes and avoids a Jinn fork of the runtime.

The dispatcher launches the helper with the Python interpreter from the Hermes
installation rather than spawning the `hermes` console script directly. Add a
dispatcher setting with an environment override:

```text
JINN_DISPATCHER_HERMES_PYTHON
```

The default follows the standard Hermes install:

```text
~/.hermes/hermes-agent/venv/bin/python
```

The existing bare model and explicit `openai-codex` provider remain
load-bearing and are forwarded unchanged. The per-issue `HERMES_HOME` remains
the source for auth, toolsets, skills, MCP wiring, and reasoning effort.

When an upstream Hermes release correctly marks generic one-shot invocations
as stateless, Jinn can remove the launcher and return to the normal CLI without
changing the skill or adapter contract.

### 4. `stage:run` becomes runtime-aware

`runStageHeadless` and `jinn-run-stage` accept a runtime selector:

```text
--runtime claude|hermes
```

Claude remains the default. The Claude path stays behaviorally unchanged.

For Hermes, the runner:

- Uses the stateless launcher and installed Hermes Python interpreter.
- Inherits the issue's `HERMES_HOME`.
- Passes the bare model and explicit provider.
- Uses the issue worktree as `cwd`.
- Captures stdout/stderr and returns the report using the existing
  `StageRunResult`.
- Reframes the headless override for `hermes chat -q`.

The dispatcher exports the active adapter plus Hermes runtime values into the
coordinator environment so adapter commands do not rediscover configuration:

```text
JINN_IMPLEMENT_ISSUE_ADAPTER=hermes
JINN_DISPATCHER_HERMES_PYTHON=<path>
JINN_DISPATCHER_HERMES_MODEL=gpt-5.6-sol
JINN_DISPATCHER_HERMES_PROVIDER=openai-codex
```

Every depth-needing Hermes stage is a new operating-system process and a new
depth-0 agent session. Its own `delegate_task` calls run synchronously from the
parent's perspective and may fan out concurrently inside the stage.

### 5. Process-local depth remains bounded

Do not increase Hermes `max_spawn_depth` merely to compensate for a stage that
was launched as a child. The architecture resets depth at the process boundary:

```text
coordinator root
├── lightweight delegate child
└── stage:run → fresh stage root
    ├── delegate child A
    ├── delegate child B
    └── delegate child C
```

The configured/default depth of 1 therefore allows fan-out at every root while
preventing unbounded grandchildren within one process.

## Error handling

- If the configured Hermes Python interpreter is absent or cannot import
  Hermes, fail before dispatch with the path and remediation. Do not fall back
  to the broken direct `chat -q` path.
- If the stateless launcher exits nonzero, propagate stderr and the exit code.
- If a root stage times out, retain the existing stage timeout result and let
  the canonical finding/escalation contract decide the outcome.
- If a Hermes child cannot complete, the synchronous result includes that
  failure; the coordinator applies the same finding handling as Claude.
- Never silently switch provider or model. The existing billing guards remain.

## Testing

Implementation follows TDD.

### Skill contract

- Baseline the current sibling against a realistic issue and record its omitted
  lifecycle/skill behavior.
- Assert there is one `implement-issue` lifecycle skill.
- Assert the canonical skill directly links both adapters.
- Assert both adapters are mechanics-only and do not duplicate lifecycle
  sections.
- Preserve regression coverage for triage, depth-needing stages, human-surface
  handling, shape variants, zero-commit/PR guards, and cleanup.

### Dispatcher and stage runner

- Hermes coordinator spawn uses the configured Python interpreter plus the
  stateless launcher, not the direct `hermes` executable.
- The coordinator prompt invokes canonical `implement-issue` and names the
  Hermes adapter.
- Claude behavior remains unchanged.
- Hermes root stages use the same stateless launcher with inherited
  `HERMES_HOME`, model, provider, canon, headless override, and worktree.
- Hermes and Claude stage reports, nonzero exits, and timeouts retain the same
  result contract.
- Generated Hermes config keeps the bare model, explicit provider, delegation
  toolset, and process-local depth policy.

### Verification

1. Run the Autopilot package typecheck and full test suite.
2. Run a direct stateless-launch smoke in which a parent receives an actual
   delegated child result.
3. Run one Low-effort issue through the full Autopilot route.
4. Observe fresh Hermes root stages and at least one stage-local fan-out.
5. Confirm commits, draft PR with `Closes #N` and `engine:review`, Project
   `Status: In Review`, and guarded worktree cleanup.

## Alternatives considered

### Drive an interactive `hermes chat` process

Omitting `-q` keeps Hermes alive and allows its interactive completion queue to
drain. It also requires pseudo-terminal control, prompt parsing, a new
machine-readable completion sentinel, and forced shutdown. This is a fragile
UI automation protocol and obscures when the pipeline is actually complete.
Rejected.

### Patch or fork the installed Hermes checkout

The upstream fix is small, but mutating an operator installation creates an
untracked fork and makes upgrades non-reproducible. Pinning a private fork
would create the same maintenance burden. Rejected while the launcher can bind
the existing capability without altering runtime files.

### Keep separate complete Claude and Hermes skills

Copying all 542 lines into the Hermes sibling would fix today's omissions but
retain the cause of drift. Every future lifecycle amendment would need a
coordinated two-file edit and parity review. Rejected.

## Rollout and rollback

Hermes routing remains opt-in through
`JINN_DISPATCHER_IMPLEMENTER_RULES`. Claude remains the default and its stage
path remains the compatibility baseline.

If live verification fails, remove the Hermes routing rule and park the test
issue; no Claude flow is affected. Do not push or open the feature PR until the
Hermes run reaches a real terminal outcome or cleanly escalates with verified
evidence.

## Out of scope

- Changing Hermes runtime source or submitting the upstream fix.
- Increasing arbitrary delegation depth.
- Replacing Hermes's own child scheduler or aggregation.
- Changing model/provider billing behavior.
- Changing the independent `review-pr` loop at the PR boundary.
