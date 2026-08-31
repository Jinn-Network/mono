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
digests that make a matrix the join table it already is in substance, plus the accounting
record its assembly-v2 publication extension pins; `run.v2` adds the registration artifacts its
own publication extension pins; and `benchmark-accounting.v2` adds the records and artifacts
each cell's dispatches name, so the closure an accounting record claims is walkable from the
feed. Each coexists with v1, whose bytes stay frozen.

The matrix hop is what enters that closure. Without `accountingDigest` on the matrix card,
`matrix -> accounting -> submissions/deliveries` cannot be walked from cards at all, and the
seven dispatch-level sets below it are unreachable.

A namespaced publication extension is not an open map: both `MatrixPublicationExtensionSchema`
and `RunPublicationExtensionSchema` validate a closed shape, and the defining record schemas
enforce them, so their members are enumerable fields the completeness rule reaches. An arm's
`pinning` is the open map the amendment's limit is about, and stays outside.

These digests point into other record-kind trees, which this leaf cannot parse, so they are
emitted from the record's own statement rather than through the fail-closed referenced-bytes
path the same-tree digests use. Reference-bearing labels an indexing relation; it does not by
itself promise the target is retrievable.

Audited and unchanged: `report.v1`/`.v2` already declare their subject matrices;
`reportPayloadDigest` is the record's own payload, which is identity rather than an edge. An
accounting record's `scope.streams[].through.entry` is a stream cursor rather than a dependency,
and reaches the card verbatim inside `scopeStreams`. Its `publicRegistration` boundaries are
cursors too, and are deliberately *not* carried: `scopeStreams` serializes `scope.streams` only,
and those boundaries are separate fields that reach no card.

Each profile's `referenceBearingFields` is pinned in `profiles.test.ts`. That pin is a
change-detector authored from the same reading of the schema as the profile itself, not an
independent completeness proof; see the design amendment's *What enforces this*.

Every kind's set, across all six leaves, is tabulated together in the design amendment's *Audit
table* (§12).
