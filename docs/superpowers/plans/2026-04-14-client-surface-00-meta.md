# Client Surface — Meta Implementation Plan

> **Orchestration document.** Not itself a task list — it dispatches the four plans below in the correct order so an autonomous session can take the whole client surface from spec to running binary without human intervention at the plan boundaries.

**Goal of the whole track:** Ship the `jinn` CLI surface defined in `spec/2026-04-14-client-surface.md` — a stable, headless, JSON-by-default command-line interface an AI coding agent can call to drive the Jinn client without reading source code.

**Scope:** Four implementation plans, executed in a dependency-respecting order, producing one `jinn` binary with ~15 verbs, full test coverage per plan, and a coherent error envelope across every non-zero exit.

**Executor:** An autonomous session using **`superpowers:subagent-driven-development`** (recommended) or **`superpowers:executing-plans`**. Either is fine; this meta plan is compatible with both.

---

## The four plans

| # | File | Scope | Tasks | Depends on |
|---|---|---|---|---|
| 01 | [`2026-04-14-client-surface-01-envelope.md`](./2026-04-14-client-surface-01-envelope.md) | Error envelope module, exit codes, `main.ts` rewiring, `claude` binary preflight, debug-default flip | 6 | Nothing |
| 02 | [`2026-04-14-client-surface-02-cli-scaffold.md`](./2026-04-14-client-surface-02-cli-scaffold.md) | `jinn` binary, dispatch scaffold, lifecycle verbs (version, doctor, init, bootstrap, fund-requirements, run, stop) | 13 | Plan 01 |
| 03 | [`2026-04-14-client-surface-03-introspection.md`](./2026-04-14-client-surface-03-introspection.md) | Introspection verbs (status, fleet, balance, history, rewards, logs) + four assemblers | 9 | Plan 02 |
| 04 | [`2026-04-14-client-surface-04-actions.md`](./2026-04-14-client-surface-04-actions.md) | Action verbs (submit-intent, claim-rewards, fleet scale, fleet retire, withdraw, keys backup) + shared dry-run/confirm helpers | 8 | Plan 02 |

**Total:** 36 tasks across four plans, ~7000 lines of plan content. Estimated implementation time: 3–6 focused working sessions depending on executor velocity and how many real adapter wiring follow-ups are pulled forward.

---

## The dependency DAG

```
          ┌──────────────────────────────┐
          │ 01  Error envelope foundation │
          └──────────────┬───────────────┘
                         │
                         ▼
          ┌──────────────────────────────┐
          │ 02  CLI scaffold + lifecycle  │
          └──────┬────────────────┬──────┘
                 │                │
                 ▼                ▼
    ┌──────────────────┐  ┌──────────────────┐
    │ 03 Introspection │  │ 04  Actions       │
    └──────────────────┘  └──────────────────┘
```

- **01 → 02**: plan 02 imports `emitEnvelope`, `EXIT_CODES`, `checkClaudeBinary` from files plan 01 creates. Trying to run plan 02 before plan 01 lands fails at first `import`.
- **02 → 03, 02 → 04**: plans 03 and 04 both register new commands in `client/src/cli/index.ts`'s `COMMANDS` array, which plan 02 creates. They also import `CommandModule`, `CommandContext`, and the output helpers.
- **03 and 04 are siblings** — they touch disjoint files except for `client/src/cli/index.ts`. Either order is valid; running them in parallel is safe if the executor can handle two concurrent sessions and rebases the `COMMANDS` array after each.

**Recommended execution order (serial, single autonomous session):**

```
01  →  02  →  03  →  04
```

Rationale: serial is simpler than parallel. The extra ~10 minutes of wall-clock is negligible compared to the cognitive load of coordinating parallel plan execution. Run serial unless you have a specific reason to parallelize.

---

## Execution protocol

### Preflight (once, before starting any plan)

1. **Confirm worktree and branch.** The autonomous session should be
   running inside a git worktree, ideally on a dedicated branch for
   this work:

   ```bash
   pwd             # expect: .../jinn-mono/.worktrees/jinn-client-surface or similar
   git branch --show-current    # expect: ale/jinn-client-surface or a descendant
   git status                   # expect: clean
   ```

   If the branch is not clean, stop and surface the state before
   starting. Do not mix uncommitted changes into plan execution.

2. **Confirm the spec exists.** Every plan references
   `spec/2026-04-14-client-surface.md`. Sanity check:

   ```bash
   test -f spec/2026-04-14-client-surface.md && echo ok
   ```

   If missing, stop — the plans can't be executed without the spec.

3. **Install deps.** The plans assume `client/node_modules` is
   populated:

   ```bash
   cd client && npm install
   ```

   Leave the `cwd` at `client/` or adjust paths per task.

4. **Baseline test run.** Record the current test count so you can
   compare against it after each plan lands:

   ```bash
   cd client && npx vitest run 2>&1 | tail -3
   ```

   Note the "Tests X passed" line. Every plan's "Final verification"
   task expects this count to grow by a known delta.

### Running a plan (once per plan)

For each plan in order:

1. **Announce which plan is starting.** Post a single-line message:
   `Starting plan NN — <plan title>`.

2. **Dispatch plan execution.** The executor's choice:

   - **Subagent-driven (preferred):** For each task in the plan,
     spawn a fresh subagent with the task's content, let it work
     through the steps, review the subagent's diff, and merge. This
     is what `superpowers:subagent-driven-development` orchestrates.
     See that skill's docs for the exact dispatch loop.

   - **Inline execution:** Walk the task list in the current
     session, executing each step in turn. Use
     `superpowers:executing-plans` to structure checkpoints.

3. **Follow the plan exactly.** Every step in every plan has
   complete code. Do not improvise alternative implementations. If
   a step's code does not compile or test, report the gap and stop;
   do not silently fix.

4. **Run the plan's Final Verification task.** Every plan ends with
   a "Final verification" task that typechecks, runs the full test
   suite, and smoke-tests the new verbs. It MUST pass before moving
   to the next plan. If it fails, stop and surface the failure.

5. **Between-plan checkpoint.** After the plan's final commit, run:

   ```bash
   cd client && npx tsc --noEmit && npx vitest run 2>&1 | tail -5
   git log --oneline -5
   ```

   Confirm:
   - Zero type errors.
   - Test count grew by the expected delta (each plan's Final
     Verification task specifies the delta).
   - The last commit is the one the plan's final task produced.

   If any of these are wrong, stop. Do not start the next plan with
   a broken predecessor.

### Between plans

- **Do not edit source files outside of a plan's task list.** The
  plans are sequenced so each one touches disjoint files (modulo
  `client/src/cli/index.ts`'s `COMMANDS` array, which every plan ≥
  02 edits). Improvisation across plan boundaries breaks this
  property.

- **Do not merge plan branches early.** All four plans commit to
  the current branch in sequence. If the executor uses a subagent
  per task, each subagent commits to the parent branch; no merge
  is needed between plans.

- **Expect `client/src/cli/index.ts` merge conflicts** if plans 03
  and 04 are run in parallel. The fix is always: both sets of
  imports + both sets of COMMANDS entries, in the order the plans
  specify. This is the only file where order matters.

### Done conditions

The whole track is complete when all of the following are true:

1. All four plans have run their Final Verification task
   successfully.
2. `cd client && npx tsc --noEmit` is clean.
3. `cd client && npx vitest run` is green with ≥ 146 + 6 + 4 + 2 (plan 01)
   + ~26 (plan 02) + ~16 (plan 03) + ~20 (plan 04) = **≥ 216 tests**.
4. `cd client && ./bin/jinn --help` lists every verb from the spec.
5. `cd client && ./bin/jinn version --json | jq '.schemaVersion'`
   returns `1`.
6. `cd client && ./bin/jinn doctor --json | jq '.ok, .blockingCount'`
   returns a boolean followed by a number.
7. `cd client && ./bin/jinn submit-intent --id smoke --description "x" --dry-run | jq '.dryRun'`
   returns `true`.
8. Spec §2 (vocabulary), §4 (JSON shapes), §5 (exit codes), §6
   (error envelope), §7 (rules) are each covered by at least one
   task in at least one plan (cross-reference the "Spec coverage"
   tables at the end of each plan).

### Failure recovery

If a plan fails mid-execution:

- **Do not discard committed work.** Every task commits
  independently; interrupted plans leave behind valid, tested
  commits for the tasks that did land.
- **Identify the last completed task.** Run
  `git log --oneline --grep "client(cli)" -20` or similar and find
  the last task's commit message.
- **Resume from the next task in the plan.** Start the first
  unfinished step; do not re-run completed tasks.
- **If a task's test file already exists,** the task's "Write the
  failing test" step has already landed. Skip to the implementation
  step.

---

## After the track finishes

This meta plan does **not** cover:

- Retiring legacy entrypoints (`npm run start`, `npm run status`,
  `npm run withdraw`). A later plan will remove them once the CLI
  has been exercised in production.
- Wiring real adapter calls into the stubbed action verbs
  (`submit-intent`, `claim-rewards`, `fleet scale`, `fleet retire`,
  `withdraw`). Plan 04 ships each verb with a `--dry-run` path that
  is fully wired and an execute path that emits a spec-correct JSON
  response but includes `"note": "pending in follow-up commit"`. A
  "plan 04b" follows to wire the real transactions once the
  adapter constructor surface stabilizes.
- Per-service wallet balances in `jinn fleet` and `jinn balance`.
  Plan 03 returns `0` for these because the underlying gatherer
  does not yet read per-wallet balances. A later plan extends
  `client/src/api/gather-status.ts` with the additional reads.
- HTTP endpoints for the new introspection verbs (`GET /v1/fleet`,
  `/v1/balance`, `/v1/history`, `/v1/rewards`). Plan 03 currently
  gathers locally from every CLI invocation. A later plan wires the
  assemblers into `client/src/api/server.ts` for remote access.
- Password-via-file-descriptor (`--password-fd N`) as an alternative
  to `JINN_PASSWORD`. Spec §7.1 requires it; a small follow-up adds
  `readPasswordFd()` and wires it into every password-reading verb.

These deferrals are deliberate. Each is a plan-sized unit that can
land independently once the main track is done.

---

## Handoff message template

When starting execution, post this to the session log:

```
Starting client surface implementation track.

Plans (run in order):
  01 → 02 → 03 → 04

Current branch: <branch>
Current head:   <sha>
Spec:           spec/2026-04-14-client-surface.md

Starting plan 01 — Error Envelope Foundation.
```

When finishing each plan:

```
Plan NN complete.
Commits:   <range>
Tests:     <old> → <new>
Next:      plan <NN+1>
```

When the track is complete:

```
Client surface track complete.
All four plans landed.
Final test count: <N>
Final verb count: <M>
Ready for review.
```

---

## References

- Spec: `spec/2026-04-14-client-surface.md`
- Discovery doc: `docs/planning/2026-04-jinn-client-surface.md`
- Plan 01: `docs/superpowers/plans/2026-04-14-client-surface-01-envelope.md`
- Plan 02: `docs/superpowers/plans/2026-04-14-client-surface-02-cli-scaffold.md`
- Plan 03: `docs/superpowers/plans/2026-04-14-client-surface-03-introspection.md`
- Plan 04: `docs/superpowers/plans/2026-04-14-client-surface-04-actions.md`
- Execution skills: `superpowers:subagent-driven-development`, `superpowers:executing-plans`
