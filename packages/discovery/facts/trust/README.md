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
design §12, amendment 2026-08-28). These three profiles already did at v1 — a key binding's
`supersedes`, an authorization's `revocation`, a trust policy's `predecessor` are the whole set
— so the audit that produced the other leaves' revisions left this leaf unchanged. Its
`profiles.test.ts` pins that set, which is what keeps the claim true.
