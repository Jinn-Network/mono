# Single-Surface Autopilot Lifecycle

## Status

- **Date:** 2026-07-21
- **Work shape:** `design`
- **Conversation status:** approved by the operator (Ritsu), section by section
- **Document status:** adopted
- **Implementation status:** Stages 1–5 complete (Stage 5 deletion and closure landed); strangler-fig migration plan in §10

This document amends the active-active lifecycle design
(`2026-07-19-active-active-autopilot-lifecycle-design.md`). Where the two
conflict, this document wins. The 2026-07-19 document remains authoritative
for everything it defines that this amendment does not touch: the branch-native
claim protocol, review-claim ref mechanics, claimless head-pinned merge,
staleness/reaping, attempt isolation, credential handling, and the capability
probe (as reduced by §8).

## 1. Motivation

Live operation of the v2 lifecycle (2026-07-20/21 canary campaign, PR #1883)
showed that nearly every production failure traced to one root: the autopilot
managed **two authoritative surfaces** — derived git/PR facts *and* GitHub
Project state — and had to keep them agreeing. Status writes raced concurrent
board writers, finalization deadlocked on its own projection, read-backs burned
the API budget, and the review-fix and merge-prep sub-protocols each carried
bespoke publication machinery (atomic two-ref pushes, expected-head leases,
range-diff proofs) with bespoke recovery carve-outs.

The claim CAS, the review ref, head-bound verdicts, and the claimless merge —
the parts that never read or wrote the board — were the parts that never
failed.

This amendment finishes the design's own stated principle ("Project status is
an operator-facing lifecycle projection, never the mutual-exclusion
primitive") by making it total: **one authoritative surface (git and PR
primitives), with the board reduced to human intent flowing in and a cosmetic
view flowing out.** It then applies the same unification to review fixes and
merge preparation: every obstacle the pipeline meets becomes an ordinary child
issue routed back through the pipeline itself.

## 2. The authoritative facts

Everything the machine decides is a query over:

| Fact | Surface |
|---|---|
| Issue open/closed, Issue Type, labels, body markers | the issue |
| Claim branch `autopilot/<N>`, claim commit (owner/phase/attempt), head recency | git refs |
| PR existence, draft flag, labels, body marker, merged state | the PR |
| Review claim generation/state | `refs/jinn-autopilot/review-claims/v1/<pr>` |
| Native verdicts (head-bound, marker-bound) and CI | the PR |

No state is stored anywhere else. In particular, **no decision ever reads a
Project field for lifecycle state, and no machine path ever writes one.**

### The board's residual contract

- **Intent, inbound, read-only.** Human triage (Effort, Priority, Blocked-on)
  is read once per cycle for *human-created* work. `Blocked on: Human` set by
  a person is intent and is respected by eligibility. DR-2026-05-20-b remains
  intact for these fields.
- **View, outbound, zero authority.** A scheduled GitHub Action (using the
  built-in `GITHUB_TOKEN`, costing none of the autopilot's budget) repaints
  Status from derived facts on a relaxed cadence. Drift is cosmetic and
  self-corrects; nothing consumes the painted value. The painter also archives
  stale Done items (relocating the board-archive sweep).
- **Machine-created work uses the same Project triage surface.** Child issues
  (§5) are added to the board at filing with Blocked on / Effort / Priority set
  via the production port. Kind labels (`review-finding`, `reconcile`,
  `ci-failure`) remain flat tags. The painter may still repaint Status for
  visibility.

## 3. States

Each state is a predicate, never a stored value. HUMAN overrides everything.

| State | Predicate |
|---|---|
| ELIGIBLE | issue open ∧ triaged ∧ no hold ∧ no claim branch ∧ no open PR |
| CLAIMED | claim commit on `autopilot/<N>`, no PR yet (transient; ages into reap) |
| IN PROGRESS | open **draft** PR |
| DELIVERED | non-draft ∧ `engine:review` ∧ completion marker ∧ no verdict for head |
| IN REVIEW | review ref `active` for exact head, reviewer ≠ author |
| BLOCKED-BY-CHILD | open child issue targeting the PR ∨ `REQUEST_CHANGES` on current head |
| CI-BLOCKED | non-draft ∧ terminal approval for head ∧ CI not green ∧ no human hold ∧ no open child |
| MERGE-READY | non-draft ∧ terminal approval for head ∧ CI green ∧ clean vs base ∧ no open children |
| DONE | PR merged (issue auto-closes via `Closes #N`; zero writes) |
| HUMAN (overlay) | hold label + structured marker comment |

The draft flag means exactly one thing: *implementation not yet delivered*.
It flips non-draft once, at delivery, and never flips back (§6 removes both
paths that re-drafted).

## 4. Transitions

Every transition **is** the work itself; there is no secondary bookkeeping
write to verify, race on, or reconcile.

| From → To | Actor | Mutation |
|---|---|---|
| ELIGIBLE → CLAIMED | scheduler | claim commit CAS on `autopilot/<N>` |
| CLAIMED → IN PROGRESS | executor | open draft PR |
| IN PROGRESS → DELIVERED | session finalize | push marker → ensure label → undraft |
| DELIVERED → IN REVIEW | review claim | review-ref CAS |
| IN REVIEW → gate | reviewer | native APPROVE + terminal ref |
| IN REVIEW → BLOCKED-BY-CHILD | reviewer | native REQUEST_CHANGES + file finding child + release ref |
| BLOCKED-BY-CHILD → DELIVERED | child session | fix commits land on parent branch (head moves → head-bound RC stales; child closes) |
| gate: behind+clean → MERGE-READY | deterministic gate | update-branch API + approval carry-over (§6.1) |
| gate: conflicting → BLOCKED-BY-CHILD | deterministic gate | file reconcile child (idempotent) |
| gate: approved+CI not green → CI-BLOCKED | derivation | no mutation; visible stall state |
| CI-BLOCKED → CI-BLOCKED | scheduler | wait while checks are pending/missing (no retry consumed) |
| CI-BLOCKED → CI-BLOCKED | scheduler | one exact-head CAS-fenced `rerun-failed-jobs` per head |
| CI-BLOCKED → MERGE-READY | gate | rerun passes ∧ integration ladder satisfied |
| CI-BLOCKED → BLOCKED-BY-CHILD | scheduler | persistent failure after rerun, or external-only failure → file `ci-failure` child |
| MERGE-READY → DONE | any process | claimless head-pinned squash merge |

Session finalization is three PR-surface operations. The `pending: project`
failure family of the previous design is unrepresentable.

Recovery is one rule for every state: head unchanged past the staleness
threshold → reap → ordinary re-claim resumes from the last pushed state. The
per-state recovery carve-outs of the previous design (interrupted review-fix,
interrupted prep) are deleted along with the states that required them.

## 5. Children: the only loop

A **child issue** is an ordinary issue created by the machine against a parent
PR. It carries: type `fix`, a kind label (`review-finding`, `reconcile`, or
`ci-failure` — best-effort discovery tag), and a structured body marker naming
the parent (`<!-- jinn-autopilot:child pr=<N>
kind=<kind> -->`). The body marker is the source of truth for machine-child
identity and scheduling; CI-red on the parent PR drives `ci-failure` filing, not
the child label. Machine triage (Priority high — children unblock
delivered work and **outrank fresh claims** in scheduling; Effort routed per
§6.2).

Children run the ordinary pipeline — ELIGIBLE → CLAIMED → IN PROGRESS — with
one difference: their claim commit lands on the **parent's branch** (phase
`fix`/`reconcile`), work lands as append-only checkpoints there, and the child
closes by landing commits rather than by opening its own PR. Session
`checkpoint` / `human` accept `fix|reconcile` branch claims and validate the
parent PR by branch, base, and exact head — not by child-issue body markers or
draft state. The parent's
fresh re-review reviews the child's work; children need no independent review.

Filing is idempotent: at most one open child per parent per kind (keyed by the
body marker). Children auto-close when the parent merges or closes.

### 5.1 Review findings become children

The review session still has exactly two **native** terminal verdicts
(APPROVE vs REQUEST_CHANGES). Approve may optionally file non-blocking
follow-ups in the same session command:

- **Approve:** native APPROVE + terminal ref, as today. Optional
  `--follow-ups-file` on `autopilot session review-verdict --state APPROVE`
  files zero-or-more **ordinary** issues (not children) with body marker
  `<!-- jinn-autopilot:review-follow-up pr=<N> head=<sha> index=<i> -->`,
  Issue Type `feat|chore|fix|refactor`, and machine triage on the Project
  (Blocked on / Effort / Priority; default Blocked on: Nothing). Cap ≤5 per
  exact head. Filing is
  idempotent on `pr+head+index` and runs before terminal publish. These
  issues never carry `review-finding`/`reconcile` labels or the child
  marker, never appear in `openChildKinds`, and **do not** move the parent
  into BLOCKED-BY-CHILD.
- **Request changes:** native REQUEST_CHANGES (head-bound) + one
  `review-finding` child per round listing all **blocking** findings
  (reviewer may split genuinely independent findings) + release the claim
  + exit.

The REVIEW-FIXING state, the atomic two-ref fix publication, the
redraft-before-fix ordering, and the fix-loop recovery carve-out remain
deleted. The reviewer credential still has no branch-push authority:
reviewers read, verdict, file, and exit.

### 5.2 Integration becomes a ladder

Replaces merge-prep in full. For an approved, CI-green PR the deterministic
merge gate applies the cheapest sufficient actor:

- **Tier 0 — behind, no conflicts:** GitHub update-branch API (append-only
  merge of base into head). No issue, no session. Approval carries over under
  §6.1.
- **Tier 1 — conflicting:** file a `reconcile` child. Its session merges the
  base **into** the branch (never rebase), classifies every conflict before
  editing (§6.2), resolves inside the merge commit, regenerates lockfiles
  canonically, publishes with an ordinary fast-forward push, and closes the
  child with a summary that flags any judgment-call hunks. The parent
  re-enters DELIVERED and receives a **full fresh review with no carry-over**
  — conflict resolutions are new content, and the re-review is their proof.
- **Human** is an overlay, not a tier (§6.3).

No draft flip occurs during reconciliation: nothing mutates destructively,
and the gate cannot merge mid-reconcile (conflicting until the push, then
unapproved).

The MERGE-PREP state, executor/session pair, dedicated cap and credential
lane, expected-head lease publication, range-diff proof, and prep
draft-recovery special case are deleted. The Mechanical/Semantic taxonomy,
never-guess discipline, canonical lockfile regeneration, and
escalate-with-written-reason survive as the reconcile skill's methodology.

## 6. Rules

### 6.1 Append-only, and the one relaxation

**The autopilot never rewrites published history.** The claim CAS's
create-only lease is the sole force-shaped operation; every other publication
is a fast-forward push. Rebase is not a method the autopilot uses (squash
merge at landing makes branch-history purity moot).

Head-bound verdicts remain the universal invalidator, with exactly one
relaxation: after the gate's **own** tier-0 update-branch, it may carry the
existing terminal approval to the new head **iff** it proves the PR's
effective diff (content vs merge base) is byte-identical before and after.
The proof is a local git computation, performed only by the deterministic
gate, never by a session; CI still re-runs on the new head; native
REQUEST_CHANGES and human/CODEOWNER gates are unaffected. A conservative
deployment may disable carry-over and pay re-review instead (config knob).

### 6.2 Taxonomy as routing, not boundary

Mechanical vs Semantic no longer decides *who* resolves a conflict; it routes
*how much capability* the child gets. The filing gate may pre-classify cheaply
(`git merge-tree` conflict census) to set Effort: mechanical-shaped → Low;
semantic-shaped → Medium/High, so the session gathers full context (both
sides' issues, PRs, and design intent) before resolving. Semantic resolutions
are legitimate autonomous work — the code on both sides of the conflict was
written by sessions exercising the same judgment — and their safety comes from
where it always comes from: flagged-hunk summaries plus full independent
re-review, not from refusing to try. The quality ceiling on semantic
reconciliation is set by how well issues capture intent; the confidence rule
below is therefore phrased conservatively.

### 6.3 Human: three doors, one mechanism

The HUMAN overlay (hold label + structured marker comment — the board's
`Blocked on: Human` is paint) is reached only by:

1. **Confidence escalation** — any session that cannot determine the right
   action with confidence. "Hard" is not a reason; "the intent is genuinely
   undeterminable from the record" is.
2. **Policy** — CODEOWNER-sensitive surfaces (DR-2026-06-03). Capability is
   irrelevant; the authority is reserved.
3. **Runaway guard** — N open-or-closed children of one kind on one parent
   without convergence (default N=3) files the hold automatically.

Exit is only by explicit human action.

## 7. Workflow skills

The session-facing skills are part of the lifecycle contract and change with
it. Dispositions:

| Skill | Disposition |
|---|---|
| `implement-issue` | Stages 1–7 of its methodology unchanged. Stage 8 text becomes the three-op finalize (marker → label → undraft); escalation wording moves from board-Human to label+marker. Light touch — the session verbs absorb most of the change. |
| `review-pr` | Rewritten around two terminal outcomes: approve (unchanged), or file the finding child + native REQUEST_CHANGES + release the claim + exit. The fix loop, redraft-before-fix ordering, atomic publication instructions, and the stale-fix recovery entry are removed. The reviewer role is read/judge/file; no branch-mutation instruction may appear in the skill. |
| `merge-prep` | Deleted with its state (§8). |
| `reconcile` (new) | Successor to merge-prep's irreducible core: merge-from-base method, the conflict taxonomy as routing (§6.2), canonical lockfile regeneration, flagged-hunk summary, `child-complete`; escalation only by confidence or policy (§6.3). |
| `fix-child` (new) | implement-issue variant for finding children: work on the parent's branch, append-only checkpoints, no PR of its own, close via `child-complete`. |
| `eng-day` | The observe-mode derivation remains its authoritative lifecycle source (painter lag is harmless to its conclusions). Machine-created children and follow-ups use the same Project triage fields as human work; it gains review findings and pending reconciliations as visible work items in the brief. |
| `merge-batch` | Authority unchanged (human-invoked, same gates); merge-prep and Status-field references cleaned up. |
| `autopilot-runtime` | Mechanics unchanged; verb roster updates only (+`review-findings`, +`child-complete`, −`review-fix-publish`, −`merge-prep-complete`). |

Two normative rules govern how skill changes land:

- **Atomicity with code.** Sessions read skills from their attempt worktree,
  checked out at the claim base — so a skill change and the dispatcher or
  session-verb change it depends on must land in the same change on `next`.
  Superseded code paths stay armed until §10 Stage 5, so an in-flight session
  holding older skill text always completes against code that honors it.
- **Machine-enforced contracts.** The skill-text test suite pins each skill's
  contract: required verbs present, forbidden operations absent (e.g.
  `review-pr` contains no push instruction; `reconcile` never instructs a
  rebase). Every stage that edits a skill updates the pins in the same
  change; the pins are the regression guard for role authority, not just
  prose style.

## 8. What this deletes

States: REVIEW-FIXING, MERGE-PREP. Machinery: all Status
projection/reconciliation and its read-backs, the dominance snapshot,
field-list from every hot path, the atomic two-ref push, the expected-head
lease, range-diff proofs, prep/fix recovery carve-outs, the merge-prep
executor/session/cap/lane, the review session's branch-push authority. The
capability probe drops the atomic-pair and rewrite-shaped proofs, retaining
CAS create/advance and read-back proofs. Deleted code is on the order of
several thousand lines plus their tests.

Retained proven core: branch claim CAS · review ref (simplified lifecycle:
`active → terminal | released | stale`) · head-bound marker-bound verdicts ·
claimless head-pinned merge · the staleness reaper · attempt isolation and
file-based credential handoff.

## 9. Governance deltas

- Amends 2026-07-19 §7 (states), §8.3 (fix loop), §8.4 (merge-prep), §8.6
  (projection), §10 (workflow changes) as described; its §8.2, §8.5, §9
  contracts stand except where they reference deleted states.
- Amends DR-2026-05-20-b for **Status only** (becomes view); triage fields
  remain board-canonical.
- Amends DR-2026-07-16: the merge-prep session concept is subsumed by
  reconcile children; the rule-4 carve-out language follows.
- Strengthens "GitHub Issues are the single SoR for engineering work": review
  findings and integration work become SoR items instead of session-internal
  loops.

## 10. Migration (strangler-fig)

Never delete ahead of live proof. Each stage lands behind the previous one's
canary evidence, on `next`, with the existing v2 machinery still armed until
Stage 5.

1. **Stage 1 — decision paths off the board.** Eligibility stops reading
   Status (facts-only predicate); session finalize drops
   `setProjectStatus`/project read-backs (three-op finalize); escalation
   writes label+marker as authoritative. Status writes continue temporarily
   (harmless) so the view stays fresh pre-painter. Canary: implement →
   deliver on a live contended board with zero project-pending failures.
2. **Stage 2 — children.** Finding-children (review session files, fix
   sessions claim parent branch) and reconcile-children + tier-0
   update-branch in the gate. The old fix-loop and merge-prep paths remain
   armed but idle (children outrank). Canary: full loop including one forced
   conflict and one behind-only PR; verify carry-over proof.
3. **Stage 3 — painter.** Scheduled GitHub Action paints Status + archives;
   autopilot Status writes removed. Canary: board converges within one
   painter period; **read-side budget** per §12 (incremental discovery +
   measured thresholds from #2001), not the pre-#2001 full-snapshot default.
4. **Stage 4 — approval carry-over on** (if Stage 2's proof held), runaway
   guard, child auto-close sweeps.
5. **Stage 5 — deletion.** Remove §8's list; shrink the probe; re-mint
   attestations; spec cleanup. Full suite + one final canary ladder + the
   two-process same-host race re-run.

Rollback at any stage: the previous machinery is still present until Stage 5;
disarm the new path via its config knob.

## 12. Read-side quota (post-#2001)

Single-surface removes **Status as decision authority**; it does not by
itself shrink GraphQL reads. Incremental discovery (#2001, ported onto
`next` after Stage 5 lands) is the read-side complement:

- **Incremental oracle** — `LifecycleSnapshotSource` + `lifecycle-cache`
  hydrate from REST/event cursors; full GraphQL reconciliation runs on a
  schedule (hourly) or when cache is cold/stale, not every active cycle.
- **Targeted prechecks** — `targeted-action-reader` serves claim/review
  gates from narrow REST reads where the snapshot already has authority.
- **Measured bars** (live, post-port; supersedes the Stage 3 planning
  estimate of ≤ ~60 pts/cycle on a full snapshot):
  - idle active cycle: **≤ 2** GraphQL points
  - full reconcile: **≤ 450** points per hour
  - targeted prechecks: **≤ 10** points each

Until #2001 merges, canary hosts pay the full-snapshot cost (~400–2300
pts/cycle on a contended board) regardless of `JINN_AUTOPILOT_ONLY_ISSUES`
scoping on claims.

## 11. Verification

Per stage as above; the terminal bar is the 2026-07-19 §15 ladder re-run on
the new machine: two-observer agreement, same-host two-process race on one
canary, cross-host crash campaign, a full implement → review (finding child) →
reconcile child → merge chain on the live board, and a measured cycle budget
compatible with two concurrent autopilots on one token bucket with ≥5×
headroom.
