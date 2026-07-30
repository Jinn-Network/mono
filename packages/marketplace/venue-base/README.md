# @jinn-network/marketplace-venue-base

The tier-3 chain-adapter tree for the canonical Base venue: the production plugs — a chunked,
hash-verified log source; a single Safe broadcaster implementing the named Defender-relayer
profile; the claim, settlement and lifecycle writers; the finality and delivery waiters; a
durable posting-intent store; and projector-backed observe — that fill every venue-facing port
the merged stack declares but never implements. Every port takes an injected viem `WalletClient`:
the package holds no keystore, no key-loading code and no key material, ever
(signer-injection only).

See the design: `docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` §6.1.
Implementation plan: `docs/superpowers/plans/2026-07-30-marketplace-venue-base.md`.

## Usage

`createBaseVenue(config)` (program §5) is the supported composition surface. It builds the single
Safe broadcaster, the single state file, and every port factory over them, and returns a
`BaseVenue`:

```ts
import { createBaseVenue } from "@jinn-network/marketplace-venue-base";

const venue = createBaseVenue({
  chain, publicClient, walletClient, safeAddress, stateDbPath,
  priorityMech, pin, verifySettlementGrade, isAuthorizedMechOrigin, observations,
});
// venue.claim, venue.settlement, venue.lifecycle, venue.finality, venue.deliveryWait,
// venue.release, venue.observe, venue.safe, venue.logSource, venue.intents
venue.close();
```

Every per-port factory (`createSafeBroadcaster`, `createChainLogSource`, `createClaimWriter`, …)
is also exported directly for hosts that need finer-grained composition than the facade offers,
but `createBaseVenue` is the surface the composition design and the venue conformance kit
(`@jinn-network/marketplace-testing`'s `venue-conformance.test.ts`) exercise.
