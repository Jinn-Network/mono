# Benchmark Product — Session Handoff (2026-08-07)

The 2026-08-05/06 implementation session hit its API usage limit mid-M2/M3.
This document is the authoritative state snapshot for the successor session.
The ledger of record remains
`2026-08-05-standalone-benchmarking-product-program.md` (same directory);
read it FIRST and keep appending to it.

## Exact state at interruption

- Session branch `claude/standalone-benchmarking-impl-280802`, head
  `bc0868d62` ("ledger — BP-21 integrated"), worktree clean.
- **M0 COMPLETE, M1 COMPLETE** (evidence:
  `2026-08-06-benchmark-product-m1-evidence.md`), **M2 2/3**: BP-20 and
  BP-21 integrated; 538/538 tests at head.
- **BP-22 (cancellation + infra accounting) INTERRUPTED mid-implementation**:
  worktree `/Users/adrianobradley/life's-work/jinn-mono_worktrees/bench-bp22`
  (branch `bench/bp22-cancellation`, base `bc0868d62`), 21 uncommitted
  changed files (run-cancel operations underway). NOT battery-verified, NOT
  reviewed, NOT committed. Its packet contract is reproduced in the ledger
  session transcript; re-derive from the BP-22 dispatch text in this file's
  "Packet contracts" section below.
- **BP-30 (web skeleton) INTERRUPTED at review dispatch**: worktree
  `.../jinn-mono_worktrees/bench-bp30` (branch `bench/bp30-web-skeleton`,
  base `bc0868d62`), 9 uncommitted changes incl. new
  `packages/benchmark-product/web/` tree; its coordinator's last words:
  "Tree is clean and complete. Dispatching the independent reviewer."
  Deliverables believed complete; independent review NOT run, NOT committed.
- Integrated-packet worktrees pending manual cleanup: bench-bp00, bench-bp01,
  bench-bp10, bench-bp11, bench-bp12, bench-bp13, bench-bp20, bench-bp21.
- **Base drift**: origin/integration/evidence-v1 has advanced ≥23 commits
  past the program baseline `1fb3e78f1`; refresh proposed, NEVER performed
  (needs explicit human approval). Known consequence: fresh worktrees fail
  `generate-architecture.mjs --check` for PRE-EXISTING upstream reasons —
  classify with `git stash -u` before owning any red.

## What remains (milestone spine)

1. **Finish BP-22** (M2 close): resume from the bench-bp22 worktree.
   Inventory the diff, run the battery, complete missing pieces, independent
   sonnet review to PASS, 1–2 commits, integrate, ledger.
2. **Finish BP-30**: run the independent review over the bench-bp30 diff,
   fix findings, commit, integrate AFTER BP-22 (spine priority; resolve
   mechanical conflicts in the CI workflow/guards yourself).
3. **M3**: BP-31+ — wire the web app to the operations library (server-side
   import of @jinn-network/benchmark-product-core; same permissions/
   validation/audit; no second implementation), surfaces for draft/preview/
   quote/lock/launch/monitor/results/report/verify, parity matrix extended
   to GUI actions, browser verification (the repo has Playwright precedents;
   CLAUDE.md testing rules).
4. **M4**: distribution-ready public report bundle + claim assets over the
   existing report/claim/verify machinery (static, self-contained,
   scope-preserving; `exportStaticBundle` in benchmarking-interop is the
   platform seam).
5. **M5**: accessibility pass, security review, docs (quickstart, agent
   interface, limitations, deployment status = none), extraction-readiness
   evidence, final cross-cutting review, FINAL REPORT per the master prompt
   (baseline/mechanics/final-state/product-outcome/milestones/acceptance
   matrix/packet table/architecture/verification/review/blockers/
   merge-readiness caveats).

## Session mechanics to re-establish (preflight, abbreviated)

- Work in `/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/standalone-benchmarking-impl-280802`.
- Verify the charter is still at
  `~/Downloads/2026-08-05-standalone-benchmarking-product-charter-v0.2.md`
  (v0.2). If missing, STOP and report.
- `.claude/settings.local.json` deny-rules hardening already exists there —
  verify, don't recreate.
- Authority unchanged: LOCAL ONLY — no push, no PRs, no issue mutation, no
  publish, no deploy, no canonical-doc edits, no remote side effects.
- Hierarchy: nested packet coordinators worked but REPEATEDLY idled while
  waiting on background children (one hard wedge). Standing fix that worked:
  instruct every subagent to run children SYNCHRONOUSLY
  (`run_in_background: false`), never arm monitors, never stop before the
  packet report; nudge via SendMessage on any idle notification; take over
  final assembly in the master context if wedged (disclose in ledger).
- Portal-dep gotcha (bit us 4×): a red typecheck/test in any worktree is
  usually UNBUILT sibling `dist/`, not a regression. Build order that works
  is recorded in the ledger (BP-11/BP-12 notes) and in
  `.github/workflows/benchmark-product-ci.yml`.
- Independent review is NON-NEGOTIABLE per packet (fresh sonnet reviewer,
  not the author); reviews have caught real defects every time (copied
  platform code, crash-safety ordering, stale-dist evidence, missing crypto
  negative coverage, non-atomic key writes).
- Update the program-plan ledger + commit after every integration.
- TDD for feat packets; integration tests on the REAL local venue for
  anything touching the run path; the in-memory kit backend is for narrow
  unit tests only.

## Authority documents (read in this order)

1. `docs/superpowers/plans/2026-08-05-standalone-benchmarking-product-program.md` (ledger of record)
2. `docs/superpowers/specs/2026-08-05-benchmark-product-design.md` (+ §12 addenda BP-10..BP-21)
3. `docs/superpowers/plans/2026-08-05-benchmark-product-m1-composition-dossier.md`
4. `docs/superpowers/plans/2026-08-06-benchmark-product-m1-evidence.md`
5. `docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md` (extend with M2+ drafts before final report)
6. The charter (outside repo, path above)

## Packet contracts pending

**BP-22 acceptance criteria (unchanged):** (1) real-venue cancel mid-run →
drained, Matrix `runOutcome: "cancelled"`, every expected cell accounted
(undispatched → expired dispatches:0), verifyMatrix ok, results+claim
honest; (2) cancel authority-gated + idempotent (typed); (3) interrupted
cancel resumes as cancel (persisted marker); (4) infra vs task separation:
subprocess-kill / unscorable / expired paths each surface correctly and
never enter score denominators; (5) TDD, battery, guards, parity (cancel
moves from parity exclusions to entries), scope, lexicon.

**BP-30 acceptance criteria (unchanged):** (1) web package battery green
(install/lint/typecheck/test/build); (2) generate-architecture --check
green modulo pre-existing upstream drift (stash-classify); (3) catalog +
family guards green with the new member; (4) four-axis app spec present;
landing page free of Jinn lexicon/visual identity (stack rules Next.js +
shadcn DO apply; Jinn design tokens DO NOT — separate brand); (5) scope
clean, no core edits.
