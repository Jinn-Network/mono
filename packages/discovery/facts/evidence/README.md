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

### These three profiles are not yet complete

Stated rather than left for the next reader to rediscover. This package's own
`ResourceDescriptorSchema` (`packages/evidence/protocol/src/schemas.ts`) makes `digest`
**required** and `uri`/`content` the optional members, so the amendment's §6.4 carve-out — a
descriptor satisfiable by a location alone — reaches none of these descriptors. They are edges
by the rule, and they are not declared:

| Kind | Undeclared outbound references |
|---|---|
| `result-evaluation.v3` | `predicate.evaluationSpecification`, `predicate.evaluationMethod`, `predicate.evidence[]` |
| `execution-verification.v2` | `predicate.verificationMethod`, `predicate.verificationPolicy`, `predicate.checks[].evidence[]` |
| `execution-evidence.v3` | the runtime entity's `hasPart[]` components |

The blocker is the catalog projection, not the rule. These recompute functions read the record
through `validateAndProjectEvidenceRecord`, and the frozen projections in
`packages/evidence/discovery/src/catalog/types.ts` do not carry these fields, so declaring the
edges means widening `CatalogRecordProjection` — a change in another package with its own
consumers. `supersedes` and `disputes` are the same `z.array(ResourceDescriptorSchema)` class
and were declarable only because the projection already exposed them.

Closing this is a follow-up. Until then these three profiles declare a *subset* of their kind's
outbound set, and a reader should not take their `profiles.test.ts` pins as a completeness
claim.

Each profile's `referenceBearingFields` is pinned in `profiles.test.ts`. That pin is a
change-detector authored from the same reading of the schema as the profile itself, not an
independent completeness proof; see the design amendment's *What enforces this*.
