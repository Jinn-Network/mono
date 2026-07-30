# `@jinn-network/record-discovery-client`

Consumer runtime for the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md`).

This package implements the consumer side of the protocol: chain-walk sync (cold sync to
genesis on first adoption, high-water-mark sync thereafter), a persistent high-water-mark
store port, the §8 query client (`DiscoveryQueryService`, implemented — not redefined, the
interface is owned by `record-discovery-protocol`), the §9 subscribe client (the five-case
cursor contract, the announcement dedupe key, and the two normative relay cross-checks), and
the verification driver that wires trust-core's key-binding resolution into the protocol's
named verification procedures. It performs no filesystem, network, or clock I/O directly;
every external effect arrives through an injected port (`Transport`, `StreamTransport`,
`HighWaterMarkStore`, `Clock`).

Its Jinn dependencies are `@jinn-network/record-discovery-protocol` and
`@jinn-network/trust-core`. It never imports a `facts/*` leaf: the declarative facts-profile
documents and the imperative record-fact recompute functions those leaves export reach this
package only through two types-only registry ports (`FactsProfileRegistry`,
`FactsRecompute`) that the host assembles and injects at runtime.

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
