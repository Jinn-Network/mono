# `@jinn-network/record-discovery-facts-benchmarking`

Facts-profile documents and record-fact recompute functions for the four Benchmarking
Application record kinds (Benchmark, Run, Matrix, Report) — the discovery facts leaf for
the `benchmarking-records` record-kind tree (`docs/superpowers/specs/2026-07-28-benchmarking-application-design.md` §11 / §14.8; program §7.128–§7.130).

Each facts profile is a sealed, digest-pinned declarative document labeling every field
record-fact vs substrate-fact, naming reference-bearing fields, and declaring CloudEvents
attribute liftings. Own-record digests recompute via discovery protocol `recordDigest` over
exact received bytes. Reference-bearing digests fail closed through the `ReferencedBytes`
port (fetch → exact rehash → parse expected kind).

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
