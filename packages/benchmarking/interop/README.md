# @jinn-network/benchmarking-interop

Importers and one-way exporters for the Jinn benchmarking application. Converts SWE-bench /
Inspect Evals rows into sealed Tasks + Benchmark records, and projects Benchmarks / Matrices into
Croissant, Inspect EvalLog, and self-contained static bundles.

Depends on `@jinn-network/benchmarking-records`, `@jinn-network/task-execution-profiles`, and
`@jinn-network/task-execution-protocol` only. Never imports `@jinn-network/benchmarking-run`.

Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
