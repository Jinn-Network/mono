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
