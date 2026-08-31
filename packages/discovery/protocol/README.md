# `@jinn-network/record-discovery-protocol`

I/O-free reference implementation of the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`).

This package is kind-agnostic: it authors the two bespoke sealed objects the protocol
defines — the Announcement Entry and the Source Head — plus the hash-chain rules, the
named verification procedures, the facts-profile contract, the record-kind URI grammar, and
the CloudEvents envelope mappings for the subscribe plane. It performs no filesystem,
network, key-resolution, blob, or clock I/O; every external effect a verification procedure
needs (fetching record/entry bytes, resolving keys, checking freshness, persisting a
high-water mark) arrives through an injected port.

Its only Jinn dependency is `@jinn-network/trust-core` (types and the key-binding/freshness
surface consulted by the verification-procedure ports); it never imports a record-defining
package (TEP, Evidence, or profiles).

## Facts profiles must carry their kind's join edges

A profile's reference-bearing set must be **complete**: every field of the record's own sealed
bytes that pins another sealed record or content-addressed artifact by digest is declared and
marked `referenceBearing`. An index serves join from cards alone, so an omitted edge makes that
join unanswerable from the feed. The rule, what it excludes, its one stated limit, and why
`facts-consistency` is not its enforcement are in the design's §12 amendment 2026-08-28 — read
it before authoring or revising a profile.

`referenceBearingFields` reports what a profile declares. Whether that set is complete is a
question about the record kind, so each `discovery/facts/*` leaf pins its own answer in tests.
Those pins are change-detectors, not completeness proofs: pin and profile are authored together
from one reading of the defining schema, so a missed edge is missed by both. Nothing here
derives the outbound set from the schema — a reviewer re-checking the pin against the schema is
the check.

## Development

Use Node 22 and Yarn 4.13.0:

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn pack:smoke
```

See `docs/superpowers/plans/2026-07-28-record-discovery.md` for the implementation plan.
