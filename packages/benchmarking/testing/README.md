# @jinn-network/benchmarking-testing

The conformance kit for the Jinn benchmarking application (design §16). Kits precede
implementations (program §7.6): a product proves it implements the frozen §6–§14 surface by
running the relevant injected driver against the fixtures shipped here.

## Frozen M2 contract

- **`describeRecordConformance()`** verifies record schemas, producer re-sealing, consumer
  digests, and named Benchmark checks.
- **`describeMethodRegistryConformance(registry)`** verifies the complete declarative method
  specification and exact result fixtures for all six v1 reference methods. It also covers
  conflict reporting, paired exclusions, provenance-source clustering, comparability, and the
  registered/non-reference/unavailable Bradley–Terry entry.
- **`describeAssemblyConformance(assemble)`** injects an assembler and requires byte-for-byte
  reproduction of the kit-owned expected Matrix for the 3-task × 2-arm × 2-replicate miniature
  corpus. The corpus includes all six outcomes, replacement lineage, multiple verdicts, and an
  asymmetry flag.
- **`describeExportConformance(exporters)`** injects Jinn Matrix-projection, Croissant, and static-bundle
  exporters and compares each projection with a canonical byte-exact oracle.
- **`describeOrderingConformance(legs?)`** always checks structural Run commitment and the
  kit-owned positive, violation, and non-decision-grade local-order transcript oracles. Future
  run and marketplace implementations can additionally inject their observed legs.

The M4/M5/M7 package invocations are deferred until those consumers exist; their required M2
fixtures, oracles, and drivers are not deferred.

## Layout

- `src/*-conformance.ts`, `src/assembly-types.ts`, and `src/export-types.ts` contain the public
  injected drivers.
- `src/method-types.ts` freezes the declarative `Method`/`MethodRegistry` contract consumed by
  implementations.
- `fixtures/miniature-run/` contains the exact Benchmark, Run, tasks, submissions, deliveries,
  verdicts, evidence, injected assembly scope, and expected Matrix.
- `fixtures/ordering/` and `fixtures/exports/` contain the ordering and export oracles. The
  append-only `exports/eval-log.json` fixture is retained as historical evidence only; its
  manifest erratum points to the honest Jinn-owned Matrix projection that supersedes it.
- `fixtures/methods/` contains method specifications plus compute, conflict, paired, clustering,
  comparability, and availability cases.
- `scripts/generate-method-fixtures.mjs` derives the original closed-form reference-method
  fixtures independently of `benchmarking-aggregate`.
- `scripts/generate-miniature-run.mjs` deterministically materializes the miniature corpus,
  ordering/export oracles, and the strengthened method-contract fixtures.

See `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §16 and
`docs/superpowers/plans/2026-07-28-benchmarking-application.md` M2.

Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
