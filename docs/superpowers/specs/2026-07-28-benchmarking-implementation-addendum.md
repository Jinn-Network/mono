# Benchmarking implementation addendum

**Status:** informational (not a design change)
**Date:** 2026-07-28 (M8 closeout)
**Scope:** declared impact for the shipped `@jinn-network/benchmarking-*` packages and the `facts/benchmarking` discovery leaf

This addendum records what the benchmarking application tree implements against the design (`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md`) and program rulings §7.135–§7.144. It does **not** claim external conformance, deployment, or tier-4 product readiness.

## Shipped packages and facts leaf

| Package / leaf | Role |
|----------------|------|
| `@jinn-network/benchmarking-records` | Sealed Benchmark / Run / Matrix / Report records, cellKey grammar, canonical sealing |
| `@jinn-network/benchmarking-testing` | Conformance kit (`describeRecordConformance`, `describeAssemblyConformance`, `describeOrderingConformance`, method registry drivers) |
| `@jinn-network/benchmarking-aggregate` | Report production / verification, method registry, deterministic statistics |
| `@jinn-network/benchmarking-run` | Backend-neutral run orchestration: plan, quote, `launchAndWatch`, `assembleMatrix`, `verifyMatrix`, injected ports |
| `@jinn-network/benchmarking-interop` | Croissant import/export seams |
| `@jinn-network/benchmarking-marketplace` | Marketplace venue: anchored close boundary, projector-derived input scope, settled/reported cost, `runOnMarketplace` composition |
| `facts/benchmarking` (record-discovery leaf, when present) | CloudEvents filter attributes for the four benchmarking record kinds |

## Frozen surfaces (design §14.1–§14.10)

- **Protocol identifier:** `https://jinn.network/protocols/benchmarking/1.0` (Addendum 2026-07-28-c)
- **Record-kind URIs:** `https://jinn.network/records/{benchmark,benchmark-run,benchmark-matrix,benchmark-report}/1.0`
- **Assembly procedure:** `jinn.benchmarking.assembly/matrix` @ `1`
- **Outcome vocabulary:** `judged | unjudged | unscorable | expired | invalidated | excluded`
- **Named checks:** cell-correspondence, preregistration-precedes-dispatch (legs a–c), verdict-spec-match, verdict-consistency, evaluator-independence, pinning-observation, comparability, reveal-consistency, judgeability
- **Method URIs:** registered in `@jinn-network/benchmarking-aggregate` method registry (Wilcoxon, permutation, bootstrap, etc.)
- **Marketplace posture:** pinning axes honestly `unverifiable` until #2040/#2041; admission defaults `attested-only`; settled cost joins successful delivery settlement to accounted attempt (today native ETH, revised OLAS per program §7.131)

Pinned identifiers remain on the program gate list (Finding F1); IANA registration of `vnd.jinn.benchmarking.*` is deferred.

## Companion facts amendment (§17.5)

The additive `benchrun` / `benchcell` / `bencharm` fields on Submission/Delivery facts profiles are **not** owned here. They are built by the record-discovery plan's M8 `facts/task-execution` leaf (Addendum 2026-07-28-b). This tree references that amendment and owns CloudEvents filter attributes on the four benchmarking record kinds only.

## SDK supersession (§17.2)

`packages/sdk/src/benchmarking.ts` (`BenchmarkRunV1`, `ConfigV1`, `CellV1`, `BenchMatrixV1`, `BenchPreregistrationV1` — merged #2046) is superseded by the §6–§9 records in `@jinn-network/benchmarking-records`. The SDK module stays until consumers migrate; no consumer migration is owed (nothing ships on those shapes in production).

## #2038 disposition (§17.2, unchanged)

| Issue | Disposition |
|-------|-------------|
| #2039, #2042 | Carry forward |
| #2044 / PR #2219 | Continues on `next` |
| #2040, #2041, #2043, #2045 | Re-homed into the stack program (not re-opened here) |
| #2047–#2054 | Re-derived from design at a future implementation-planning pass (§18.4) |

## Capability-eval v0 (§17.3)

Not superseded; **promoted**. Its statistics seeded `@jinn-network/benchmarking-aggregate` (M3.2); its held-out slate becomes a committed Benchmark. Nothing forces migration.

## Deferred follow-ups (non-blocking)

- IANA registration for `vnd.jinn.benchmarking.*` vendor media types
- Reserved protocol / record-kind URI publication gate before any **external** conformance claim
- Run-pinning enforcement legs (#2040/#2041) to turn marketplace `unverifiable` axes into `match|mismatch` (design §18.3)
- `bradley-terry@1` activation when pairwise-judged benchmarks appear (§9.2)
- Tier-4 products (marketplace benchmarking service, capability-eval gate, skill factory, leaderboards — design §17.4, §19): **OUT of scope** for this tree

## Program cross-reference

Implementation plan: `docs/superpowers/plans/2026-07-28-benchmarking-application.md`
M7 marketplace rulings: Addendum 2026-07-29-p / program §7.135–§7.144
