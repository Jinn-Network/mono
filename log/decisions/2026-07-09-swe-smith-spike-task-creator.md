# DR-2026-07-09 — SWE-smith spike finding (#994)

- **ID:** DR-2026-07-09-a
- **Date:** 2026-07-09
- **Status:** accepted
- **Issue:** [#994](https://github.com/Jinn-Network/mono/issues/994)

## Finding

**Fork the machinery, reject the dataset.**

SWE-smith's value to Jinn is its **transform components** (repo profiles / env build,
procedural mutation, PR mirroring, backtranslation) pointed at **trace-derived targets** —
not adoption of its ~52k-instance HF synthetic pool, which is structurally identical to the
benchmark pool we already post (`nebius/SWE-rebench-leaderboard`).

**Augment `swe-rebench-v2`, not a dedicated SolverNet.** Minted tasks are ordinary
`swe-rebench-v2.v1` tasks fed through the existing admission → post → solve → grade → distill
machine.

## Implementation

- Spec: `spec/2026-07-08-task-creator-v0.md` (v0.3, PR #1482)
- Plan: `docs/superpowers/plans/2026-07-09-task-creator-v0.md`

## Weak-suite anchor

Discrimination check (`validatePoolInstances` + empty known-bad patch) is the operational
definition of weak-suite instances. Re-derive the rate on the local validated pool via
`jinn solver-nets validate-pool-report swe-rebench-v2` after enabling discrimination.
