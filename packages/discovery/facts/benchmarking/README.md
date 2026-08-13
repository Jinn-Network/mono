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
