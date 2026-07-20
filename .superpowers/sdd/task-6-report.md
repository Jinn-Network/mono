# Task 6 Report — Active Runtime, Merge Preparation, and Gated Merge

## Status

DONE

Commit: recorded in the Task 6 handoff after commit creation.

## Delivered scope

- Added exact-head merge-prep acquisition, stale recovery, detached attempts,
  selected-identity publication, and a session protocol that publishes through
  an exact branch lease and makes the PR ready last.
- Added a claimless merge executor that re-reads every gate, binds the GitHub
  squash merge request to the exact PR head, respects native review/CI/
  CODEOWNERS/branch-protection gates, and reconciles Project `Done` only after
  an exact merged readback.
- Added the production reconciliation writer and completed the production
  implementation port. Ambiguous mutations are accepted only after exact
  readback; head-pinned inverse mutations stop on Human authority.
- Added local active scheduling with independent per-phase caps, local
  credential lanes, implementation priority for a single identity, and
  GitHub-visible pipeline backpressure that suppresses implementation only.
- Wired explicit `autopilot:v2 --mode active`, usable `recover`, inert
  default `observe`, canonical selected-token HTTPS publication, unique runner
  IDs, configured Claude/Hermes parity, structured action events, and detached
  child tracking.
- Preserved GitHub-only coordination. Stale implementation returns to `Todo`;
  takeover is an ordinary new exact branch claim against the preserved draft
  PR branch. Stale review-fix and merge-prep resume through their ordinary
  claim protocols.
- Kept local cleanup disabled by default. It is available only behind the
  strict `JINN_AUTOPILOT_CLEANUP_ENABLED=true` rollout flag and remains
  same-host, exact-attempt, and fail-closed.

## Safety closure

- Production review CODEOWNERS policy is read from the PR's exact current base
  commit on GitHub, never from a runner checkout.
- Reconciliation passes expected heads through to production mutation
  boundaries and never moves a Human-held Project item back into automation.
- Implementation Project acquisition stops if a Human status or blocker
  arrives.
- Merge compares the PR head against the exact base OID used for CODEOWNERS
  classification.
- Merge-prep classifies a prepared result as mechanical only when `git
  range-diff` proves every rebased patch equivalent. Changed, missing, or
  unparsable evidence remains unproven and must be escalated rather than
  guessed.
- Credential overlays override per-call environments, blank ambient GitHub
  secrets and SSH/config escape hatches, and preserve reviewer/author
  separation.

## Deliberately weakened guarantees

- Mechanical merge-prep completeness is conservative: some genuinely
  mechanical conflict resolutions may be sent to Human when patch equivalence
  cannot be proven. Safety is retained; automation coverage is weaker.
- Remote atomic-push support is enforced by the atomic publication operation
  itself. An unsupported remote fails before a partial fix publication rather
  than being inferred from a shared runner capability signal.
- Cleanup is opt-in for rollout. Recoverable local artifacts may accumulate
  until an operator enables or performs exact safe cleanup.
- No live GitHub canary, active run, deployment, remote configuration change,
  or upstream Hermes change was performed in this task.

## Verification

- `yarn vitest run test/lifecycle
  test/dispatcher/coordinator-session.test.ts` — 32 files, 338 tests passed.
- `yarn typecheck` — passed.
- `yarn test` — 103 files, 1,064 tests passed.
- `git diff --check` — passed.

## Self-review

- `observe`, `recover`, and `active` have distinct authority; only explicit
  active mode can create claims, spawn children, or request merge.
- A recovery or ref/head-changing projection blocks new claims from the stale
  cycle snapshot.
- Claims, real progress, inferred liveness, and recovery remain separate;
  comments, CI, Project edits, and claim metadata do not refresh the two-hour
  real-progress clock.
- No shared capacity, license, PID, worktree, or process signal participates in
  cross-runner ownership.
- Claim losers and ambiguous outcomes do not spawn children. Missing worktrees
  never prove remote abandonment.
- Human, CODEOWNER, CI, native review, and merge gates fail closed and are not
  bypassed.
