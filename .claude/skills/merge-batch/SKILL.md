---
name: merge-batch
description: Human-invoked compatibility tool for surveying PRs and ordinarily merging exact-head, fully gated legacy or unmanaged PRs into next. Never merges or mutates v2-managed work.
---

# Merge batch

Use this only when a human explicitly asks to integrate ready PRs into `next`.
It is a compatibility/operator-control surface alongside Autopilot v2, not a
second lifecycle coordinator.

Read
[`references/merge-mechanics.md`](references/merge-mechanics.md),
[`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md), and the
[`active-active lifecycle design`](../../../docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md)
before acting.

## Authority

This skill may:

- read open PR, Project, review, check, CODEOWNERS, and v2 observer state;
- order already-ready PRs;
- issue an ordinary, exact-head, rebase merge of a legacy/unmanaged PR into
  `next`;
- report every skip and blocker.

It may not:

- create an approval or dismiss/request a review;
- bypass branch protection or any review/check/CODEOWNER gate;
- merge to `main`;
- rebase, force-update, or otherwise modify a PR branch;
- claim/release v2 implementation or review authority;
- merge a v2-managed PR;
- mutate draft state, labels, Project lifecycle fields, comments, or cleanup;
- use another runner’s local artifacts as evidence.

Human CODEOWNER, CI, independent review, and merge protection are always
authoritative.

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

Classify v2-managed PRs first. Apply the ordinary merge gate below only when
the observer and exact claim/ref inspection positively proves no v2 ownership.
Any lifecycle diagnostic, unavailable observer/ref read, branch-claim
ancestry, review ref, stable v2 branch ambiguity, or contradictory mapping
means preserve and skip.

## v2-managed PRs

This skill **must not merge a v2-managed PR**. Report its observer state and
leave authorization and execution to the v2 lifecycle's exact-head evaluator.
That evaluator alone verifies the terminal review-ref marker against the
current branch head, obtains a complete paginated changed-file set, applies
CODEOWNERS and identity separation, checks native gates, and performs the
exact-head merge.

If a v2-managed PR is behind or conflicting, report it for the v2 children
ladder (tier-0 update-branch or reconcile child). Human owns semantic or
CODEOWNER-sensitive conflicts. This skill neither prepares nor merges the
branch.

## Legacy/unmanaged PRs

Legacy/unmanaged PRs may use the ordinary merge gate when already clean and
fully gated:

1. target is `next`, directly or as a valid stack layer;
2. PR is open and non-draft;
3. no Human hold is active;
4. all required checks are completed successfully;
5. exact-current-head independent approval is present;
6. every CODEOWNERS set is satisfied from the complete changed-file set;
7. the author does not satisfy their own review requirement;
8. GitHub reports the PR cleanly mergeable;
9. the head OID still equals the surveyed OID.

Missing, stale, red, pending, incomplete, truncated, or ambiguous evidence
means skip. Do not silently adopt legacy work into v2 or synthesize lifecycle
evidence. Behind, conflicting, ambiguously mapped, or Human-held legacy work
is reported for migration/human reconciliation and preserved.

## Order

Build and surface an ordered manifest before merging:

1. roots before dependent stack layers;
2. explicit dependencies before independent work;
3. lower overlap/risk before higher overlap/risk;
4. stable FIFO as the final tie-breaker.

Never merge an upper stack layer before its base. For a large batch, work in
small waves and re-read `next` plus every remaining PR after each wave.

## Execute

For each legacy/unmanaged candidate, re-read the ordinary merge gate
immediately before the merge, then use only:

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono \
  --match-head-commit <surveyed-head-oid>
```

After success, fetch/re-read `next` and rebuild the remaining manifest. If the
command fails or the head changed, stop on that PR and report the exact reason;
do not retry through a weaker path.

## Report

Return:

- merged PRs with the exact head used;
- skipped PRs grouped by draft/Human/review/CODEOWNER/CI/mergeability/head
  blocker;
- v2-managed behind/conflicting PRs left to the v2 children ladder;
- legacy ambiguous work left intact;
- remaining stack order after the final `next` head.

Do not perform local artifact cleanup. Autopilot v2 cleanup is guarded,
attempt-scoped, and operator-enabled separately.
