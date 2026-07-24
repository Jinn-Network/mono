# Single-Surface Lifecycle — Implementation Plan

Executes `docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md`.
Five stages, strangler-fig: every stage lands on `next` behind the previous
stage's live canary proof; the superseded machinery stays armed until Stage 5.
All work in `packages/autopilot` unless noted. Each stage is a separate PR
train; `yarn typecheck && yarn vitest run` green is the local gate (the
package is not covered by repo CI).

Conventions used throughout:

- **Child marker** (issue body): `<!-- jinn-autopilot:child pr=<N> kind=<review-finding|reconcile> -->`
- **Hold authority** (machine-written): PR label `review:needs-human`; issue
  label `autopilot:human`; plus the existing structured marker comment. Board
  `Blocked on: Human` remains respected as *human* intent (read-only) and
  painted as view.
- **Machine triage**: Project Blocked on / Effort / Priority on all
  machine-created issues (children and follow-ups). Kind labels on children
  (`review-finding`, `reconcile`, `ci-failure`) are flat tags only.

---

## Stage 1 — decisions off the board

Goal: no decision path reads Project Status; session finalize is three
PR-surface ops; label+marker becomes hold authority. The controller's
existing Status writes are *kept* for now (they become the interim view
painter); only reads-for-decisions and session-side writes go.

### Code

1. **Eligibility predicate** — `src/lifecycle/controller.ts`,
   `src/lifecycle/lifecycle.ts`, `src/lifecycle/snapshot.ts`:
   - Replace the `Status === 'Todo'` gate with the facts predicate:
     issue open ∧ type set ∧ triage present ∧ no hold ∧ **no claim branch ∧
     no open PR** (both already in the snapshot).
   - Hold check = `autopilot:human` label ∨ board `Blocked on: Human`
     (intent) ∨ structured marker. Status value becomes non-load-bearing
     everywhere in derivation; keep it in the snapshot for the painter.
   - Eligibility reasons re-worded (they name Project status today).
2. **Three-op finalize** — `src/lifecycle/implementation-session.ts`,
   `implementation-session-production.ts`:
   - `ensureCompletionProjection` becomes: summary marker → `engine:review`
     label → undraft → complete. Delete the `setProjectStatus('In Review')`
     block, `readProjectStatus`, `fetchProjectSnapshot`, and the
     `ensureFieldIds` dependency from the session hot path entirely.
   - `requireNoHumanHold` reads PR labels + marker comments only.
3. **Escalation authority** — `active-runtime-production.ts` escalate paths
   and `stuck/orphan` classification in `controller.ts`: decisions key on
   label+marker; the `set-project-status: Human` write stays as paint.
4. **Reviewer/merge-prep session ports** — same project-read removals as (2)
   where they gate decisions (`review-session*`, `merge-prep-session*` keep
   working unchanged otherwise; they are deleted wholesale in Stage 5).
5. **Skill text** — `implement-issue`: Stage-8 finalize description becomes
   the three-op sequence; escalation wording moves to label+marker. Skill
   pins in `workflow-skills-v2.test.ts` updated in the same change.

### Tests

- Finalize event-order test: `summary → label → undraft`, plus a global
  fake-port assertion that finalize performs **zero** Project API calls
  (same pattern as the ≤1-world-snapshot writer test).
- Eligibility matrix: Status=`In Progress` but no branch/PR → **eligible**
  (new semantics, named test); hold label blocks; board Human-intent blocks;
  claim-branch presence blocks regardless of Status.
- Escalation: label+marker written first, decision paths read them.

### Canary bar

One implement→deliver on the live contended board: zero `pending: project`
outcomes, finalize converges in one `implementation-complete` call while a
foreign writer is active; measured cycle cost recorded (expect the session's
Project reads and field-list to vanish from the trace).

### Rollback

Single revert; no data migration, no protocol change.

---

## Stage 2 — children

Goal: findings and conflicts become child issues; tier-0 update-branch; the
old fix-loop and merge-prep paths stay armed but become unreachable (children
outrank and pre-empt them).

### Code

1. **Child library** — new `src/lifecycle/child-issues.ts`:
   `fileChildIssue({parentPr, kind, title, body, effort, priority})` —
   idempotent (search open issues for the child marker; no-op if present),
   creates via REST with type `fix` (GraphQL `updateIssue` for Issue Type),
   kind label + child marker in body, then Project triage (Blocked on /
   Effort / Priority).
   `findOpenChildren(parentPr)`, `closeChildrenFor(parentPr)`.
2. **Review terminal outcomes** — `review-session.ts` /
   `review-session-production.ts` + `src/cli/session.ts`:
   - New session verb `review-findings --file <path>`: files the finding
     child (reviewer credential keeps issue-create authority), then the
     existing RC verdict publication, then releases the claim. Session skill
     (`.claude/skills/review-pr/SKILL.md`) rewritten: two terminal outcomes,
     no fixes, no branch pushes.
   - The `review-fix-publish` verb and atomic-pair path remain in code
     (Stage 5 deletes) but the skill no longer invokes them.
3. **Fix-child claims on the parent branch** —
   `implementation-executor.ts`: claim path accepts a `targetBranch`
   override resolved from the child marker (phase `fix`); the child's
   attempt worktree checks out the parent head. New session verb
   `child-complete`: verifies the pushed parent head contains checkpoints
   trailer-referencing the child, closes the child with a linking comment.
   New skill `.claude/skills/fix-child/SKILL.md` (implement-issue variant:
   work on the parent branch, append-only, no PR, close via verb).
4. **Integration ladder in the gate** — `merge-executor.ts` /
   `merge-executor-production.ts`:
   - approved + CI green + `behind` + mergeable → REST
     `PUT /pulls/{n}/update-branch` (tier 0), no session.
   - approved + `conflicting` → `fileChildIssue(kind: 'reconcile')` with a
     `git merge-tree` conflict census setting `effort:*` (routing per spec
     §6.2).
   - **Approval carry-over** (behind `JINN_AUTOPILOT_CARRYOVER`, default
     off until Stage 4): after the gate's own update-branch, prove effective
     diff identity (`git diff $(git merge-base base head)..head` byte-equal
     before/after, computed locally on fetched objects), then publish a
     continuation terminal generation on the review ref naming the old
     verdict.
   - Merge-prep entry condition gains `∧ no open reconcile child` — with
     the gate filing children first, the old prep path is armed but idle.
5. **Reconcile skill** — new `.claude/skills/reconcile/SKILL.md`: merge
   `origin/<base>` **into** the branch (never rebase), classify every
   conflict before editing (taxonomy verbatim from today's merge-prep
   skill), resolve all kinds (semantic = gather both sides' issues/PRs/
   intent first), canonical lockfile regeneration, flagged-hunk summary,
   fast-forward publish, `child-complete`. Confidence/CODEOWNER escalation
   via the existing `session human` verb on the **child**.
6. **Scheduler ordering** — `active-scheduler.ts` / `controller.ts`
   candidates: children (marker-bearing issues) order before fresh
   implementation claims.
7. **`eng-day` skill** — reads Project triage for machine-created children
   and follow-ups; surfaces open finding/reconcile children as first-class
   items in the brief.

### Tests

- Child library: idempotent filing, marker parse, label triage, auto-close.
- Review: RC outcome files exactly one child per round and releases the
  claim; no branch push occurs from a review session (global fake
  assertion — the reviewer-credential fencing test).
- Fix-child: claims parent branch with `fix` phase; `child-complete`
  refuses when trailers are absent from the pushed head.
- Gate ladder: behind+clean → update-branch call, no session, no child;
  conflicting → one reconcile child, idempotent across cycles; carry-over
  proof accepts identical effective diffs and rejects any content change
  (both directions tested); prep path not entered while a child is open.
- Scheduler: child outranks fresh claim for the last slot.

### Canary bar

Full live chain: implement → deliver → review files a finding child → child
fixes on the parent branch → RC auto-stales → fresh review approves →
deliberately land a competing PR to force `conflicting` → reconcile child
merges base in and closes → fresh review → tier-0 exercised on a
behind-only PR (carry-over knob on in the canary env, proof logged) → merge.
Two-process race re-run on the child claim (both runners, one child).

### Rollback

Knobs: skills revert to previous text (v1-style loops) + `CARRYOVER` off +
gate child-filing behind `JINN_AUTOPILOT_CHILDREN` (default on after canary).

---

## Stage 3 — the painter

Goal: the autopilot stops writing the board entirely; a scheduled GitHub
Action owns the view.

### Code

1. New `scripts/paint-board.ts` (tsx, no AI): derive per-issue state from
   facts (open PRs + draft flags + labels + merged + hold labels; claim
   branches via the API refs endpoint), map per spec §3, `item-edit` Status
   only on difference; archive stale Done items (relocates the
   board-archive sweep from the cycle); auto-close orphaned children whose
   parent merged/closed.
2. New `.github/workflows/autopilot-board-painter.yml`: cron every 15 min +
   `workflow_dispatch`.
   **Known risk to resolve at implementation:** the default `GITHUB_TOKEN`
   cannot write org-level Projects v2. If confirmed, the workflow uses a
   repo secret PAT (the impl PAT — painter cost is ~10–20 points/run, and
   it replaces reconciliation writes that cost far more) or a GitHub App
   token; the spec's "zero autopilot budget" then means "off the hot path",
   which the verification bar below still enforces.
3. Remove from the cycle: `set-project-status` planning in
   `projection.ts`/`reconciler.ts`, the reconciliation writer's project
   methods, the dominance snapshot in `run-autopilot-v2.ts`, the in-cycle
   board-archive sweep. `field-cache` becomes painter-only.

### Tests

- Painter: state mapping matrix (incl. HUMAN precedence and children),
  no-op when board already matches, archive + orphan-close behavior.
- Cycle: a global fake assertion that active/recover cycles perform zero
  Project mutations.

### Canary bar

Painter converges the live board within one period after a full canary
chain; measured active-cycle budget per spec §12 (idle ≤ 2 pts; full
reconcile ≤ 450 pts/hr; targeted prechecks ≤ 10 pts) with zero Project
writes in the instrumented trace. Pre-#2001 full-snapshot cycles on a
contended board remain ~400–2300 pts regardless of claim scoping.

### Rollback

Disable the workflow; re-enable the reconciler's status planning (kept
revertable until Stage 5).

---

## Stage 4 — hardening on

- `JINN_AUTOPILOT_CARRYOVER` default on (Stage 2 proof held).
- Runaway guard: `fileChildIssue` counts prior children of the kind on the
  parent (open **or** closed-unmerged); the Nth (default 3) files the hold
  instead and labels the parent.
- Child auto-close sweep wired into the painter run.
- Budget instrumentation: per-cycle points-spent line in the cycle report
  (read `rateLimit.remaining` at cycle start/end) so regressions are visible
  in logs, not rediscovered by outage.

Canary bar: forced runaway (a child that cannot converge) parks the parent
for a human within N rounds; two long-running autopilots at 10-minute
cadence for ≥3 hours on the live board, combined budget steady-state ≤
1,000 points/hour.

---

## Stage 5 — deletion and closure

Only after Stages 1–4 bars are met live.

1. Delete: `merge-prep-executor*`, `merge-prep-session*`, their cap/lane/
   credential slot and skill; the review fix-publish path and atomic-pair
   publication in `git-protocol.ts`; `expected-head lease` publication;
   range-diff proof machinery; `set-project-status`/project methods and
   their planners; dominance snapshot; per-state recovery carve-outs; the
   now-dead tests (est. several thousand lines net-negative).
2. Capability probe: drop atomic-pair and rewrite-shaped proofs; bump
   attestation version; re-mint attestations (runbook §7 re-run).
3. Docs: spec status → adopted; amend the 2026-07-19 doc's superseded
   sections with pointers; handbook rule-4 carve-out + DR-2026-07-16
   amendment note + DR-2026-05-20-b Status note; update the cutover
   runbook.
4. Terminal verification: full 2026-07-19 §15 ladder on the new machine —
   two-observer agreement, same-host two-process race, cross-host crash
   campaign with reap-and-resume, the full child-loop chain, and the
   two-autopilot budget soak from Stage 4 repeated post-deletion.

---

## Workflow skills across the stages

Skills are lifecycle contract, not documentation (spec §7). Summary of where
each one changes, and the pin that enforces it:

| Skill | Stage | Change | Enforcing pin |
|---|---|---|---|
| `implement-issue` | 1 | three-op finalize text; label+marker escalation | finalize verbs present; no project-status instruction |
| `review-pr` | 2 | rewritten: approve ∨ file-child+RC+release | `review-findings` present; **no push/fix instruction anywhere** |
| `fix-child` (new) | 2 | parent-branch implement variant | `child-complete` present; no `gh pr create` |
| `reconcile` (new) | 2 | merge-from-base, taxonomy-as-routing | never instructs rebase-as-method; `child-complete` present |
| `eng-day` | 2 | label-triage awareness; children in the brief | label fallback documented |
| `merge-prep` | 5 | deleted | pin removed with the path |
| `merge-batch` | 5 | reference cleanup only | unchanged authority assertions |
| `autopilot-runtime` refs | 2, 5 | verb roster updates | verb list matches `session.ts` |

Two rules from spec §7 bind every stage PR:

- **Skill + verb + dispatcher land atomically** on `next` — sessions read
  skills from worktrees at the claim base, and the #1883 interim taught us
  what decoupled contracts do. Superseded code paths stay armed until Stage
  5 so in-flight sessions on older text always complete.
- **Pins update in the same change** — the skill-text tests are the
  authority-regression guard (a reviewer that can push, or a reconciler
  that rebases, must fail CI locally before it can fail live).

Operational prerequisite (independent of this plan, already outstanding):
the operator-local `supervise.sh` still launches the legacy entry point and
must move to the v2 invocation before any long-running deployment.

## Sequencing, sizing, and ownership

| Stage | Est. size | Executor tasks | Live proof cost |
|---|---|---|---|
| 1 | ~600 LOC delta | 2 (predicate+finalize, escalation) | 1 canary |
| 2 | ~1,500 LOC | 4 (child lib+verbs, review outcome, gate ladder, skills) | 2 canaries + race |
| 3 | ~500 LOC | 2 (painter, cycle removals) | 1 canary + soak start |
| 4 | ~300 LOC | 1 | runaway canary + 3h soak |
| 5 | net-negative | 2 (deletions, probe+docs) | full ladder |

Coordinator verifies every executor diff, runs the full suite, commits
per-scope, and drives each canary personally (the 2026-07-20/21 campaign
protocol: disposable `docs`-type canary issues, `JINN_AUTOPILOT_ONLY_ISSUES`
scoping, instrumented budget reads, per-stage evidence in the PR thread).

Open items deliberately deferred to Stage 5 review: terminal review-ref
pruning policy; painter token choice (GITHUB_TOKEN vs PAT vs App — decide on
measured painter cost); whether `marketplace-route` (a separate mode) adopts
the child-issue conventions.
