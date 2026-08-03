# @jinn-network/marketplace-venue-base

Phase C keeps this package as the Base transport and canonical venue-state authority. Its schema
stores the exact posting command alongside requester submission scopes. Recovery reads a resolved
WAL row and completes the matching scope atomically; caller-supplied outcomes and chain-only
`TaskCreated` matches cannot resolve a scope. Older pending scopes that lack the exact join fields
are retained as `legacy-scope-unrecoverable` and are never silently retried.

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

## Deliverables

| Design §6.1 deliverable | Port it fills | Module |
| --- | --- | --- |
| Chain log source — chunked `getLogs`, durable `(blockNumber, blockHash)` cursor, reorg handling per §7.2 | the projector's event feed | `src/log-source/chain-log-source.ts`, `src/log-source/cursor-store.ts` |
| Safe broadcast — `execTransaction` with shared nonce ledger, cross-process lock, stuck-nonce eviction, inner-revert decode | `SafeBroadcastPort` | `src/broadcast/{classify,fees,ledger,lock,stuck-nonce,safe-broadcaster}.ts` |
| Claim writer | `ClaimPorts.claimTask` | `src/writers/claim.ts` |
| Settlement reads and writes — delivery-facts readers, `claimSolutionDelivery`, revised-generation settle | `SettlementPorts` | `src/writers/settlement.ts` |
| Lifecycle writes — resolve / cancel / withdraw / refund / close / release | `MarketplaceLifecyclePorts`, `ReleaseAttemptPort` | `src/writers/lifecycle.ts` |
| Finality waiter — over the log source, applying the projector's finality policy | `FinalityPort` | `src/waiters/finality.ts` |
| Delivery waiter — event watch with poll fallback and cancellation | `DeliveryWaitPort` | `src/waiters/delivery.ts` |
| Durable posting-intent store (SQLite, §7.4) | replaces the in-memory crash WAL | `src/intents/{intent-store,drain}.ts` |
| Projector-backed observe | `MarketplaceObservePort` | `src/observe/{observe-store,projector-observe}.ts` |
| Marketplace deliver leg — `deliverToMarketplace` with already-delivered idempotency | the deliver leg the pipeline calls before reading delivery facts | `src/deliver-leg.ts` — **not built here.** Homed in this tree by coordinator ruling, but its implementation and tests execute in `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` Task 8. |

## Rules this package holds itself to

- **Signer-injection only.** No keystore, no key-loading code, no key material — in production
  source or tests. A source-boundary guard enforces it.
- **Storage location is a host parameter.** Every persistent artefact lives in the one SQLite file
  named by `config.stateDbPath`. Absolute defaults and `homedir()` are guard-banned.
- **One transaction path.** Every writer funnels through the single Safe broadcaster. A batched
  request routed through the MultiSend singleton uses `operation: 1` (DelegateCall) so each inner
  leg keeps `msg.sender == Safe`.
- **No ambient network.** HTTP reaches the package only through the injected viem transports and
  the injected `IpfsPinPort`.
- **No dependency on `@jinn-network/marketplace-pipeline`.** Guard-enforced: the three
  pipeline-declared ports are consumed from their re-homed declarations on
  `@jinn-network/marketplace-binding`.

## Running the conformance kit

```bash
cd packages/marketplace/testing
yarn vitest run src/venue-conformance.test.ts
```

The fork slice needs Foundry's `anvil` on `PATH` and network access to a Base Sepolia RPC
(override with `JINN_MARKETPLACE_FORK_RPC_URL`). Without `anvil` those blocks report skipped,
never failed.
