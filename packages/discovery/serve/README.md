# `@jinn-network/record-discovery-serve`

Published-source toolkit for the Jinn Record Discovery Protocol v1
(`docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` §7).

This package implements the serving-plane object set for anyone publishing a signed source:
the records-by-digest layout writer, the RFC-5005-shaped archive pager, source-head
maintenance (re-signing, freshness, the `refreshBy` bound), the well-known discovery
document, unauthenticated debounced pings, the two v1 location profiles (HTTPS, IPFS),
and a durable signed-source append transaction.

It performs no filesystem, network, signing, or clock I/O directly; every external effect
arrives through an injected port (`BlobStore`, `ReadableImmutableBlobStore`, `Clock`,
`DsseSigner`, `SourceStateStore`, `SourceAppendIntentStore`, `PingTransport`). The source
writer receives the exact announcement timestamp from its caller and never loads keys or
chooses publication policy.

## Durable source writer

`createDurableSourceWriter` is the reusable crash-recovery state machine for a signed
Record Discovery source. It owns only these invariants:

- one `(agent, source name)` and signer-key binding per durable state;
- source-wide `announcementId` idempotency, with a canonical input fingerprint and an
  explicit conflict for different input under the same ID;
- a gap-free sequence and exact `previous` entry link;
- exact records at digest-derived immutable paths;
- one immutable signed archive page followed by the mutable signed Source Head;
- a CAS append intent containing the frozen signed page/head bytes, so recovery never
  re-signs or changes already-decided public bytes;
- separate CAS ports for the append intent and committed source state.

The injected immutable store must atomically create-or-confirm exact bytes. The state and
intent stores must implement opaque-revision compare-and-swap. A host may crash after the
record write, intent claim, page write, head write, or state commit; `recover()` either
finishes the same intent or fails closed on conflicting durable/public state. Immutable
record/page orphans are safe and may be reused by an exact retry.

The writer does not own filesystem leases, HTTP serving, source selection, evidence
translation, or product-specific announcement construction. Those remain host adapters.

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
