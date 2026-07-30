# @jinn-network/benchmarking-aggregate

Consumer-side aggregation for sealed Jinn benchmarking Matrix records. The package exposes the
versioned method registry, reference statistics, exclusion and verdict-reduction rules, and
production/verification of DSSE-wrapped Report records.

It depends only on `@jinn-network/benchmarking-records` and `@jinn-network/trust-core`; it never
imports the run orchestrator or a concrete execution backend.

## Conformance

Consumers create the real registry with `createMethodRegistry()` and run
`describeMethodRegistryConformance(registry)` from `@jinn-network/benchmarking-testing` in their
Vitest suite. The checked-in consumer entrypoint is
`packages/benchmarking/testing/src/aggregate-conformance.test.ts`.

## Reports

`produceReport()` receives exact canonical Matrix bytes, a registered method, exact-byte
Verdict/Run/Task resolvers, and an injected trust-core `DsseSigner`. It derives lossless
disclosures from the matrices, seals the Report using the records package, and signs the exact
sealed bytes as the DSSE payload.

`verifyReport()` receives the exact DSSE envelope bytes, exact Matrix subject bytes in sealed
order, and an explicit verification `effectiveTime`. It verifies the envelope signer against the
Report author under the benchmarking-report trust scope, binds every referenced byte sequence to
its digest, recomputes results and disclosures, and checks resolved Run comparability and universal
preregistration. The Report has no sealed timestamp, so `effectiveTime` is verifier context only;
it is never inferred from a Report field or callback.

Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
