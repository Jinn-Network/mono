# @jinn-network/benchmarking-aggregate

Consumer-side aggregation for sealed Jinn benchmarking Matrix records. The package exposes the
versioned method registry, reference statistics, exclusion and verdict-reduction rules, and
production/verification of DSSE-wrapped Report records.

It depends only on `@jinn-network/benchmarking-records` and `@jinn-network/trust-core`; it never
imports the run orchestrator or a concrete execution backend.

## Conformance

Consumers create the real registry with `createMethodRegistry()` and run
`describeMethodRegistryConformance(registry)` from `@jinn-network/benchmarking-testing` in their
Vitest suite. This package runs that driver itself in `src/method-conformance.test.ts`.

## Reports

`produceReport()` receives subject matrices, a registered method, verdict-resolution ports, and an
injected trust-core `DsseSigner`. It derives disclosures from the matrices, seals the Report using
the records package, and signs the exact sealed bytes as the DSSE payload. `verifyReport()` binds
the supplied matrices to the Report's sealed subject digests, recomputes results and disclosures,
and enforces benchmark comparability from the registered method declaration.
