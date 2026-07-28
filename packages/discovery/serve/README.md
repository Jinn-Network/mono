# `@jinn-network/record-discovery-serve`

Published-source toolkit for the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §7).

This package implements the serving-plane object set for anyone publishing a signed source:
the records-by-digest layout writer, the RFC-5005-shaped archive pager, source-head
maintenance (re-signing, freshness, the `refreshBy` bound), the well-known discovery
document, unauthenticated debounced pings, and the two v1 location profiles (HTTPS, IPFS).
It performs no filesystem, network, signing, or clock I/O directly; every external effect
arrives through an injected port (`BlobStore`, `Clock`, `DsseSigner`, `PingTransport`).

Its only Jinn dependency is `@jinn-network/record-discovery-protocol`; it never imports a
record-defining package (TEP, Evidence, or profiles) or `client`.

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
