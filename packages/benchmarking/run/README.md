# @jinn-network/benchmarking-run

Backend-neutral orchestrator for Jinn benchmarking runs: plan a sealed Run, quote expected
cells against backend capabilities, launch/watch cell dispatch over an injected
`TaskExecutionBackend`, and assemble a deterministic Matrix at the close boundary.

Local single-party dispatch uses the 2-arg `submit(taskBytes, submissionBytes)` contract. The
backend mints the Attempt URI; the run reads it back exclusively from
`observe(ack.submission).descriptor.attempt`. Resumption is backend durability only (sealed
Submission digest + `cellIdempotencyKey`) — this package keeps no run journal.

Aggregation lives in `@jinn-network/benchmarking-aggregate`. This package never imports it.
