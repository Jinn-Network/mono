# Task 2 report — unified GitHub snapshot, projection, recovery, and observe controller

## Status

DONE

Commit:

`HEAD` — this report is included in the implementation commit; the exact SHA
is recorded in the task handoff because a commit cannot contain its own final
SHA.

## Scope delivered

- Added an immutable, paginated GitHub lifecycle snapshot that reuses the
  existing lean Project snapshot, issue source, board adapter, author
  allowlist readiness, dependency stacking, Project taxonomy, rate-limit
  budget, and existing review-label constants.
- Added an injected `GhLifecycleReader` for Project, issue, PR, head-commit,
  check, native review, branch-claim, review-ref, Human overlay, and merge
  outcome evidence.
- Preserved exact GitHub review `commit_id`, head OID, GitHub commit time,
  review-ref OID, strict Task 1 branch/review codecs, check summaries,
  mergeability, labels, closing issues, and merged result.
- Added fail-closed pagination and truncation handling:
  - Project pagination remains owned by `fetchProjectSnapshot`;
  - PR pages advance an exact cursor with a safety cap;
  - nested labels, reviews, closing issues, and checks reject truncation;
  - a 200-item issue-source result rejects as possibly truncated;
  - long stable-branch histories reject if the v2 claim ancestor is outside
    the fetched history.
- Added a pure projection planner for `Todo`, `In Progress`, `Human`,
  `In Review`, and `Done`, draft/ready state, existing review/Human labels,
  structured Human comment markers, and partial v2 transition repair.
- Added an idempotent recovery executor with injected writer ports. Every
  head/ref-sensitive mutation re-reads authoritative state, ambiguous writes
  use exact readback, per-item failures are isolated, and later cycles
  converge.
- Added stale-v2 recovery:
  - implementation requeues to `Todo` without branch/PR deletion;
  - review advances through an exact-ref `markReviewStale` port;
  - merge-prep is exposed as eligible without a synthetic progress write.
- Added recoverable verdict-intent completion. Ready/redraft mutations carry
  an explicit review-ref-state prerequisite, so approval intent cannot make a
  PR ready before the terminal review-ref transition.
- Added a thin v2 controller:
  - `observe` derives and reports with zero writer calls;
  - `recover` invokes only projection/recovery ports;
  - `active` rejects before any read with `active writer not wired yet`;
  - default mode is `observe`;
  - `--dry-run` becomes one observe cycle;
  - `--once` preserves the selected mode.
- Added structured JSON/human status, `status`/`sessions`, `explain issue`,
  `explain pr`, runner-independent phase/head/generation/progress/Human/action
  data, and token-free structured reconciliation events.
- Added `yarn autopilot:v2` as an additive observation entrypoint. The
  existing production `yarn autopilot` script and dispatcher are unchanged.
- Added no claim writer, branch publisher, worktree creator, session spawn,
  review submitter, merge-prep runner, or merge operation.

## RED / GREEN evidence

All commands ran from `packages/autopilot`.

### Unified snapshot

RED:

```text
yarn vitest run test/lifecycle/snapshot.test.ts
```

Result: suite failed to load because `src/lifecycle/snapshot.ts` did not exist.

GREEN:

```text
yarn vitest run test/lifecycle/snapshot.test.ts
```

Result: 1 file passed, 3 tests passed. The tests cover PR pagination, exact
native review commit IDs, immutable output, strict review-claim decoding, and
non-advancing pagination failure.

### Projection planner

RED:

```text
yarn vitest run test/lifecycle/projection.test.ts
```

Result: suite failed to load because `src/lifecycle/projection.ts` did not
exist.

GREEN:

```text
yarn vitest run test/lifecycle/projection.test.ts
```

Result: 1 file passed, 6 tests passed. The tests cover implementation
projection, ready-last completion, Human hold projection/comment markers,
stale implementation/review/merge-prep behavior, verdict-intent recovery,
claim-without-PR, and merge-before-Done.

### Recovery executor

RED:

```text
yarn vitest run test/lifecycle/reconciler.test.ts
```

Result: suite failed to load because `src/lifecycle/reconciler.ts` did not
exist.

GREEN:

```text
yarn vitest run test/lifecycle/reconciler.test.ts
```

Final result: 1 file passed, 8 tests passed. The tests cover fresh head/ref
fencing, changed-head rejection, per-item failure isolation, ambiguous
readback, two-reconciler convergence, PR/ref repair, retry convergence for
Project/draft/label/comment failures, no synthetic merge-prep progress, and
terminal-ref-before-ready ordering.

### Controller and operator output

RED:

```text
yarn vitest run test/lifecycle/controller.test.ts
```

Result: suite failed to load because `src/lifecycle/controller.ts` did not
exist.

GREEN:

```text
yarn vitest run test/lifecycle/controller.test.ts
```

Final result: 1 file passed, 7 tests passed. The tests cover CLI defaults,
dry-run/once semantics, observe's zero-writer boundary, recover-only writes,
two recover-controller convergence, structured safe events, active rejection,
legacy reporting without reap, JSON output, and issue/PR explanation.

## Files changed

Production:

- `packages/autopilot/src/lifecycle/snapshot.ts`
- `packages/autopilot/src/lifecycle/github-reader.ts`
- `packages/autopilot/src/lifecycle/projection.ts`
- `packages/autopilot/src/lifecycle/reconciler.ts`
- `packages/autopilot/src/lifecycle/controller.ts`
- `packages/autopilot/src/lifecycle/types.ts`
- `packages/autopilot/src/lifecycle/lifecycle.ts`
- `packages/autopilot/src/lifecycle/index.ts`
- `packages/autopilot/scripts/run-autopilot-v2.ts`
- `packages/autopilot/package.json`

Tests:

- `packages/autopilot/test/lifecycle/snapshot.test.ts`
- `packages/autopilot/test/lifecycle/projection.test.ts`
- `packages/autopilot/test/lifecycle/reconciler.test.ts`
- `packages/autopilot/test/lifecycle/controller.test.ts`

Evidence:

- `.superpowers/sdd/task-2-report.md`

## Required final verification

Fresh combined run after the final code changes:

```text
yarn vitest run test/lifecycle && yarn typecheck && yarn test
```

Result:

- Lifecycle suite: 8 files passed, 76 tests passed.
- Typecheck: exit 0, no diagnostics.
- Full Autopilot suite: 79 files passed, 780 tests passed.
- Existing stderr lines are expected assertions from resilience tests; there
  were zero failed tests.

## Self-review

- Confirmed the legacy `autopilot` package script still points to
  `scripts/run-autopilot.ts`; v2 is additive as `autopilot:v2`.
- Confirmed the new v2 script supplies no writer, so its default observation
  path cannot mutate GitHub.
- Confirmed `active` rejects before snapshot reads or writer calls.
- Confirmed no new code calls claim, spawn, worktree, review submission,
  merge-prep execution, or merge APIs.
- Confirmed the snapshot reads the Project exactly once per cycle and threads
  it through the existing issue/board seams.
- Confirmed exact review `commit_id`, current head OID, review-ref OID, and
  GitHub commit time survive parsing.
- Confirmed malformed v2 claim metadata and incomplete pagination fail closed.
- Confirmed Task 1 remains the source of lifecycle derivation, claim codecs,
  staleness, and Human dominance; Project, draft, labels, and comments remain
  projections only.
- Confirmed legacy work never receives autonomous recovery or ordinary
  projection reinterpretation; explicit Human projection may still retain a
  hold.
- Confirmed stale recovery preserves branches and PRs and that merge-prep
  exposure performs no write.
- Confirmed every writer action either re-reads its authoritative head/ref
  immediately before mutation or is an unpinned issue-only projection.
- Confirmed verdict completion precedes ready/redraft and the dependent draft
  transition rechecks the required review-ref state.
- Confirmed ambiguity is resolved through exact target readback and one
  failed item cannot stop later items.
- Confirmed structured events contain identifiers, phases, actions, and
  outcomes only; no credentials or environment values are rendered.
- Confirmed `git diff --check` is clean.

## Concerns

- The real GitHub GraphQL/ref reader is unit-tested through its injected raw
  snapshot boundary and strict parsers, but it has not been exercised against
  a live canary repository in this task. That belongs to the design's later
  live-shadow/canary activation gate; active mode remains deliberately
  unwired until then.
