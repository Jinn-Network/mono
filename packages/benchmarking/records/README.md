# @jinn-network/benchmarking-records

Sealed record kinds for the Jinn benchmarking application: **Benchmark**, **Run**, **Matrix**,
**Report**, **BenchmarkAccounting**, and the **observation archive**. Tier 2 of the benchmarking application (design §2, §15) — a backend-neutral
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
- **BenchmarkAccounting** (publication profile §7) — the sealed publisher claim over complete
  dispatch/evidence inputs within frozen, authoritative stream cutoffs. It never chooses an
  outcome or carries a score; Matrix remains the terminal outcome account.
- **Observation archive** (publication profile §7.4) — a sealed, deterministic partition of
  accepted TEP observations by CloudEvents `source` and `subject`, with capture cutoff,
  authority designation, retained conflicts, and descriptors for exact signed/native envelopes.

## Benchmark-publication v1

`BENCHMARK_PUBLICATION_EXTENSION`
(`https://spec.jinn.network/extensions/benchmark-publication/v1`) is the common typed extension
key. A Run can carry ordered digest-bearing `registrationArtifacts`; a Matrix assembled with
`jinn.benchmarking.assembly@2.0` must carry the digest-bearing `accounting` descriptor. The
helpers `withRunPublicationExtension` and `withMatrixPublicationExtension` construct these
extensions without taking ownership of adapter artifact formats.

Report v1 remains exactly the legacy raw JCS payload. Signed Report v2 is a separate record kind
whose canonical record identity is the SHA-256 digest of an exact DSSE envelope; use
`parseSignedReportRecord` for that structural boundary. It validates the envelope’s exact producer
encoding and payload type, then calls the unchanged `parseReport` on its exact payload bytes. It
does not claim cryptographic signature validity or signer trust.

## Seal once

Every record kind is sealed via the raw RFC 8785 JCS serialization under I-JSON (no indentation,
no trailing newline; numbers must be exact I-JSON integers — fractional quantities are always
strings). The sealed bytes are the record forever; verifiers hash the exact received bytes and
never re-canonicalize. See `src/order.ts`, `src/canonical.ts`, `src/sealing.ts`, and
`src/equivalence.test.ts` (the cross-tree byte-equality leg against
`@jinn-network/task-execution-protocol`).

## Dependency posture

Tier 2, protocol-layer only: this package imports `@jinn-network/task-execution-protocol` and the
I/O-free `@jinn-network/trust-core` structural DSSE parser. It imports no evidence, discovery, or
marketplace package. See `.github/scripts/benchmarking-source-boundaries.test.mjs`.

## Pointers

- Design: `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §6-§9.
- Plan: `docs/superpowers/plans/2026-07-28-benchmarking-application.md` (M1), including
  Addendum 2026-07-28-b (the `submission.annotations.{run,cellKey,armId}` wire shape) and
  Addendum 2026-07-28-c (the `protocol` field is the https URL form).
- Declared-impact addendum: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
