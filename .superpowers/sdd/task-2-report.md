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

## Review-fix addendum — 2026-07-20

### Findings addressed

- Orphan implementation claims now carry Project `Blocked on: Human`, Human
  status, retained issue labels, and a structured Human reason into projection
  planning. A held orphan is projected to `Human` only; recovery does not
  project `In Progress` or create/reuse a draft PR.
- No-PR issue status preserves `eligible`, a structured eligibility reason,
  and source-derived detail. Explanations distinguish ordinary eligibility,
  unresolved dependencies, author disallowance, and other Project/taxonomy
  admission failures.
- Issue↔PR resolution now fails closed. Multiple PRs for one issue, one PR for
  multiple issues, stable-branch contradictions, and PRs with no resolvable
  issue become connected Human diagnostics. Affected normal lifecycle items
  are suppressed; every resolvable issue and PR receives an idempotent Human
  projection.
- Production reads now paginate only open `engine:review` PRs. Merged outcomes
  are fetched with lean aliased `closedByPullRequestsReferences` batches for
  non-Done Project issues, unioned, and deduplicated. Review refs and structured
  Human comments are read only for the open Autopilot PR set; merged outcome
  reads do not fetch reviews, comments, refs, or checks.
- Structured v2 Human comment markers and reasons are strictly parsed and
  combined with Project and label evidence. Reconciliation events continue to
  exclude comment bodies and credentials.
- Progress age now uses the later matching exact-head terminal-verdict time
  when valid; otherwise it uses GitHub's branch-head commit time.
- `status`, `sessions`, and `explain` reject trailing positional arguments.
- Observe remains zero-write, recover remains projection/recovery-only, and
  active still rejects before snapshot or writer access.

### Review-fix RED / GREEN evidence

Initial focused RED:

```text
yarn vitest run test/lifecycle/projection.test.ts \
  test/lifecycle/snapshot.test.ts \
  test/lifecycle/controller.test.ts \
  test/lifecycle/github-reader.test.ts
```

Result: 4 files failed with 8 expected behavioral failures:

- held orphan repair created a draft PR instead of retaining Human;
- ambiguous mappings emitted ordinary PR items and no diagnostics;
- eligibility metadata/explanations were absent;
- the reader returned no batched merged outcome and no structured Human
  evidence;
- progress age ignored a later matching terminal verdict;
- trailing status arguments were accepted.

The reader-scope refinement also had its own focused RED:

```text
yarn vitest run test/lifecycle/github-reader.test.ts
```

Result: 1 expected failure because the merged-outcome batch still overfetched
reviews, comments, and status checks.

Focused GREEN:

```text
yarn vitest run test/lifecycle/projection.test.ts \
  test/lifecycle/snapshot.test.ts \
  test/lifecycle/controller.test.ts \
  test/lifecycle/github-reader.test.ts
```

Result: 4 files passed, 24 tests passed. A later controller integration
regression increased the lifecycle total by one test.

### Review-fix files

Production:

- `packages/autopilot/src/dispatcher/issue-source.ts`
- `packages/autopilot/src/dispatcher/types.ts`
- `packages/autopilot/src/lifecycle/codecs.ts`
- `packages/autopilot/src/lifecycle/controller.ts`
- `packages/autopilot/src/lifecycle/github-reader.ts`
- `packages/autopilot/src/lifecycle/projection.ts`
- `packages/autopilot/src/lifecycle/snapshot.ts`
- `packages/autopilot/src/lifecycle/types.ts`

Tests:

- `packages/autopilot/test/lifecycle/controller.test.ts`
- `packages/autopilot/test/lifecycle/github-reader.test.ts`
- `packages/autopilot/test/lifecycle/projection.test.ts`
- `packages/autopilot/test/lifecycle/snapshot.test.ts`

Evidence:

- `.superpowers/sdd/task-2-report.md`

### Fresh required verification

Exact final command:

```text
yarn vitest run test/lifecycle && yarn typecheck && yarn test
```

Result:

- Lifecycle: 9 files passed, 85 tests passed.
- Typecheck: exit 0, no diagnostics.
- Full Autopilot suite: 80 files passed, 789 tests passed.
- Expected resilience-test stderr was present; zero tests failed.

Additional live read-only schema proof:

```text
gh api graphql <Repository/Issue field introspection>
```

Confirmed that `Repository.pullRequests` supports the `labels` argument and
`Issue.closedByPullRequestsReferences` supports batched connection reads. No
all-history fallback was added.

### Review-fix self-review

- Confirmed ambiguous mapping diagnostics remain visible and preserve the
  existing `engine:review` label while the PR is drafted and Human-held.
- Confirmed merged outcome reads use terminal-only fields and never request
  review refs.
- Confirmed Project snapshots are still read once per cycle and their existing
  rate-limit guard remains authoritative.
- Confirmed diagnostic projections are idempotent and do not create authority.
- Confirmed no claim, child process, worktree, review submission, merge-prep,
  merge, or cleanup code was added.
- Confirmed `git diff --check` is clean.

### Review-fix concerns

- The new scoped GraphQL query shapes were validated by unit tests and
  read-only live schema introspection, but not against a disposable repository
  populated with every ambiguity and Human-comment case. That remains part of
  the approved live-shadow/canary gate; active mode is still rejected.

## Second-review fix addendum — 2026-07-20

### Findings addressed

- `engine:review` is now a permanent v2 management/query-scope projection.
  Draft implementation, Human, review, merge-prep, and merged phases never
  remove it.
- Stable and adopted branch ancestry is searched through bounded 100-commit
  REST pages when the GraphQL tail is incomplete. Search selects the latest
  strictly decoded claim/completion marker matching the candidate issue/PR,
  ignores foreign merge-ancestry markers, fails closed at the safety limit,
  caches only retryable/successful results, and retries transient failures on
  later cycles.
- Issue-scoped closing-PR reads provide a bounded label-independent recovery
  path for an adopted v2 PR whose management-label projection is already
  missing. Full lifecycle fields are fetched only for the discovered open
  candidate; merged outcome rows remain terminal-only.
- Orphan recovery that finds a concurrently created PR now repairs its draft
  and `engine:review` projections instead of treating existence as completion.
  The separately planned Project projection remains idempotent and converges
  after partial failures.
- Merged rows carry bounded v2 evidence from the management label, exact
  stable branch identity, or a protocol body marker, allowing genuine v2
  merge-before-`Done` recovery without reinterpreting unrelated legacy rows.
- A stable `autopilot/<issue>` implementation claim and a different adopted
  PR are now one connected ambiguity component. Normal recovery and orphan
  repair are suppressed; all connected issues/PRs receive Human diagnostics
  and projections.
- Snapshot construction applies the existing rate floor immediately after the
  single lean Project read. Low budget stops issue, PR, ref, and ancestry reads;
  the v2 controller renders the typed result as `rate-limited`.
- Ambiguity reconciliation events report phase `human`.
- Structured Human comment evidence retains its optional issue number.
  A mismatch against the resolved mapping expands the connected ambiguity and
  parks every affected issue/PR in Human.
- Observe remains zero-write, recover remains projection/recovery-only, and
  active still rejects before any read or writer access. The existing
  production `yarn autopilot` entrypoint is unchanged.

### Second-review RED / GREEN evidence

Initial focused RED:

```text
yarn vitest run test/lifecycle/projection.test.ts \
  test/lifecycle/reconciler.test.ts \
  test/lifecycle/github-reader.test.ts \
  test/lifecycle/snapshot.test.ts \
  test/lifecycle/controller.test.ts
```

Result: 5 files failed with 9 expected behavioral failures:

- draft implementation attempted to remove `engine:review`;
- a discovered orphan PR stopped at `already-applied`;
- stable and adopted ancestry did not paginate to page two;
- low Project budget still performed all lifecycle reads;
- merged management evidence did not mark a row as v2;
- stable/adopted contradictions remained normal lifecycle items;
- Human marker issue mismatches remained normal lifecycle items;
- ambiguity reconciliation events used `eligible`.

Additional review-driven RED:

```text
yarn vitest run test/lifecycle/github-reader.test.ts \
  -t 'transient ancestry|rediscovers|foreign protocol'
```

Result: the transient failure remained cached, an unlabeled adopted v2 PR was
invisible, and a foreign merge-ancestry protocol marker was selected before
the candidate branch claim.

Focused GREEN:

```text
yarn vitest run test/lifecycle/projection.test.ts \
  test/lifecycle/reconciler.test.ts \
  test/lifecycle/github-reader.test.ts \
  test/lifecycle/snapshot.test.ts \
  test/lifecycle/controller.test.ts
```

Result: 5 files passed, 45 tests passed.

### Second-review files

Production:

- `packages/autopilot/scripts/run-autopilot-v2.ts`
- `packages/autopilot/src/lifecycle/controller.ts`
- `packages/autopilot/src/lifecycle/github-reader.ts`
- `packages/autopilot/src/lifecycle/projection.ts`
- `packages/autopilot/src/lifecycle/reconciler.ts`
- `packages/autopilot/src/lifecycle/snapshot.ts`

Tests:

- `packages/autopilot/test/lifecycle/controller.test.ts`
- `packages/autopilot/test/lifecycle/github-reader.test.ts`
- `packages/autopilot/test/lifecycle/projection.test.ts`
- `packages/autopilot/test/lifecycle/reconciler.test.ts`
- `packages/autopilot/test/lifecycle/snapshot.test.ts`

Evidence:

- `.superpowers/sdd/task-2-report.md`

### Second-review commit lineage

- Design/spec baseline: `91ec7468b`
- Task 2 implementation: `3471725db`
- First-review Task 2 fix: `504dbeb0b`
- Second-review fix base: `504dbeb0b6a67c22361bac3c4f30d5c12e46a44a`
- Final second-review fix SHA: recorded in the task handoff because a commit
  cannot contain its own SHA.

### Second-review verification

Exact final command:

```text
yarn vitest run test/lifecycle && yarn typecheck && yarn test
```

Result:

- Lifecycle: 9 files passed, 97 tests passed.
- Typecheck: exit 0, no diagnostics.
- Full Autopilot suite: 80 files passed, 801 tests passed.
- Expected resilience-test stderr was present; zero tests failed.

### Second-review self-review

- Confirmed the existing production `autopilot` package script and
  `scripts/run-autopilot.ts` were not changed.
- Confirmed the Project snapshot is fetched once and the rate floor is applied
  before issue polling, open/merged PR reads, review refs, stable refs, or
  ancestry.
- Confirmed ordinary open PR discovery remains `engine:review` scoped.
  Missing-label adopted recovery uses only the already-bounded non-Done
  issue-to-closing-PR batches and performs a full PR-by-number read only for an
  open unlabeled candidate; there is no all-open-PR fallback.
- Confirmed merged issue batches still omit reviews, comments, checks, and
  review refs.
- Confirmed ancestry pagination selects a matching issue/PR marker, retries a
  transient failure, and never silently truncates after the safety cap.
- Confirmed stable/adopted and Human-marker contradictions suppress normal
  lifecycle and orphan recovery for the full connected component.
- Confirmed a discovered orphan PR rechecks the exact head before repairing
  draft and management-label projections.
- Confirmed observe has zero writer calls, recover has no claim/child/merge
  authority, and active rejects before any read.
- Confirmed `git diff --check` is clean.

### Second-review concerns

- The bounded issue-linked missing-label recovery and paginated REST ancestry
  shapes are covered by injected-reader unit tests but have not been exercised
  against a disposable live repository containing a long adopted branch with
  merge ancestry. The approved live-shadow/canary gate remains required;
  active mode is deliberately unwired.
