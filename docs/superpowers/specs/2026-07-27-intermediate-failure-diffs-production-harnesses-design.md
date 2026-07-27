# Emit intermediateFailureDiffs from production coding harnesses (#2225)

- **Version:** 0.1
- **Date:** 2026-07-27
- **Status:** design draft (Stage 1)
- **Issue:** [#2225](https://github.com/Jinn-Network/mono/issues/2225)
- **Depends on:** [#2130](https://github.com/Jinn-Network/mono/pull/2130) / [#1643](https://github.com/Jinn-Network/mono/issues/1643) redesign — engine already persists `Solution.intermediateFailureDiffs` at `RUNNING → POST_SNAPSHOT` (`normalizeIntermediateFailureDiffs` / `serializeIntermediateFailureDiffsJson`)
- **Parent design:** [`2026-07-25-intermediate-failure-diffs-harness-emitted-design.md`](./2026-07-25-intermediate-failure-diffs-harness-emitted-design.md) (retention seam; this issue wires the production emitters that design deferred)
- **Reference:** `apps/jinn-agent/plugins/jinn/__init__.py` `_on_post_tool_call` + `session_bridge.test_run_from_tool_call` / `accepted_diff` / `_is_test_command`
- **Parent contract:** [`spec/2026-07-08-task-creator-v0.md`](../../../spec/2026-07-08-task-creator-v0.md) §10 field 4

## Problem

The engine seam is live: a harness that returns `Solution.intermediateFailureDiffs` gets them normalized and written into `task_runs.intermediate_failure_diffs_json` on the single production-reachable `RUNNING → POST_SNAPSHOT` write. Production coding harnesses still omit the field (honest `[]` / undefined), so §10 field 4 feedstock never appears in real restoration runs.

Capture **must** happen at failure time. The final working tree cannot reconstruct intermediate failed states (the agent may have edited past them). Approach A / mid-RUNNING engine fiction remains rejected (#1643 / #2037).

## Constraints (verified)

| Fact | Implication |
|---|---|
| Claude Code: `PostToolUse` = success only; `PostToolUseFailure` fires for Bash non-zero exit | Failure-boundary hook is the correct Claude seam |
| Failure stdin includes `tool_name`, `tool_input.command`, `error` (e.g. `"Command exited with non-zero status code N"`) | Enough to mirror `test_run_from_tool_call` without inventing exit codes when absent |
| Learner plugin today: SessionStart only (`client/plugins/learner/hooks/`) | Add a failure hook; do not invent a second plugin |
| Repo path: `$WORKING_DIR/repo`; harvest already diffs that checkout for swe-rebench / jinn-repo | Diff base = session-start `HEAD` of `$WORKING_DIR/repo` |
| `harvestOutput` builds `Solution` and does not set `intermediateFailureDiffs` today | Harvest is the attach point for both LearnerHarness and HermesHarness (Hermes reuses harvest) |
| Hermes does **not** load the learner plugin | Hermes cannot see Claude/Codex plugin hooks; do not pretend |
| Codex adapter runs SessionStart manually; no PostToolUseFailure surface today | Codex is soft (“ideally”); ship Claude first, leave Codex honest `[]` unless a cheap notify/hook appears during implement |
| Engine already dedupes + drops empties on persist | Harness may also dedupe at append time; engine remains the last filter |

## Approaches compared

### 1 — Learner-plugin `PostToolUseFailure` hook + harvest attach (chosen)

At SessionStart (extend existing hook or a tiny sibling), if `$WORKING_DIR/repo/.git` exists, record `git -C repo rev-parse HEAD` to a durable file under workingDir (e.g. `.jinn/session-repo-base-head`). On each Claude `PostToolUseFailure` for Bash:

1. Parse stdin JSON; require `tool_name === "Bash"` (matcher can also gate).
2. Extract `tool_input.command`; gate with a TypeScript-ported `_is_test_command` (same executables / `yarn|npm|pnpm|bun|cargo|go|make test` / `run_tests.sh` rules as `session_bridge._is_test_command`). Non-test failures are ignored.
3. Compute working-tree diff vs the recorded base HEAD (tracked `git diff <base>` + untracked via `--no-index`, matching `accepted_diff` semantics; never mutate the index).
4. If non-empty and not already present, append the diff string to a JSON array file under workingDir (e.g. `.jinn/intermediate-failure-diffs.json`).

`harvestOutput` reads that file (missing → treat as none), attaches `intermediateFailureDiffs` on the returned `Solution` when non-empty after the same non-empty/dedupe rules. Engine POST_SNAPSHOT path unchanged.

**Pros:** Matches jinn-agent semantics; capture at failure time; unit-testable helpers without live Claude; surgical (plugin hook + harvest + helpers); no engine fiction.  
**Cons:** Claude-only for v0; Codex/Hermes stay empty until follow-ups.

### 2 — Parse harness stdout/transcript after `run()` ends

Scan `.claude-code` / `.codex-code` logs for failed Bash events and then `git diff`.

**Reject:** Final tree is not the intermediate tree. Logs do not store the working tree at failure. Violates “capture MUST happen at failure time.”

### 3 — Mid-RUNNING engine writes / #1643 Approach A resurrection

Have the engine accept partial Solutions during `run()` so overwrite archaeology fires.

**Reject:** Explicit AC6 (“No Approach A”); production-unreachable / wrong feedstock (#1643). Naming note: “Approach A” in AC6 means the dead overwrite-archaeology seam, **not** option 1 above.

### 4 — Hermes `post_tool_call` plugin mirroring jinn-agent

Ship a Hermes-side plugin that appends failed diffs the same way jinn-agent does.

**Defer:** Hermes does not load the learner plugin today; wiring a Hermes plugin + config is a separate, non-cheap surface. AC5 allows honest `[]` + concrete follow-up. Prefer that over expanding Hermes plugin surface in this issue.

## Chosen design

**Option 1** for Claude-code restoration via the learner plugin. Codex and Hermes remain honest omit/`[]` in this issue, with named follow-ups.

### Capture contract (mirror jinn-agent)

| Gate | Rule |
|---|---|
| Tool | Bash / shell equivalent only (Claude: `Bash`) |
| Command | `_is_test_command(command)` true — port of `session_bridge._is_test_command` |
| Failure | `PostToolUseFailure` fired (non-zero Bash). Do not require a parsed exit integer if the event itself is the failure signal; optionally parse `N` from `error` when present for telemetry only |
| Diff | Non-empty working-tree patch vs session-start repo HEAD |
| Store | Append-only list; skip empty; skip exact-string duplicates |
| Harvest | Read list → set `Solution.intermediateFailureDiffs` only when length > 0 after dedupe (or always set `[]` — engine treats both as null column; prefer omit-or-empty consistently with existing optional field docs) |

### Session base HEAD

- **Where:** `$WORKING_DIR/.jinn/session-repo-base-head` (single-line SHA) written during SessionStart when `repo/.git` exists.
- **If repo missing / not a git checkout:** skip write; failure hook no-ops (no false diffs). Coding restoration tasks that matter for §10 (swe-rebench-v2 / jinn-repo) always have `repo/`.
- **Base is fixed for the session** — same as jinn-agent `RepositorySnapshot.base_head`. Do not re-read HEAD on each failure.

### Diff shape

Port `accepted_diff` behavior into a small Node helper used by the hook script (hook invokes `node` on a compiled/dist helper, or a self-contained bash+git script that matches the semantics). Preference: **shared TS module** under `client/src/harnesses/impls/learner/` that:

- exports `isTestCommand(command: string): boolean`
- exports `workingTreeDiff(repoDir: string, baseHead: string): Promise<string>` (or sync via `execFileSync` for hook latency)
- exports `appendIntermediateFailureDiff(storePath: string, diff: string): void` (read JSON array, dedupe, write)
- exports `readIntermediateFailureDiffs(workingDir: string): string[]`

The plugin hook is a thin command: parse stdin → call helper → exit 0 always (PostToolUseFailure exit codes are non-blocking for the tool; hook errors must not disrupt the agent — swallow I/O errors, log to stderr).

### Harvest wiring

In `harvestOutput`, after building the Solution object on every return path that can carry restoration evidence (typed payload, swe-rebench/jinn-repo materialize, gating-only):

```ts
const intermediateFailureDiffs = readIntermediateFailureDiffs(workingDir);
if (intermediateFailureDiffs.length > 0) {
  solution.intermediateFailureDiffs = intermediateFailureDiffs;
}
```

Do not invent diffs when the store is absent. First-success / no failed test boundary → store empty or absent → field omitted → engine column null. Matches AC2.

HermesHarness calls the same `harvestOutput`; without the learner plugin hooks it will never populate the store → honest `[]`/omit (AC5 satisfied without special-casing Hermes).

### Codex (soft)

Codex does not run Claude plugin `PostToolUseFailure` hooks. Options deferred:

1. **Follow-up:** if Codex gains a failure notify/hook, project the same helper from the adapter (mirroring how SessionStart is already invoked manually).
2. **Not in scope:** parsing `.codex-code/stdout.jsonl` after the fact (Approach B).

Until then Codex restoration runs leave empty field 4. Document in PR / follow-up Issue title: `feat: emit intermediateFailureDiffs from Codex coding harness`.

### Hermes (AC5)

Honest omit/`[]` this issue. Concrete follow-up: Hermes `post_tool_call` plugin (or reuse jinn-agent session_bridge from a thin TypeScript bridge) that writes the same `.jinn/intermediate-failure-diffs.json` contract so harvest lights up without LearnerHarness. File as a child/follow-up Issue when implementing; do not stub fake diffs.

## Acceptance criteria mapping

| AC | How this design satisfies it |
|---|---|
| 1. Claude-code run with ≥1 in-session test Bash failure + non-empty tree → non-empty field after harvest → POST_SNAPSHOT | PostToolUseFailure hook writes store; harvest attaches; existing engine write |
| 2. First-success / no failed test boundary → []/null | No failure events → empty/absent store → omit/empty → engine null |
| 3. Dedupe + non-empty only | Append helper + existing `normalizeIntermediateFailureDiffs` |
| 4. Only test-like commands | `isTestCommand` mirror of `_is_test_command` |
| 5. Hermes: emit if cheap, else honest [] + follow-up | Honest [] + named follow-up (not cheap: no learner plugin) |
| 6. No Approach A / no mid-RUNNING fiction | Unchanged; no engine state-machine edits |
| 7. Unit-testable helpers + hook/harvester without live Claude | Fixture git repos + stdin JSON fixtures for the hook; harvest unit test with pre-seeded store file |

## Files to touch (implementation preview)

| Path | Change |
|---|---|
| `client/src/harnesses/impls/learner/intermediate-failure-diffs.ts` | **New** — `isTestCommand`, `workingTreeDiff`, append/read store helpers |
| `client/plugins/learner/hooks/hooks.json` | Register `PostToolUseFailure` matcher `Bash` → new hook command; keep SessionStart |
| `client/plugins/learner/hooks/session-start` | Also write `.jinn/session-repo-base-head` when `repo/.git` exists (cwd = workingDir; env already has `WORKING_DIR` / `JINN_WORKING_DIR`) |
| `client/plugins/learner/hooks/post-tool-use-failure` | **New** — bash/node thin wrapper: stdin → helpers → append |
| `client/src/harnesses/impls/learner/plugin-path.ts` | `requireAsset` for the new hook script |
| `client/src/harnesses/impls/learner/harvest.ts` | Attach `intermediateFailureDiffs` from store on Solution returns |
| `client/src/harnesses/impls/learner/index.ts` | Re-export helpers if tests need them |
| `client/test/harnesses/impls/learner/intermediate-failure-diffs.test.ts` | **New** — command gate, diff fixture, dedupe, harvest attach |
| `client/test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts` | **New** — drive hook with fixture stdin + temp repo (no live Claude) |
| `docs/superpowers/plans/2026-07-27-intermediate-failure-diffs-production-harnesses.md` | Stage 2 plan (not this Stage 1 deliverable) |

**Out of scope / do not touch:** `client/src/harnesses/engine/{engine,persistence}.ts` (already correct); Approach A helpers (already removed); Hermes adapter/plugin surface (follow-up); Codex failure hooks (follow-up).

## Testing plan (Stage 3 preview)

1. **Unit — `isTestCommand`:** table matching Python `_is_test_command` (pytest / `yarn test` / `npm test` / `run_tests.sh` / non-tests like `ls`).
2. **Unit — `workingTreeDiff`:** temp git repo; edit tracked + untracked; assert non-empty; clean tree → empty.
3. **Unit — append/dedupe:** append twice identical → length 1; empty string ignored.
4. **Hook integration (no Claude):** write base HEAD file; pipe PostToolUseFailure JSON with test command; assert store grows; non-test command → store unchanged.
5. **Harvest:** seed store + minimal typed payload / phase artifacts; `harvestOutput` returns `intermediateFailureDiffs` equal to store; absent store → field omitted.
6. **Engine regression (existing):** `client/test/harnesses/engine/intermediate-failure-diffs.test.ts` remains green — proves POST_SNAPSHOT still consumes harness-emitted lists (stub harness). Optional thin test: LearnerHarness with noop adapter + seeded store file through `run()` if cheap.

No live Claude/Codex/Hermes required for the mandatory suite.

## Risks and non-goals

- **Hook reliability / Claude quirks:** PostToolUseFailure has had TUI “hook error” noise even on exit 0 in some Claude versions. Mitigate: exit 0, empty stdout, stderr-only diagnostics; never block the agent.
- **Large diffs:** Same as jinn-agent — full tree patch at each failed test boundary. No truncation in v0 (distillation wants the exemplar). If size becomes a problem, follow-up cap with explicit logging.
- **Subagent Bash failures:** Claude may fire hooks for subagent tool uses depending on version. Accept captures from any Bash failure in the session that passes the test-command gate (still honest attempt boundaries). Do not invent agent-id filtering unless noise appears.
- **Non-goal:** Reconstructing intermediates after the fact; feeding Episode `pack()` from requestId (C7); Hermes/Codex emitters in this Issue.

## Decision log (headless Stage 1)

- Chose option 1 (Claude PostToolUseFailure + harvest) over 2/3/4 — only option 1 meets failure-time capture without mid-RUNNING fiction and without expanding Hermes.
- Codex deferred (soft AC) — no failure-hook surface today; Approach B rejected.
- Hermes deferred with concrete follow-up — not cheap; AC5 allows honest [].
- Store path `.jinn/intermediate-failure-diffs.json` + `.jinn/session-repo-base-head` — keep capture artifacts out of learner phase dirs and out of `repo/` so harvest’s git diff for the solution patch stays clean.
- No product commit in Stage 1 per attempt authority capsule.
