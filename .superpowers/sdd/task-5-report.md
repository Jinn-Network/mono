# Task 5 Report — Review, Fix, Re-review, and Verdict Recovery

## Status

DONE — independent review findings resolved

Commit: recorded in the Task 5 handoff after commit creation.

Independent review: `.superpowers/sdd/task-5-review.md` is included with this
fix commit.

## Re-review addendum closure

- The production ready boundary now independently revalidates the current
  exact terminal review-ref authority, durable/projected Human evidence, and
  effective native requested-changes blockers immediately before invoking
  `gh pr ready`. A late Human record, Human Project/label projection, or
  effective blocker fails closed without issuing the ready mutation.
- Native review reads now use `gh api --paginate --slurp`, require the slurped
  page-array shape, and flatten every page exactly before decoding reviews.
- Human-comment idempotency now compares the complete canonical comment body.
  A different comment that contains the marker or canonical body as a
  substring cannot suppress the required Human comment.

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
- Closed every Critical and Important finding from the independent review:
  - canonical native review markers now bind the exact verdict-intent UUID and
    selected reviewer login; snapshot and session recovery require exact
    login, commit, state, intent, and marker;
  - verdict and fix-publication boundaries freshly rederive the unique open
    PR↔issue↔branch mapping and current-head CODEOWNER policy instead of
    trusting the manifest;
  - Human review records publish and win exact-parent authority before draft,
    labels, comments, or Project projections; current-head Human records are
    authoritative, repairable, and non-reapable;
  - effective native requested-changes state is evaluated per reviewer without
    substring exemptions, including unresolved older-head blockers, and is
    reread after approval, immediately before terminal publication, and
    immediately before ready;
  - acquisition rereads Human after projection and performs a final exact
    ref/head/Human/current-claim fence before spawn;
  - production labels, Project status, draft, ready, Human comments, and
    acquisition projections recover accepted-response errors only after exact
    desired-state readback.
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
- Independent-review Critical marker/login RED:
  - 2 failures proved the native marker omitted the intent UUID/login and
    snapshot terminal recovery could not validate the corrected exact marker.
  - GREEN: codecs, snapshot, and session recovery require the exact intent UUID
    and selected login; wrong-login marker copying does not complete intent.
- Independent-review authority/Human/blocker/acquisition RED:
  - 13 failures covered substring blocker exemption, effective-review
    supersession, post-approval/pre-terminal/pre-ready blocker races,
    Human-record ordering and lost-record races, closed/remapped/policy-drift
    boundaries, current-head Human reclaim, and missing final acquisition
    fences.
  - 1 additional failure proved unresolved older-head native requested changes
    could be ignored when no later decisive review superseded them.
  - 1 additional failure proved acquisition returned early when the snapshot
    already exposed a Human hold instead of repairing its projection.
  - GREEN: 40 of 40 review-session and review-executor tests.
- Independent-review production authority RED:
  - 2 failures proved session boundaries trusted manifest issue/CODEOWNER
    authority.
  - GREEN: fresh unique open mapping and exact-head CODEOWNER policy readback.
- Independent-review accepted-response RED:
  - 7 failures proved successful-but-lost label, Project, draft, ready,
    comment, and acquisition projection mutations propagated transport errors.
  - 1 negative failure proved a copied Human marker in a different comment body
    could satisfy readback.
  - GREEN: 16 of 16 production review session/acquisition tests, including
    exact-body comment readback.
- Independent-review Human snapshot RED:
  - 1 failure proved a current-head Human review record was not independently
    authoritative before its projections existed.
  - GREEN: lifecycle snapshots synthesize the durable Human hold directly from
    the exact current review record.
- Re-review addendum RED:
  - 3 failures proved the production ready operation itself did not reject a
    durable Human record, projected Human hold, or native blocker arriving
    after session-level checks;
  - 1 failure proved native review pagination neither requested `--slurp` nor
    decoded multiple pages;
  - 1 failure proved initial Human-comment idempotency accepted a substring
    match instead of complete canonical-body equality.
  - GREEN: 43 of 43 focused review session and production adapter tests.

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
  — 19 files, 262 tests passed.
- `yarn typecheck` — passed.
- `yarn test` — 90 files, 988 tests passed.
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
  exact prior-round selected-reviewer requests may be superseded only by a new
  exact-head approval in the same generation, while unresolved stale/other
  requested changes remain blockers and stale approvals never authorize
  terminal state.
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
- Unique open PR mapping is rederived through the production GitHub CLI read
  surface and CODEOWNER policy from the exact head object; no live GitHub
  pagination/canary was exercised in this task.
- Task 5 provides production review capabilities but deliberately does not
  connect them to the global `active` dispatcher. That activation belongs to a
  later task.
