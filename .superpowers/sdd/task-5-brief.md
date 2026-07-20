# Task 5 — Review, Fix, Re-review, and Verdict Recovery

## Boundary

Implement the v2 review phase described by the approved active-active design.
This task wires review acquisition and the existing `review-verdict`,
`review-fix-publish`, and review-phase `human` session commands. It does not
wire merge-prep, merge, or the global `active` controller, and it does not edit
canonical workflow skills yet.

The review session owns the complete review → fix → independent re-review loop.
Do not return blocking findings to implementation merely to preserve role
purity.

## Review action executor

Add an injected, testable review action executor and a production Git/GitHub
port with these contracts:

1. Re-read the exact PR, issue mapping, lifecycle marker, head, branch, base,
   draft state, Human overlay, author, native reviews, and current review ref
   before claiming.
2. Normal entry is a non-draft `awaiting-review` PR. Recovery entry may be a
   stale draft `review-fixing` PR. Contradictory mappings or malformed evidence
   go to structured Human; no child starts.
3. Select one configured reviewer credential whose resolved login differs from
   the PR author. A single credential may review PRs authored by a different
   identity. For a stale draft fix recovery, prefer/require the prior reviewer;
   if that credential is unavailable, enter structured
   `reviewer-identity-unavailable` Human state rather than changing identity.
4. Build an append-only review metadata commit under
   `refs/jinn-autopilot/review-claims/v1/<pr>`. Initial creation has no parent;
   every later record has exactly the current review-ref OID as its sole parent.
   The active record binds the exact PR/head, a new generation/attempt, selected
   reviewer, and real timestamps. Publish through Task 1 exact-state semantics;
   on ambiguous responses, read the exact ref. Only the exact winning metadata
   OID may start a child.
5. A current non-stale active generation is not claimable. A stale generation
   may be advanced append-only to a replacement active generation. A terminal
   record for an older head may seed a new exact-head generation; a matching
   terminal approval is not re-reviewed.
6. Create a Task 3 detached attempt at the exact PR head only after the claim
   wins. Bind the manifest to PR, branch, base, generation, review-ref OID,
   selected login, and review approval policy. Normal approval policy is
   `approve-eligible`; CODEOWNER/human-surface policy is
   `human-codeowner` and must be enforced by the session authority, not only by
   a prompt.
7. Spawn through the configured coordinator/runtime. Hermes remains the global
   runtime when configured. No upstream Hermes change.
8. Project `In Review` and the permanent `engine:review` label are repairable
   projections. Claim/ref authority must exist before spawn. Human is dominant.

## Verdict protocol

Wire `autopilot session review-verdict --state
<APPROVE|REQUEST_CHANGES> --body-file <path>` for review manifests only.

For each exact head verdict:

1. Re-read and strictly validate the manifest, selected credential, current
   review ref/generation/attempt/reviewer/head, exact PR number/head/branch/base,
   lifecycle marker, Human overlay, author inequality, and draft policy.
2. Create a unique marker and append an exact-parent `verdict-intent` review
   metadata commit. Publishing the intent must win/read back before any native
   review call.
3. Submit the native GitHub review through the reviews API with explicit
   `commit_id`, the selected reviewer token, the exact event, and a body
   containing the canonical marker. Never use ambient auth and never submit a
   verdict for a changed head.
4. Read native reviews back and accept only the selected login, exact commit,
   exact state, and exact marker. An accepted response followed by a lost client
   response is recovered by read-back; do not duplicate an already confirmed
   marker-bearing verdict.
5. `REQUEST_CHANGES`: append an exact-parent `fixing` record only after native
   read-back, reconcile labels, then make the PR draft before permitting edits.
   A crash at any point remains recoverable from the current intent/native
   review/ref/draft evidence.
6. `APPROVE`: it is forbidden under `human-codeowner`; that path must preserve
   the PR as draft and enter structured Human without creating an automated
   approval. For `approve-eligible`, append `terminal-approved` only after exact
   native approval read-back, reconcile labels/Project state, and make the PR
   ready last. A matching terminal record is an append-only tombstone.
7. Re-read Human evidence immediately before every inverse mutation and before
   ready. A newly arriving Human hold stops the sequence without clearing it.
8. A stale/late reviewer may physically submit a native verdict, but only the
   marker matching the current exact review-ref intent is authoritative.
   Native `CHANGES_REQUESTED` always remains a blocker.

## Fix publication and re-review

Wire `autopilot session review-fix-publish` for review manifests:

1. Require the exact current `fixing` record for the manifest generation,
   selected reviewer, old head, attempt, and review-ref OID; exact draft PR
   number/branch/base/marker authority; no Human overlay.
2. Require a genuinely new local commit/tree rooted at the old head. Preserve
   dirty/uncommitted or ambiguous local work instead of publishing it
   accidentally.
3. Create the next append-only `active` review metadata commit locally for the
   new head, keeping the same session generation/attempt/reviewer.
4. Atomically advance the exact PR branch and review ref with both old OIDs as
   leases. If atomic push is unavailable, fail closed. An ambiguous response is
   accepted only when read-back proves both refs equal the paired candidate
   OIDs; one-sided or changed results fence the attempt and preserve local work.
5. Advance the manifest's progressive expected head and review-ref OID together
   through an exact manifest CAS. Static identity/authority fields remain
   immutable.
6. Keep the PR draft and return control to the same session for a genuinely
   independent review pass of the new head. Each further finding repeats the
   intent → request changes → fixing → atomic publication loop without a fixed
   round-count limit.

## Recovery and reaper integration

1. Preserve the approved two-hour rule: review liveness advances only when the
   PR head changes or a matching native terminal verdict is confirmed. Intent
   records, comments, CI, labels, Project edits, and empty metadata activity do
   not refresh it.
2. Recovery of matching native verdicts completes the exact intent to `fixing`
   or `terminal-approved` and then repairs draft/labels/Project/ready in safe
   order. Missing native verdicts do not synthesize one.
3. Reaper stale transitions are exact-parent review-ref advances. Two reapers
   race safely; one wins. A stale draft fix PR remains draft and review-fix
   recoverable, never implementation/Todo.
4. If prior recovery reviewer identity is unavailable, enter Human without
   discarding the ref, PR, branch, or local artifacts.

## Production and authority constraints

- GitHub is the only shared state. No runner registry, IPC, or local worktree
  inference may participate in ownership.
- Every Git and GitHub mutation uses the one selected reviewer credential and
  canonical HTTPS publication path from Task 3.
- Reviewer and PR author identities must differ. Implementer and reviewer
  configured identities remain separate.
- Review cannot merge, bypass CI/CODEOWNER/human gates, force-push one ref
  independently, clear Human, or approve a head/generation it does not own.
- `engine:review` remains permanent throughout v2.
- Global `active`, merge-prep, and merge remain explicitly unwired after this
  task.

## TDD and verification

Write failing tests first, then the minimal implementation. Cover at least:

- two review contenders and exact single winner, including absent-ref creation,
  stale replacement, ambiguous read-back, and late loser fencing;
- reviewer selection, author inequality, single-credential review of
  other-authored PRs, prior-reviewer recovery, and unavailable identity Human;
- child starts only after exact review-ref win/read-back;
- verdict intent before native review, exact `commit_id`/login/marker read-back,
  accepted-response ambiguity, and duplicate retry idempotency;
- request-changes → fixing → draft-before-edits ordering;
- approval → terminal → ready-last ordering;
- CODEOWNER/human-surface cannot approve and remains draft Human;
- Human arrival races at every inverse mutation;
- atomic branch + review-ref fix publication success, lease loss, unsupported
  atomic remote, ambiguous both-applied, and impossible one-sided read-back;
- progressive manifest pair CAS and stale writer rejection;
- same-session multi-round fix/re-review with approval bound to final head;
- late stale approvals ignored while stale/native requests-changes still block;
- crash recovery at intent, native verdict, fixing, redraft, atomic push, terminal,
  and ready transitions;
- two-hour liveness ignores metadata-only/comment/CI/Project activity;
- selected HTTPS reviewer identity and Hermes/Claude runtime parity;
- review commands are wired while merge-prep/merge and global active remain
  unwired.

Required final commands from `packages/autopilot`:

```bash
yarn vitest run test/lifecycle test/dispatcher/coordinator-session.test.ts
yarn typecheck
yarn test
git diff --check
```

Produce `.superpowers/sdd/task-5-report.md`, commit the completed phase, and
return the commit SHA and fresh test counts.
