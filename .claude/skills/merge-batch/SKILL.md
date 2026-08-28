---
name: merge-batch
description: Human-invoked compatibility tool for surveying PRs and enqueueing exact-head, fully gated legacy or unmanaged PRs to the merge queue on next. The queue does the merging. Never enqueues or mutates v2-managed work.
---

# Merge batch

Use this only when a human explicitly asks to integrate ready PRs into `next`.
It is a compatibility/operator-control surface alongside Autopilot v2, not a
second lifecycle coordinator.

This skill never merges. The merge queue on `next` is the only merger of
ordinary PRs (handbook rule 4, rewritten by
[`DR-2026-08-18-b`](../../../log/decisions/2026-08-18-merge-queue-on-next.md)
and amended by
[`DR-2026-08-20`](../../../log/decisions/2026-08-20-human-surface-enqueue-gate.md)).
What this skill does is order legacy/unmanaged candidates and enqueue them at
an exact head; the queue tests the speculative merge and lands it.

Read
[`references/merge-mechanics.md`](references/merge-mechanics.md),
[`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md), and the
[`active-active lifecycle design`](../../../docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md)
before acting.

## Authority

This skill may:

- read open PR, Project, review, check, CODEOWNERS, and v2 observer state;
- order already-ready PRs;
- enqueue a legacy/unmanaged PR to the merge queue on `next`, pinned to its
  exact surveyed head;
- report every skip and blocker.

It may not:

- merge anything itself — no `gh pr merge`, no direct push, no `--auto`
  (repo-level `allow_auto_merge` is `false`);
- create an approval or dismiss/request a review;
- bypass or weaken the merge queue, branch protection, or any required-check
  or CODEOWNERS gate;
- merge or enqueue to `main`;
- rebase, force-update, or otherwise modify a PR branch;
- claim/release v2 implementation or review authority;
- enqueue a v2-managed PR;
- mutate draft state, labels, Project lifecycle fields, comments, or cleanup;
- use another runner’s local artifacts as evidence.

The required-check set and the queue's tested landing are the quality gate, and
CODEOWNERS on the human-surface set is the credential gate. Both are machine-
enforced and always authoritative. Reviewer identity is not a gate: the generic
approving-review count on `next` is 0, and no independence claim attaches to
whichever operator credential reviewed.

## Survey

Read all open PRs, including stack layers, and the v2 observer:

```bash
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/.github/scripts/resolve-autopilot.sh"
gh pr list --repo Jinn-Network/mono --state open \
  --json number,title,author,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,body
autopilot --mode observe --once --json status
```

A PR is **v2-managed** when its ordinary observer item reports
`legacy:false`, when a related orphan-claim diagnostic reports
`v2Marked:true`, or when its body carries the exact `jinn-autopilot:v2`
issue/branch mapping marker. These signals include ownership proven from
durable branch-claim ancestry or a review ref. A missing body marker never
proves that a PR is unmanaged: it may be an incomplete projection or a Human
edit. Do not infer ownership from a local worktree or process.

Inventory fields such as `latestReviews` or `files` are not complete merge
evidence. In particular, they cannot prove the v2 terminal review-ref marker
or changed-file completeness.

Classify v2-managed PRs first. Apply the enqueue gate below only when the
observer and exact claim/ref inspection positively proves no v2 ownership.
Any lifecycle diagnostic, unavailable observer/ref read, branch-claim
ancestry, review ref, stable v2 branch ambiguity, or contradictory mapping
means preserve and skip.

## v2-managed PRs

This skill **must not enqueue a v2-managed PR**. Report its observer state and
leave authorization and execution to the v2 lifecycle's exact-head evaluator.
That evaluator alone verifies the terminal review-ref marker against the
current branch head, obtains a complete paginated changed-file set, applies
CODEOWNERS, checks the required-check set, and enqueues the exact head.

A v2-managed PR that is merely **behind** is queue-normal: the queue's
speculative merge supersedes staleness handling, and the tier-0 `update-branch`
ladder is retired. Do not report a behind PR as blocked. Report a genuinely
**conflicting** one for the v2 children ladder, whose surviving tier is the
reconcile child. The operator owns semantic or CODEOWNER-sensitive conflicts.
This skill neither prepares nor enqueues the branch.

## Legacy/unmanaged PRs

Legacy/unmanaged PRs may be enqueued when already clean and fully gated:

1. target is `next`, directly or as a valid stack layer;
2. PR is open and non-draft;
3. no Human hold is active;
4. all required checks are completed successfully;
5. every CODEOWNERS set matched by the complete changed-file set is satisfied
   by an approval against the current head;
6. GitHub reports the PR cleanly mergeable;
7. the head OID still equals the surveyed OID.

No generic approving review is required — the count on `next` is 0, and the
gate list above is the whole gate. Where CODEOWNERS does apply, GitHub refuses
to record the authoring account's own approval, so the approval carries a
non-author operator credential; that is platform plumbing, not a reviewer-
independence requirement, and this skill never supplies a missing approval.

Missing, stale, red, pending, incomplete, truncated, or ambiguous evidence
means skip. Do not silently adopt legacy work into v2 or synthesize lifecycle
evidence. Conflicting, ambiguously mapped, or Human-held legacy work is
reported for migration/human reconciliation and preserved. A merely behind PR
is queue-normal and is not a skip reason.

## Order

Build and surface an ordered manifest before enqueueing:

1. roots before dependent stack layers;
2. explicit dependencies before independent work;
3. lower overlap/risk before higher overlap/risk;
4. stable FIFO as the final tie-breaker.

Never enqueue an upper stack layer before its base has landed. The queue lands
one entry at a time, so an ordered manifest is a sequence of enqueues, not a
batch. For a large batch, work in small waves and re-read `next` plus every
remaining PR after each wave.

## Execute

For each legacy/unmanaged candidate, re-read the enqueue gate immediately
before enqueueing, then use only the enqueue mutation, pinned to the exact
surveyed head:

```bash
gh api graphql \
  -f query='
    mutation($id:ID!,$oid:GitObjectID!){
      enqueuePullRequest(input:{pullRequestId:$id, expectedHeadOid:$oid}){
        mergeQueueEntry{ id position state }
      }
    }' \
  -f id="$(gh pr view <N> --repo Jinn-Network/mono --json id -q .id)" \
  -f oid="<surveyed-head-oid>"
```

`expectedHeadOid` is what makes this exact-head: the mutation fails rather than
queueing a head the survey never saw. Never `gh pr merge`, never `--auto`.

Then wait for the queue to land it: poll until the PR reports `MERGED`, fetch
`next`, and rebuild the remaining manifest against the new head. If the
mutation fails, the head changed, or the entry is ejected, stop on that PR and
report the exact reason; do not retry through a weaker path.

## Report

Return:

- enqueued PRs with the exact head pinned, the queue entry position/state, and
  the landed `next` commit for each one the queue merged;
- skipped PRs grouped by draft/Human/CODEOWNER/required-check/mergeability/head
  blocker, plus any queue ejection;
- v2-managed conflicting PRs left to the v2 children ladder;
- legacy ambiguous work left intact;
- remaining stack order after the final `next` head.

Do not perform local artifact cleanup. Autopilot v2 cleanup is guarded,
attempt-scoped, and operator-enabled separately.
