# Dispatcher author allowlist — design note

**Version:** v0.1
**Date:** 2026-05-23
**Authors:** Merge Plan Bot (Claude Sonnet 4.6)
**Status:** draft
**Issue:** #497

## Why

The `eng-orchestrator` dispatcher's `selectReady` filter currently has no awareness of who created an issue. Every issue-opener on the repo is therefore an implicit input to the autonomous `implement-issue` pipeline — an open trust boundary that enables prompt injection, resource abuse, and steering toward unintended work. This design closes that boundary by requiring issue authors to appear on a configurable allowlist before an issue can be dispatched.

## Approach

The allowlist check slots into the existing `selectReady` pipeline as a second-stage predicate, operating on a new `author` field carried by `PolledIssue`. The `GhIssueSource` acquires the field by adding `author` to the `--json` argument of its `gh issue list` call; `gh` returns `{ login: string, ... }` per item and we flatten to `author: string` (the login string) during mapping. `selectReady` receives the allowlist as a second parameter alongside `inFlight`, applies a case-insensitive match, and records non-allowlisted issues in a new `skippedForAuthor` array on `CycleReport`. The runner entrypoint (`run-eng-loop.ts`) reads the allowlist from an environment variable, wires it into `DispatcherConfig`, and passes it through to `selectReady`. No new abstraction layer is needed; the change is additive and the existing seam discipline is preserved throughout.

The fail-safe default is per-cycle filtering-to-empty rather than a startup fatal. This keeps `--dry-run` and the test harness functional without needing the env var in every environment, and it produces a visible log warning each cycle so operators know the dispatcher is effectively paused rather than discovering this at the end of a long run. The trade-off is that a misconfigured production deployment dispatches nothing silently across cycles rather than crashing immediately; the per-cycle warning in `printReport` is the mitigation.

## Decisions

- **Config carrier shape.** `authorAllowlist: string[]` stored in `DispatcherConfig`. Arrays are JSON-serializable and consistent with the existing config shape; the filter converts to `Set<string>` at call time for O(1) lookup — no reason to store a `Set` in the config type itself.

- **Allowlist source.** Environment variable `JINN_DISPATCHER_AUTHOR_ALLOWLIST`, comma-separated GitHub logins (e.g. `oaksprout,adrianobradley`). This matches the repo's established `JINN_*` env-var pattern and is easy to supply in CI secrets or operator shell config without touching config files. The runner reads it at startup and splits on commas, trimming whitespace.

- **Fail-safe default.** Empty allowlist means dispatch nothing (per-cycle drop with a `[eng:loop] WARNING: authorAllowlist is empty — no issues will be dispatched` log line), not a startup fatal. Rationale: a startup fatal would block `--dry-run` and every test environment that does not supply the env var; the per-cycle warning is visible and actionable without breaking the existing development flow.

- **Surfacing non-allowlisted skips.** Extend `CycleReport` with `skippedForAuthor: Array<{ number: number; author: string }>` and print it in `printReport`. A plain count would not tell the operator *which* authors are being blocked, making diagnosis harder. The richer array matches the precedent set by `paused: number[]` (issue-level detail) and is still cheap to log.

- **Case-sensitivity.** Lowercase both sides at filter time: `allowlistSet.has(issue.author.toLowerCase())` where `allowlistSet` is built from `authorAllowlist.map(s => s.toLowerCase())`. GitHub logins are case-insensitive at the API level but display-cased in `gh` output; lowercasing at the comparison boundary avoids surprising mismatches without requiring operators to match casing exactly in their env var.

- **Drift vs. dedicated counter.** Non-allowlisted issues go into `skippedForAuthor`, not `drift`. `drift` is reserved for state-sync discrepancies between the board and worktrees (e.g. an issue marked In Progress with no worktree); trust-boundary skips are a distinct operational signal and should not pollute that channel.

## Touched files

- `packages/eng-loop/src/dispatcher/types.ts` — add `author: string` to `PolledIssue`; add `authorAllowlist: string[]` to `DispatcherConfig` and `DEFAULT_CONFIG` (default `[]`).
- `packages/eng-loop/src/dispatcher/issue-source.ts` — add `author` to the `--json` flag in `gh issue list`; add `GhIssue.author: { login: string }` to the internal interface; flatten to `author: string` in the `PolledIssue` mapping at the bottom of `poll()`.
- `packages/eng-loop/src/dispatcher/ready-filter.ts` — `selectReady` gains a third parameter `authorAllowlist: ReadonlySet<string>` (pre-lowercased); the filter predicate adds the allowlist check; non-allowlisted issues are collected separately. Return shape changes to `{ ready: ReadyIssue[]; skippedForAuthor: Array<{ number: number; author: string }> }`.
- `packages/eng-loop/src/dispatcher/loop.ts` — `CycleReport` gains `skippedForAuthor`; `runCycle` builds the lowercased allowlist Set from `cfg.authorAllowlist`, calls `selectReady` with it, and threads `skippedForAuthor` into the report.
- `packages/eng-loop/scripts/run-eng-loop.ts` — read `JINN_DISPATCHER_AUTHOR_ALLOWLIST` from `process.env`, split/trim, merge into `cfg`; emit the empty-list warning; extend `printReport` to render `skippedForAuthor`.

## Tests to add

- `packages/eng-loop/test/dispatcher/ready-filter.test.ts` — new `describe('author allowlist')` block:
  - empty allowlist + one otherwise-ready issue → returns `ready: []`, `skippedForAuthor` contains the issue's number and author.
  - allowlist contains the issue's author (exact match) → issue appears in `ready`.
  - allowlist contains the author in different case → issue appears in `ready` (case-insensitive).
  - allowlist does not contain the issue's author → issue is in `skippedForAuthor`, not in `ready`.
  - multiple issues, mixed authors → only allowlisted authors' issues in `ready`; others in `skippedForAuthor`.
- `packages/eng-loop/test/dispatcher/issue-source.test.ts` — extend the existing fixture to include `author: { login: 'someuser' }` in the canned `gh issue list` JSON; assert that `polled[n].author === 'someuser'` for each mapped issue.
- `packages/eng-loop/test/dispatcher/loop.test.ts` — extend existing tests with empty `skippedForAuthor: []` where appropriate; add one new case: `runCycle` with an empty allowlist and one otherwise-ready issue → `dispatched` is empty, `skippedForAuthor` contains the issue.
