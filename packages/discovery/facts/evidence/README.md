# `@jinn-network/record-discovery-facts-evidence`

Facts-profile documents and record-fact recompute functions for the three Evidence Protocol
record kinds (Execution Evidence, Result Evaluation, Execution Verification) — one of the
`discovery/facts/*` leaves the Record Discovery Protocol v1 design defers per-record-kind
specifics to (`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §12).

Each facts profile is a sealed, digest-pinned declarative document (owned shape:
`@jinn-network/record-discovery-protocol`'s `FactsProfileDocument`) labeling every field
record-fact vs substrate-fact, naming reference-bearing fields, and declaring CloudEvents
attribute liftings. Evidence-layer record kinds are author/retrospective (Evidence Protocol
§6–§8) and carry no substrate facts.

The per-kind record-fact `RecordFactRecompute` functions (`src/recompute.ts`) recompute every
record fact from the record's own sealed bytes via
`validateAndProjectEvidenceRecord` (`@jinn-network/evidence-discovery/indexer`) — never from a
supplied projection, so a lying source cannot spoof facts-consistency by publishing a matching
projection alongside forged bytes. `CatalogRecordProjection`
(`@jinn-network/evidence-discovery`) is consulted only as the field-shape reference; it is
never accepted as recompute input.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-record-discovery.md` (Task 22) for the implementation
plan.

## Join edges

Facts profiles must declare their kind's complete outbound-reference set (record-discovery
design §12, amendment 2026-08-28). `execution-evidence.v3` adds the native trace the record
pins; `result-evaluation.v3` and `execution-verification.v2` add the supersession and dispute
edges, without which the evaluation lineage an index needs to pick the live verdict is
unreachable from the feed. Every earlier revision stays frozen and registered.
