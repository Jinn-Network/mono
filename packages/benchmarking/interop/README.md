# @jinn-network/benchmarking-interop

Importers and one-way exporters for the Jinn benchmarking application. Converts SWE-bench rows
into sealed Tasks + Benchmark records, and projects Benchmarks / Matrices into Croissant, a
Jinn-owned Matrix projection, and self-contained static bundles.

`exportMatrixProjection` is not an Inspect EvalLog. Native Inspect logs must be produced and read
through supported Inspect APIs by a Tier 4 runtime adapter; this package deliberately has no
Python or Inspect dependency.

Depends on `@jinn-network/benchmarking-records`, `@jinn-network/task-execution-profiles`, and
`@jinn-network/task-execution-protocol` only. Never imports `@jinn-network/benchmarking-run`.

Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
