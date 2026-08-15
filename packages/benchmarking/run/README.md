# @jinn-network/benchmarking-run

Backend-neutral orchestrator for Jinn benchmarking runs: plan a sealed Run, quote expected
cells against backend capabilities, launch/watch cell dispatch over an injected
`TaskExecutionBackend`, and assemble a deterministic Matrix at the close boundary.

Local single-party dispatch uses the 2-arg `submit(taskBytes, submissionBytes)` contract. The
backend mints the Attempt URI; the run reads it back exclusively from
`observe(ack.submission).descriptor.attempt`. Resumption is backend durability only (sealed
Submission digest + `cellIdempotencyKey`) — this package keeps no run journal.

The public run surface declares only the structural quote/dispatch port it consumes. A concrete
`TaskExecutionBackend` satisfies that port, but the package is not a runtime dependency; readers
that install matrix re-verification therefore do not install an execution backend.

Aggregation lives in `@jinn-network/benchmarking-aggregate`. This package never imports it.

Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.
