# Task 5 Report — Review, Fix, Re-review, and Verdict Recovery

## Status

DONE

Commit: recorded in the Task 5 handoff after commit creation.

## Delivered scope

- Added an injected review action executor and production Git/GitHub port:
  - exact PR/lifecycle mapping, head, branch, base, draft, Human, author,
    native-review, and review-ref reads before acquisition;
  - structured Human escalation for contradictory evidence;
  - exact reviewer selection with author inequality, single-credential support,
    and prior-reviewer-only stale draft recovery;
  - append-only review metadata commits and exact review-ref claim/readback;
  - winning-claim-only detached attempts, projection repair, runtime spawn, and
    child tracking;
  - review approval policy bound into the strict attempt manifest;
  - selected canonical HTTPS credentials for every production mutation.
- Added the complete review session protocol:
  - exact manifest/ref/generation/attempt/reviewer/head/PR authority checks;
  - marker-bearing verdict intent before native GitHub review;
  - explicit native `commit_id`, selected login, event, and marker readback;
  - accepted-response ambiguity recovery and duplicate retry idempotency;
  - request-changes → fixing → label repair → draft-before-edits;
  - approval → terminal tombstone → projection repair → ready-last;
  - late/external native requested-changes blocking and stale approval
    rejection;
  - CODEOWNER/human-surface enforcement as a session authority rule;
  - Human dominance immediately before inverse mutations and ready.
- Added review-owned fix publication and re-review:
  - exact fixing/draft/no-Human authority and clean rooted changed-tree checks;
  - one append-only active record for the new head;
  - atomic branch plus review-ref expected-state publication;
  - paired ambiguous readback acceptance only;
  - exact progressive manifest head/ref pair CAS;
  - crash recovery when the remote pair advanced before the local manifest;
  - unlimited same-session fix/re-review rounds with approval bound to the
    final head.
- Added production review session adapters for exact ref payload reads,
  selected identity and canonical remote validation, metadata commits, native
  reviews, labels, Project state, draft/ready, local fix inspection, atomic
  publication, Human comments, and exact mutation readback.
- Wired `review-verdict`, `review-fix-publish`, and review-phase `human` through
  the production session CLI.
- Preserved the boundary: canonical skills are unchanged; global `active`,
  merge-prep completion, and merge remain unwired; Hermes remains the
  process-wide runtime selected by the existing coordinator.

## RED/GREEN evidence

- Review executor RED: 8 of 9 tests failed against the inert implementation.
  GREEN: 9 of 9 after exact claim election, stale replacement, identity,
  Human, terminal, attempt, and spawn ordering were implemented.
- Review session RED: all 12 initial protocol tests failed before the
  implementation. GREEN after verdict intent, native readback, fixing,
  approval, Human, atomic fixes, pair CAS, and re-review were implemented.
- CLI RED: 2 failures proved review Human and production review delegation
  remained unwired. GREEN: all 27 CLI session tests.
- Production adapters RED: all 3 acquisition tests and all 3 session tests
  failed before their ports existed. GREEN: both production suites pass.
- Final recovery RED:
  - accepted server response followed by a lost client response propagated the
    transport error instead of accepting exact native readback;
  - an external/stale native requested-changes review did not block approval;
  - fixing authority after a crash repaired draft state but not its missing
    label;
  - an atomic branch/review pair accepted before a process crash could not
    advance the stale local manifest.
- Final recovery GREEN:
  - exact marker-bearing native readback resolves accepted-response ambiguity;
  - stale/external requested changes block automated approval;
  - fixing recovery repairs labels and draft state;
  - a matching same-generation/attempt/reviewer active pair, exact remote PR
    head, and preserved local fix advance the manifest without republishing.

## Files

- `packages/autopilot/src/lifecycle/review-executor.ts`
- `packages/autopilot/src/lifecycle/review-executor-production.ts`
- `packages/autopilot/src/lifecycle/review-session.ts`
- `packages/autopilot/src/lifecycle/review-session-production.ts`
- `packages/autopilot/src/lifecycle/attempt-workspace.ts`
- `packages/autopilot/src/lifecycle/index.ts`
- `packages/autopilot/src/cli/session.ts`
- Matching CLI, attempt-workspace, executor, production-port, session, and
  recovery tests.

## Verification

- `yarn vitest run test/lifecycle test/dispatcher/coordinator-session.test.ts`
  — 19 files, 230 tests passed.
- `yarn typecheck` — passed.
- `yarn test` — 90 files, 956 tests passed.
- `git diff --check` — passed.

## Self-review

- A child can start only after its unique metadata OID is the exact remote
  review-ref winner and the Task 3 manifest is bound.
- Staleness uses real PR-head progress only; metadata, labels, Project edits,
  comments, and CI do not refresh it.
- Selected reviewer identity differs from the PR author and is preserved for
  stale draft fix recovery.
- Native verdicts are not authoritative until exact selected login, head,
  state, and canonical marker readback matches current intent.
- Native requested changes from stale or other authorities remain blockers;
  stale approvals never authorize terminal state.
- Human/CODEOWNER state cannot be cleared or bypassed, and ready is always the
  last mutation.
- Review fixes cannot publish dirty, unchanged, unrelated, one-sided, or
  authority-lost work.
- Production Project and label projection writes are read back exactly and a
  concurrent Human state stops `In Review`.
- Global activation, merge-prep, merge, and canonical workflow changes remain
  outside Task 5.

## Concerns

- No live GitHub mutation/canary was run, as required by the task boundary.
  Production command construction is covered with injected runners and the
  atomic ref protocol is covered against local bare remotes.
- Task 5 provides production review capabilities but deliberately does not
  connect them to the global `active` dispatcher. That activation belongs to a
  later task.
