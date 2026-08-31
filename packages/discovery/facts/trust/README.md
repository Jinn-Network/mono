# `@jinn-network/record-discovery-facts-trust`

Facts-profile documents and record-fact recompute functions for the three Trust Layer record
kinds (key-binding statement, authorization, trust policy) — one of the `discovery/facts/*`
leaves the Record Discovery Protocol v1 design defers per-record-kind specifics to
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §12).

Each facts profile is a sealed, digest-pinned declarative document (owned shape:
`@jinn-network/record-discovery-protocol`'s `FactsProfileDocument`) labeling every field
record-fact vs substrate-fact, naming reference-bearing fields, and declaring CloudEvents
attribute liftings.

The per-kind record-fact `RecordFactRecompute` functions (`src/recompute.ts`) recompute every
record fact from the record's own sealed DSSE envelope bytes via `@jinn-network/trust-core`'s
structural `validateKeyBinding` / `validateAuthorization` / `validateTrustPolicy` — never from
a supplied projection.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-record-discovery.md` (Task 23) for the implementation
plan.

## Join edges

Facts profiles must declare their kind's complete outbound-reference set (record-discovery
design §12, amendment 2026-08-28). Only `trust-policy.v1` was already complete: `predecessor`
really is its whole outbound set. The other two were not, and the v2 revisions close them.

`key-binding.v2` adds `ceremony.digest` — the ceremony evidence the binding rests on, required
on every binding — and `anchorDigests`, one per cited time anchor. `authorization.v2` adds
`proofs`, the parent authorizations this one attenuates, which is the same lineage class as the
`revocation` declared beside it in v1; and `subjectDigests`, the statement's own subjects, each
of which pins bytes by digest. v1 stays frozen and registered.

Ceremony evidence and time anchors are digest-pinned artifacts rather than announceable
records, so reference-bearing here labels the indexing relation and does not promise the target
is retrievable — the same posture the environment leaf documents for its image digest.

Each profile's `referenceBearingFields` is pinned in `profiles.test.ts`. That pin is a
change-detector authored from the same reading of the schema as the profile itself, not an
independent completeness proof; see the design amendment's *What enforces this*.

Every kind's set, across all six leaves, is tabulated together in the design amendment's *Audit
table* (§12).
