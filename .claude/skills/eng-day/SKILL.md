---
name: eng-day
description: Read-only daily engineering brief for Jinn. Combines the current sprint with Autopilot v2's GitHub-derived lifecycle view, Human holds, native merge gates, local runner capacity, and drift diagnostics. Never dispatches or mutates work.
---

# Engineering day

Produce the operator’s daily engineering brief. GitHub is the sole shared
state for Autopilot lifecycle decisions. This skill observes that state; it is
not a dispatcher, reaper, merge tool, or recovery writer.

## Read first

- [`CLAUDE.md`](../../../CLAUDE.md)
- [`docs/engineering/handbook.md`](../../../docs/engineering/handbook.md)
- [`active-active lifecycle design`](../../../docs/superpowers/specs/2026-07-19-active-active-autopilot-lifecycle-design.md)
- [`Autopilot v2 cutover runbook`](../../../docs/runbooks/autopilot-v2-cutover.md)

## Read state

Run independent reads in parallel:

```bash
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/.github/scripts/resolve-autopilot.sh"
gh project item-list 1 --owner Jinn-Network --format json --limit 800
gh issue list --repo Jinn-Network/mono --state open \
  --json number,title,labels,assignees,createdAt,updatedAt --limit 300
gh pr list --repo Jinn-Network/mono --state open \
  --json number,title,author,createdAt,updatedAt,reviewDecision,mergeable,isDraft,headRefName,headRefOid
autopilot --mode observe --once --json status
```

Issue Type still comes from GraphQL because the ordinary issue-list JSON does
not expose it. Use the Project view for Sprint, Status, Blocked on, Effort, and
Priority — including machine-created child issues (review findings and
reconciles), which are triaged onto the board at filing time. Use a board limit
above the current item count.

The v2 observer is the authoritative lifecycle explanation. It includes draft
PRs because draft may mean implementation, a child fix/reconcile session, or a
Human hold. Do not infer lifecycle from a ready-only PR query. Status on the
board is paint-only — never treat it as authority.

For a disputed item, use:

```bash
# shellcheck disable=SC1091
. "$(git rev-parse --show-toplevel)/.github/scripts/resolve-autopilot.sh"
autopilot --mode observe --once explain issue <N>
autopilot --mode observe --once explain pr <N>
```

## State distinctions

Keep these signals separate in the brief:

- **Claiming** — branch/ref evidence elects one authoritative attempt.
- **Progress evidence** — a real branch-head advance or marker-bound review
  verdict.
- **Liveness** — local PID/session health on this runner only.
- **Recovery** — a GitHub-derived stale transition that permits an ordinary
  new claim.

The initial stale threshold is a generous two-hour period without real
progress. Comments, CI activity, Project edits, and local logs do not refresh
it. A missing local worktree is never proof that another host abandoned work.

Capacity is per-runner: implementation and review caps belong to each process.
Report this runner’s configured caps and active local children separately from
the GitHub queue. There is no global capacity, shared license signal, heartbeat
registry, or runner-to-runner coordination service.

## Attention lanes

Classify each current-sprint item into one lane:

1. **Needs Human**
   - explicit Human lifecycle overlay;
   - human-surface PR awaiting CODEOWNER Approve;
   - design/product/scope decision;
   - ambiguous legacy mapping or unpublished local work reported during
     cutover;
   - failing native gate that needs operator action.
2. **Autopilot lifecycle**
   - eligible Todo issue;
   - actively implementing draft;
   - ready for independent review;
   - open review-finding or reconcile child issues (marker-bearing fixes);
   - enqueue candidate waiting on required checks, or an entry already in the
     merge queue;
   - stale item eligible for recovery.
3. **Non-Autopilot**
   - epics/trackers;
   - unsupported or under-specified shapes;
   - work intentionally outside the v2 marker protocol.

Review is a pipeline stage, not an identity ritual (handbook rule 4, rewritten
by [`DR-2026-08-18-b`](../../../log/decisions/2026-08-18-merge-queue-on-next.md)
and amended by
[`DR-2026-08-20`](../../../log/decisions/2026-08-20-human-surface-enqueue-gate.md)).
The merge queue on `next` plus the required-check set is the quality gate. The
generic approving-review count on `next` is 0: an agent review pass is
expected, no generic Approve is required, and no claim of independence attaches
to the reviewing credential. CODEOWNER Approve is still required when the diff
hits the human-surface set in `.github/CODEOWNERS`; GitHub will not record the
authoring account's own approval, so those PRs are authored under a non-owner
operator credential — platform plumbing, not an independence claim. Self-enqueue
is permitted once required checks are green, and the merge queue is the only
merger of ordinary PRs into `next`.

## Output

Return five compact sections:

1. **Sprint** — date window, closed/open count, priority mix.
2. **Needs Human today** — highest-priority explicit holds and native gate
   blockers, with exact reason.
3. **Autopilot lifecycle** — counts by phase, open review-finding and reconcile
   children, stale candidates, and proposed recovery; include exact issue/PR
   and head/ref identity for anomalies.
4. **This runner** — mode, runtime, local per-phase capacity, active children,
   backpressure, rate-limit state, and retained cleanup exceptions.
5. **Shipped and drift** — merged/closed in the last 24 hours plus only active
   drift flags.

Relevant drift flags:

- observer diagnostics or contradictory issue/PR/branch mappings;
- stale real progress beyond two hours;
- Human-held PR accidentally made ready;
- code-changing session whose PR is not draft;
- human-surface PR whose CODEOWNER Approve does not match the current head
  (a post-approval push dismisses it);
- red/pending required checks, or a queue entry ejected for flake;
- Done issue still open, or merged PR not projected Done;
- cleanup retained because local state is dirty, ahead, missing, or ambiguous;
- sprint age/bloat and canary/release drift.

## Operator controls

Explain controls without running them:

- `observe` — zero-write status and explanations; this is the default.
- `recover` — reconcile projections and recover stale v2 work, but create no
  new claims.
- `active` — recover, claim new work within this runner’s caps, review, and
  enqueue through the children ladder and the merge queue. Autopilot enqueues;
  it never merges, and never bypasses or weakens the queue or branch
  protection.

Do not start any mode from this skill. Do not recommend running legacy and v2
dispatch together. If activation or recovery is needed, link the cutover
runbook and let the operator invoke it explicitly.

## Failures

- No active sprint: say so and stop the planning portion; still report
  lifecycle/Human safety diagnostics.
- Board unavailable: report the failure and use the v2 observer plus open
  issue/PR reads.
- Observer rejected: surface its exact diagnostic; do not substitute local
  worktree heuristics.
- Authentication failure: name the missing read permission without attempting
  credential repair.
