# Enqueue mechanics — legacy compatibility path

This reference supports the human-invoked `merge-batch` skill. It deliberately
contains no PR-branch preparation or alternative review path. Autopilot v2
owns preparation, enqueue authorization, execution, and lifecycle
reconciliation for v2-managed PRs.

Nothing in this path merges. The merge queue on `next` is the only merger of
ordinary PRs ([`DR-2026-08-18-b`](../../../../log/decisions/2026-08-18-merge-queue-on-next.md),
amended by
[`DR-2026-08-20`](../../../../log/decisions/2026-08-20-human-surface-enqueue-gate.md));
this path proves a legacy/unmanaged candidate is fully gated and hands its
exact head to the queue.

## 1. Snapshot candidates

```bash
gh pr list --repo Jinn-Network/mono --state open \
  --json number,title,author,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,body
```

Keep the exact `headRefOid` with every manifest row. Include stack layers whose
base is another open PR branch; do not filter the initial query to `base:next`.

Use the v2 observer for lifecycle ownership and Human diagnostics:

```bash
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/.github/scripts/resolve-autopilot.sh"
autopilot --mode observe --once --json status
```

## 2. Exclude v2-managed PRs

This compatibility path **must not enqueue a v2-managed PR**. Inventory fields
such as `latestReviews` and `files` cannot prove the terminal review-ref marker
or a complete changed-file set. Report the PR's observer state and leave it to
the v2 lifecycle's exact-head evaluator, which owns complete gate evaluation
and enqueue execution.

Treat a PR as v2-managed when its ordinary observer item reports
`legacy:false`, a related orphan-claim diagnostic reports `v2Marked:true`, or
its body contains the exact v2 mapping. These signals include ownership proven
from branch-claim ancestry or a review ref. A missing marker is not negative
evidence. The remaining sections apply only when the observer plus exact
branch-claim/review-ref inspection positively proves no v2 ownership. An
unavailable/contradictory read, stable v2 branch ambiguity, or mapping
diagnostic means skip.

## 3. Check native gates

For each candidate, re-read detailed state:

```bash
gh pr view <N> --repo Jinn-Network/mono \
  --json number,state,author,headRefOid,headRefName,baseRefName,isDraft,mergeable,statusCheckRollup,latestReviews,body
gh api "repos/Jinn-Network/mono/pulls/<N>"
gh api "repos/Jinn-Network/mono/pulls/<N>/files?per_page=100" \
  --paginate --slurp
```

From the first REST response, bind `head.sha`, `base.ref`, `base.sha`, and
`changed_files` to the candidate. Require `head.sha` and `base.ref` to match
the surveyed PR. Validate that every file page is present, every returned row
has a filename, the flattened filename count equals `changed_files`, and the
filenames are unique. GitHub caps this endpoint at 3,000 files; skip when
`changed_files` exceeds 3,000. If changed-file completeness cannot be
established, skip the PR.

Require all of:

- `state == OPEN`;
- `isDraft == false`;
- target/base relation is valid;
- every required check is completed with `SUCCESS` (explicitly permitted
  non-required skips may be ignored);
- `mergeable == MERGEABLE`;
- no v2 Human evidence;
- surveyed and current `headRefOid` are equal.

Pending, cancelled, failed, missing, or truncated evidence is not green.

## 4. Exact-current-head CODEOWNER Approve

The generic approving-review count on `next` is **0**. Do not require a review
on an ordinary PR, and do not treat the reviewer's identity as a gate: one
operator's agent reviewing another operator's PR and the same operator's agent
reviewing it are the same act, so no independence claim attaches to either.

The one review gate that survives is CODEOWNERS on the human-surface set. Parse
`.github/CODEOWNERS` from the exact candidate base OID (`base.sha`), not from
`next` or another moving branch. Matching is last-rule-wins. Build the required
owner set from the complete paginated file response for every touched file. If
changed-file data or owner expansion is incomplete, skip.

When that owner set is non-empty, require a qualifying approval for every
entry. `latestReviews` is the latest review per reviewer; count only an entry
where:

- state is `APPROVED`;
- review commit OID equals current `headRefOid`;
- reviewer login differs from PR author — GitHub refuses to record the
  authoring account's own approval, so this is platform plumbing, not an
  independence claim;
- no later effective requested-changes state blocks the PR.

An old-head approval never carries forward merely because GitHub’s aggregate
decision remains approved; `dismiss_stale_reviews_on_push` on `next` makes that
mechanical. Do not manufacture a review to satisfy a missing gate.

When the required owner set is empty, the candidate needs no approval at all.
The required-check set plus the queue's tested landing is the whole quality
gate. Platform architecture ownership lives in `.github/architecture-owners`
and is enforced by its own check — it is not a GitHub review gate here.

## 5. Stack order

Build a graph where `baseRefName` equal to another open PR’s `headRefName`
creates a parent edge. Enqueue roots before children, and let each root land
before its child is enqueued. A missing parent is an orphan and is skipped.

Within a level, order explicit dependencies first, then lower file-overlap/risk,
then FIFO. Surface the order before executing.

## 6. Execute one exact-head enqueue

Immediately re-read the PR and repeat Sections 3–4, including paginated files.
Then:

```bash
gh api graphql \
  -f query='
    mutation($id:ID!,$oid:GitObjectID!){
      enqueuePullRequest(input:{pullRequestId:$id, expectedHeadOid:$oid}){
        mergeQueueEntry{ id position state }
      }
    }' \
  -f id="$(gh pr view <N> --repo Jinn-Network/mono --json id -q .id)" \
  -f oid="<headRefOid>"
```

This is the only landing command in this compatibility path. `gh pr merge` and
`--auto` are both out (repo-level `allow_auto_merge` is `false`). If the
mutation is rejected, the gate remains unsatisfied. If the head changed,
`expectedHeadOid` fails the mutation rather than queueing an unsurveyed
commit — rebuild the manifest.

The queue, not this path, performs the merge. Wait for it:

```bash
gh pr view <N> --repo Jinn-Network/mono --json state,mergeStateStatus
git fetch origin next
git rev-parse origin/next
```

Poll until the PR is `MERGED` — or report the exact reason if the entry is
ejected. Record the new `next` OID and re-read every remaining PR. A former
stack child or independent PR may now be behind; that is queue-normal, and its
branch is not updated here.

## 7. Behind, conflicts, and ambiguous state

- behind PR, v2-managed or legacy: queue-normal. The queue's speculative merge
  handles staleness and the `update-branch` ladder is retired, so behind is not
  a blocker and not a skip reason.
- v2-managed conflicting PR: report it for the v2 reconcile child.
- v2-managed semantic/CODEOWNER conflict: report its Human hold.
- legacy conflicting PR: preserve and report for explicit migration or Human
  handling.
- dirty or missing local artifacts: irrelevant to shared enqueue eligibility.
- contradictory branch/PR/issue mapping: preserve and report; do not enqueue.

## 8. Large batches

Use waves only to bound operator attention. Each wave is a fresh snapshot and
ordered manifest, not a temporary integration branch. Stop a wave when `next`
changes outside the observed sequence or any gate becomes ambiguous.
