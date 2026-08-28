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

Stated rather than left for the next reader to rediscover, and recorded as a known exception in
the design amendment itself (§12, *Known exceptions at adoption*) so a reader who meets the MUST
before this file learns of it there. This package's own `ResourceDescriptorSchema`
(`packages/evidence/protocol/src/schemas.ts`) makes `digest` **required** and `uri`/`content` the
optional members, so the amendment's §6.4 carve-out — a descriptor satisfiable by a location
alone — reaches none of these descriptors. They are edges by the rule, and they are not declared:

| Kind | Undeclared outbound references |
|---|---|
| `result-evaluation.v3` | `predicate.evaluationSpecification`, `predicate.evaluationMethod`, `predicate.evidence[]` |
| `execution-verification.v2` | `predicate.verificationMethod`, `predicate.verificationPolicy`, `predicate.checks[].evidence[]` |
| `execution-evidence.v3` | the runtime entity's `hasPart[]` components; the execution's input artifacts; its derivation lineage |

The last two on that third row are the ones a reader is most likely to assume are covered,
because the profile does declare `taskDigest` and the record does state them:

- **Input artifacts.** `execution.object[]` resolves to the Task plus the execution's inputs
  (`packages/evidence/protocol/src/execution.ts`, `object` cardinality check), of which exactly
  one is the `prov:Plan`. Only that Plan becomes `taskDigest`. So `referrers(<input digest>)` —
  "which executions consumed this repository snapshot", the query behind a shared-input
  contamination sweep — answers empty and complete-looking for every `execution-evidence` card.
- **Derivation lineage.** `prov:wasDerivedFrom` and the derivation activity's `instrument`
  (same file, `validateDerivations`) are how a publicly derived crate pins its private source and
  its scrub policy in its own sealed bytes. This is the same "dependencies and lineage" class the
  v3/v2 revisions added `supersedes` and `disputes` for on the sibling kinds, and without it
  "which public crates were derived under scrub policy X" — the re-audit query after a policy
  defect — is unanswerable.

**What blocks each, precisely.** The blocker is the *emission*, not the rule and not the profile
document. These recompute functions read the record through `validateAndProjectEvidenceRecord`,
and the frozen projections in `packages/evidence/discovery/src/catalog/types.ts` carry none of
these fields: `ExecutionEvidenceProjection` exposes `task` as the single Plan with no input list
and no derivation lineage, and no projection exposes a predicate block's references or a runtime
entity's components. `supersedes` and `disputes` are the same
`z.array(ResourceDescriptorSchema)` class and were declarable only because the projection already
exposed them.

A profile document is JSON and could name these fields today — §12 puts the rule on the profile
document and explicitly declines the stronger card-carries-every-edge rule, so a declared field
no recompute yet emits would break nothing. This leaf does not, deliberately: its declared set
and its emitted set are kept in step, so `profiles.test.ts` reads as one audited list rather than
as two — some fields backed by an emission, some promises. That choice is what makes these three
profiles an exception to the MUST rather than a conformance detail, which is why it is written
down in both places instead of only here.

Closing this is a follow-up: widen `CatalogRecordProjection` — a change in another package with
its own consumers — then declare and emit together. Until then these three profiles declare a
*subset* of their kind's outbound set, and a reader should not take their `profiles.test.ts`
pins as a completeness claim.

Each profile's `referenceBearingFields` is pinned in `profiles.test.ts`. That pin is a
change-detector authored from the same reading of the schema as the profile itself, not an
independent completeness proof; see the design amendment's *What enforces this*.
