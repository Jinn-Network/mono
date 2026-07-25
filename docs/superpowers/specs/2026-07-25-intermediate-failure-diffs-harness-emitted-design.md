# Intermediate failure diffs via harness-emitted evidence (#1643 redesign)

- **Version:** 0.1
- **Date:** 2026-07-25
- **Status:** design draft (Stage 1) — replaces Approach A on `autopilot/1643`
- **Issue:** [#1643](https://github.com/Jinn-Network/mono/issues/1643)
- **Parent contract:** [`spec/2026-07-08-task-creator-v0.md`](../../../spec/2026-07-08-task-creator-v0.md) §10 field 4 (intermediate failure states / negative exemplars)
- **Supersedes:** PR [#1951](https://github.com/Jinn-Network/mono/pull/1951) Approach A (`recordPriorPatchOnOverwrite` on `solution_outputs_json`), closed without merge; review finding [#2037](https://github.com/Jinn-Network/mono/issues/2037)

## Context (why Approach A is dead)

`MineableTraceRecord.intermediateFailureDiffs` / `ContributionCandidateV1.intermediateFailureDiffs` are typed for §10 field 4 but stay `[]` on the engine path. Approach A archived a prior `solutionPayload.patch` when `runImpl` overwrote `solution_outputs_json`. That seam is **production-unreachable**: the column is written only on `RUNNING → POST_SNAPSHOT`, there is no return to `RUNNING`, and real RUNNING re-drives happen only when the prior attempt died *before* that write — so `prior` is always null and the archive no-ops. Green tests seeded `solution_outputs_json` onto RUNNING rows via raw SQL; that state never occurs in production. Engine-level “retry overwrite” is the wrong feedstock for negative exemplars anyway: the interesting failures are **in-session attempt boundaries** (edit → test fail → edit), not crash recovery of a finished Solution.

## Chosen approach — harness-emitted failed-diff evidence

**Retention seam:** the harness (or harness-adjacent session bridge) emits failed working-tree diffs at verifier/test-failure attempt boundaries during a single `run()`, then the engine persists that list once at the existing `RUNNING → POST_SNAPSHOT` write. Semantics match the already-shipping jinn-agent plugin path: on a terminal/test tool call with `exitCode != 0`, if a non-empty repo diff vs the session base exists, append it to `intermediateFailureDiffs` (dedupe); at session end that list feeds `build_contribution_candidate` / the Episode contribution candidate (`apps/jinn-agent/plugins/jinn/__init__.py` `_on_post_tool_call` + `session_bridge.build_contribution_candidate`). For engine restoration harnesses (learner / coding adapters), expose the same evidence on `Solution` as optional `intermediateFailureDiffs: string[]` (default `[]` when the harness cannot observe attempt boundaries). `runImpl` copies that array into `task_runs.intermediate_failure_diffs_json` in the same POST_SNAPSHOT transition that writes `solution_outputs_json` — one production-reachable write, no mid-RUNNING Solution fiction. Assemblers keep using `intermediateFailureDiffsFromTaskRun`; C7 stays closed (`pack()` still does not invent contribution refs).

**Trade-offs vs alternatives.** Mid-RUNNING engine writes of a partial Solution would only make Approach A’s overwrite helper fire; they invent a durable “solution” mid-attempt, complicate crash recovery, and still miss in-session retries inside one `run()`. Post-attempt aggregation across engine re-drives fails for the same state-machine reason unless mid-RUNNING writes exist — abandon it. Harness-internal capture is smaller, matches the plugin reference, and sees the distillation feedstock §10 actually wants. Cost: each coding harness must opt in when it can see test failures; harnesses without that visibility honestly emit `[]` rather than fabricating negatives from crash recovery.

## Acceptance criteria (redesign)

1. **Production path without SQL seeding.** A harness that fails at least one in-session verifier/test with a non-empty working-tree diff, then succeeds (or finishes), leaves a non-empty `intermediate_failure_diffs_json` after a normal `RUNNING → POST_SNAPSHOT` transition. Tests drive a real harness stub/adapter that emits failed diffs — no hand-seeded prior `solution_outputs_json` on a RUNNING row.
2. **First-success / no-boundary stays empty.** A run with no failed attempt-boundary evidence leaves the column null/`[]`; `intermediateFailureDiffsFromTaskRun` still returns `[]` for null/malformed JSON.
3. **Dedupe + non-empty only.** Empty strings are never retained; identical diffs are not duplicated.
4. **Assembler feed unchanged.** `intermediateFailureDiffsFromTaskRun` remains the safe reader for `buildMineableRecord` / Episode assemblers; field 4 is fed from harness evidence, not from overwrite archaeology.
5. **C7 unchanged.** `pack()` does not append mineable/contribution refs from requestId alone.
6. **Approach A removed.** See delete list below — redesign replaces it on this branch, does not extend it.

## Delete / replace from Approach A (this branch)

| Remove | Keep / rewire |
|---|---|
| `TaskRunPersistence.recordPriorPatchOnOverwrite` and `extractSolutionPatch` if only used by it | Additive column `intermediate_failure_diffs_json` + `PersistedTaskRun.intermediateFailureDiffsJson` |
| `engine.ts` call sites before both POST_SNAPSHOT writes that invoke the overwrite helper | New write: persist `Solution.intermediateFailureDiffs` (or equivalent) into the column in the same POST_SNAPSHOT transition |
| Tests that prove retention only by raw-SQL seeding `solution_outputs_json` while still RUNNING | Tests that drive harness-emitted failed diffs through a real `runImpl` → POST_SNAPSHOT path |
| Comments/docs framing “archive prior patch on solution overwrite” as the §10 seam | Comments pointing at harness attempt-boundary emission (jinn-agent as reference) |
| Product commits’ Approach A framing in PR summary | `intermediateFailureDiffsFromTaskRun` + `buildMineableRecord` wiring (already correct readers) |

Commits still on branch that encode Approach A and must be superseded by this redesign’s implementation (not amended in design-only Stage 1): `fd77c912`, `5479e3e8`, `acac73c4`, `030b52d2`, `f73af50d`.
