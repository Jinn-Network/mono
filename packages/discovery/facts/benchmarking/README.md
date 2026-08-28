# `@jinn-network/record-discovery-facts-benchmarking`

Facts-profile documents and record-fact recompute functions for the Benchmarking
Application record kinds (Benchmark, Run, Matrix, legacy/raw Report v1, signed Report v2, and
BenchmarkAccounting) — the discovery facts leaf for
the `benchmarking-records` record-kind tree (`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §11 / §14.8; program §7.128–§7.130).

Each facts profile is a sealed, digest-pinned declarative document labeling every field
record-fact vs substrate-fact, naming reference-bearing fields, and declaring CloudEvents
attribute liftings. Own-record digests recompute via discovery protocol `recordDigest` over
exact received bytes. Reference-bearing digests fail closed through the `ReferencedBytes`
port (fetch → exact rehash → parse expected kind).

Report v1 continues to parse its immutable raw JCS payload. Report v2 instead parses the exact
DSSE envelope with `parseSignedReportRecord`, publishing distinct envelope and payload digests;
structural envelope parsing does not claim signature validity or signer trust. BenchmarkAccounting
facts expose the publisher's declared scope size, registration status, and authority form without
asserting scope completeness or authorization trust.

`scopeStreams` is an ordered array of canonical JSON scalar strings. Array position is the
deterministic stream index; each string preserves the full declared stream, including its source
or substrate profile/authority and exact kind-specific `through` cutoff. The delegate
authorization digest is emitted only after its exact bytes rehash and structurally validate as a
Trust Authorization DSSE record; cryptographic validity and signer trust remain separate checks.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-benchmarking-application.md` (M6) for the implementation
plan. Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.

## Join edges

Facts profiles must declare their kind's complete outbound-reference set (record-discovery
design §12, amendment 2026-08-28). `benchmark.v2` adds the Tasks a benchmark is made of and its
supersession pointer; `matrix.v2` adds the per-cell Task, Submission, Delivery and verdict
digests that make a matrix the join table it already is in substance;
`benchmark-accounting.v2` adds the records and artifacts each cell's dispatches name, so the
closure an accounting record claims is walkable from the feed. Each coexists with v1, whose
bytes stay frozen.

These digests point into other record-kind trees, which this leaf cannot parse, so they are
emitted from the record's own statement rather than through the fail-closed referenced-bytes
path the same-tree digests use. Reference-bearing labels an indexing relation; it does not by
itself promise the target is retrievable.

Audited and unchanged: `run.v1` already declares its one edge, the benchmark — an arm's `pinning`
is a structurally open map, whose keys no profile can declare. `report.v1`/`.v2` already declare
their subject matrices; `reportPayloadDigest` is the record's own payload, which is identity
rather than an edge. An accounting record's `scope.streams[].through.entry` and its registration
boundaries are stream cursors rather than dependencies, and reach the card verbatim inside
`scopeStreams` already.
