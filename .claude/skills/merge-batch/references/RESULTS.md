# Active-active workflow pressure results

Date: 2026-07-20

Scope: read-only pressure testing of the canonical Autopilot workflow skills.
No GitHub state, branches, worktrees, credentials, or deployments were changed.

## Baseline: expected failures

The pre-v2 skills failed three concurrency scenarios:

1. **Implementation recovery**
   - The implementation skill treated an existing early draft PR as competing
     work instead of the durable continuation of a newly won claim.
   - It also owned Project transitions and local cleanup that belong to the
     lifecycle engine.
2. **Review fixes**
   - The review skill directly reviewed, pushed, readied, and projected Project
     state without an exact-head session protocol.
   - A crash between those operations could leave an ambiguous durable outcome.
3. **Merge preparation and operator tools**
   - Merge preparation and the human batch tool overlapped on branch mutation
     and lifecycle state.
   - Historical guidance also allowed ordinary review and protection gates to be
     weakened instead of treating them as invariants.

These failures established the behavior that the v2 rewrite had to remove.

## Revised workflow contracts

The revised skills passed the same scenarios:

- `implement-issue` consumes a won claim and existing early draft PR, keeps the
  eight-stage implementation workflow and its internal self-review/fix loop,
  checkpoints commit-producing progress, and delegates durable transitions to
  the session protocol.
- `review-pr` consumes an exact-head review claim, keeps one review coordinator
  through fix and re-review, publishes fixes conditionally, and delegates
  verdict transitions to the session protocol.
- `merge-prep` is limited to mechanical preparation in its detached attempt.
  Conditional publication, draft/ready state, escalation, and cleanup remain
  session responsibilities.
- `eng-day` observes GitHub state and describes proposed recovery, while the
  operator invokes recovery explicitly through the cutover runbook. It does
  not use local artifacts or process presence as shared ownership evidence.
- `merge-batch` leaves v2-managed PR merge authorization and execution to the
  v2 lifecycle's exact-head evaluator. It may perform only an ordinary,
  exact-head merge of legacy/unmanaged work after complete review, CI,
  mergeability, and Human/CODEOWNER gates pass. It never supplies missing
  authority or competes with v2 branch preparation.

## Verification

The executable contracts are:

- `packages/autopilot/test/implement-issue-skill.test.ts`
- `packages/autopilot/test/review-pr-skill.test.ts`
- `packages/autopilot/test/autopilot-runtime-skill.test.ts`
- `packages/autopilot/test/workflow-skills-v2.test.ts`

The historical merge-batch experiment recorded here previously is superseded by
the active-active lifecycle design and remains available through repository
history. Current authority and gate rules live in the canonical skills and
`docs/engineering/handbook.md`.
