# @jinn-network/benchmarking-records

Sealed record kinds for the Jinn benchmarking application: **Benchmark**, **Run**, **Matrix**,
and **Report**. Tier 2 of the benchmarking application (design §2, §15) — a backend-neutral
protocol layer with no knowledge of any execution backend, aggregation method, or product.

## What this package is

Four sealed, content-addressed record kinds that together let a skeptical third party verify
"is configuration A better than B" from records alone, without trusting whoever produced them:

- **Benchmark** (§6) — a thin, content-addressed set namer: an ordered list of Task digests, a
  reveal policy for commit-reveal benchmarks, and the record-level checks that make a benchmark
  judgeable (`benchmark-item-distinctness`, `benchmark-judgeability`, `benchmark-comparability`,
  the §6.2 versioning classifier, and `reveal-consistency` for committed benchmarks).
- **Run** (§7) — the pre-registration: a sealed declaration of one execution campaign (arms,
  replicates, policy, the mandatory `closeAt` stopping rule) sealed before any cell executes.
  Owns the `cellKey` grammar, the expected-cell-set enumeration, and the `submission.annotations`
  shape a cell dispatch carries.
- **Matrix** (§8) — the completeness claim over the pre-registered expected cell set, assembled
  deterministically at close. Carries the frozen six-value outcome vocabulary
  (`judged | unjudged | unscorable | expired | invalidated | excluded`) and structural
  self-consistency checks. No aggregate of any kind (tenet 3).
- **Report** (§9.1) — the signed interpretation: a method result computed from one or more
  Matrix records, always carrying a `disclosures` block (integrity tiers, pinning, independence,
  completeness, attrition) — a report that hides attrition is malformed.

## Seal once

Every record kind is sealed via the raw RFC 8785 JCS serialization under I-JSON (no indentation,
no trailing newline; numbers must be exact I-JSON integers — fractional quantities are always
strings). The sealed bytes are the record forever; verifiers hash the exact received bytes and
never re-canonicalize. See `src/order.ts`, `src/canonical.ts`, `src/sealing.ts`, and
`src/equivalence.test.ts` (the cross-tree byte-equality leg against
`@jinn-network/task-execution-protocol`).

## Dependency posture

Tier 2, protocol-layer only: this package imports `@jinn-network/task-execution-protocol` and
nothing else Jinn-specific — no evidence package, no discovery package, and (critically) no
marketplace package. See `.github/scripts/benchmarking-source-boundaries.test.mjs`.

## Pointers

- Design: `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §6-§9.
- Plan: `docs/superpowers/plans/2026-07-28-benchmarking-application.md` (M1), including
  Addendum 2026-07-28-b (the `submission.annotations.{run,cellKey,armId}` wire shape) and
  Addendum 2026-07-28-c (the `protocol` field is the https URL form).
- Declared-impact addendum: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
