# JinnRouter Client Integration Design

> Version: 0.1.0
> Date: 2026-03-26
> Author: Oak

## Summary

Modify the `MechAdapter` in `client/` to route all marketplace requests through the deployed JinnRouter contract instead of calling `marketplace.request()` directly. Add `claimDelivery()` after mech delivery and defer evaluation job creation until after restoration delivery is claimed, matching the on-chain loop enforcement.

## Context

The JinnRouter is deployed on Base at `0xfFa7118A3D820cd4E820010837D65FAfF463181B` behind the activity checker proxy at `0x477C41Cccc8bd08027e40CEF80c25918C595a24d`. It serves as both the request router for the Jinn training loop and the OLAS-compatible activity checker for staking rewards.

The client at `client/` (commit `05b414c`) currently calls `marketplace.request()` directly and fires both restoration and evaluation requests upfront in `postDesiredState()`. The JinnRouter requires requests to go through `createRestorationJob()` / `createEvaluationJob()`, and enforces loop ordering on-chain: `createEvaluationJob` reverts unless `claimDelivery` has been called for the referenced restoration request.

## Approach

Modify `MechAdapter` in-place (Approach A). The router is the only path for all Jinn participants — there is no reason to keep raw marketplace access.

## 1. Config and ABI

`MechAdapterConfig` gains one field:

```ts
routerAddress: `0x${string}`;  // JinnRouter proxy on Base
```

`mechMarketplaceAddress` is retained for `getTimeoutBounds`, `mapRequestIdInfos` (delivery status checks), and `MarketplaceRequest` event decoding.

New `JINN_ROUTER_ABI` in `types.ts`:

| Function | Signature |
|----------|-----------|
| `createRestorationJob` | `(bytes requestData, address priorityMech, uint256 maxDeliveryRate, uint256 responseTimeout, bytes32 paymentType, bytes paymentData) payable returns (bytes32 requestId)` |
| `createEvaluationJob` | `(bytes32 restorationRequestId, bytes requestData, address evaluationMech, uint256 maxDeliveryRate, uint256 responseTimeout, bytes32 paymentType, bytes paymentData) payable returns (bytes32 requestId)` |
| `claimDelivery` | `(bytes32 requestId)` |

Events: `RestorationJobCreated(address indexed creator, bytes32 indexed requestId)`, `EvaluationJobCreated(address indexed creator, bytes32 indexed requestId, bytes32 indexed restorationRequestId)`, `DeliveryClaimed(address indexed claimer, bytes32 indexed requestId, uint8 jobType)`.

## 2. Contract call changes (`contracts.ts`)

### Replace `submitMarketplaceRequest` with two functions

**`submitRestorationJob()`** — encodes `router.createRestorationJob()`, sends Safe tx to `routerAddress` (not `marketplaceAddress`), parses `RestorationJobCreated` event for the request ID.

**`submitEvaluationJob()`** — encodes `router.createEvaluationJob(restorationRequestId, ...)`, sends Safe tx to `routerAddress`, parses `EvaluationJobCreated` event for the request ID.

### New `claimDelivery()`

Encodes `router.claimDelivery(requestId)`, sends Safe tx to `routerAddress`. The Solidity function has no return value; the client returns the Safe-level tx hash. Success is confirmed by the `DeliveryClaimed` event.

### Unchanged

`getMechDeliveryRate`, `getTimeoutBounds`, `decodeDeliverLogs`, `callDeliverToMarketplace` — these interact with the mech and marketplace, which are unchanged.

## 3. Adapter flow changes (`adapter.ts`)

### `postDesiredState()`

Current: posts restoration request + evaluation request upfront.
New: posts restoration request only. Stores the desired state in `pendingEvaluations: Map<requestId, DesiredState>` for later evaluation creation.

```
postDesiredState(state)
  1. Build payload, upload to IPFS, get digest
  2. submitRestorationJob(routerAddress, ...) → restorationRequestId
  3. pendingEvaluations.set(restorationRequestId, state)
  4. return restorationRequestId
```

### `watchForDeliveries()`

Current: polls `Deliver` events, yields `DeliveredResult`.
New: after detecting a delivery, calls `claimDelivery(requestId)` via Safe tx. Handles both restoration deliveries (which trigger evaluation creation) and evaluation deliveries (which just need claiming).

The adapter tracks two sets:
- `pendingEvaluations: Map<requestId, DesiredState>` — restoration requests awaiting delivery before evaluation can be posted. Populated by `postDesiredState`, consumed after restoration delivery claim succeeds.
- `pendingEvaluationClaims: Set<requestId>` — evaluation request IDs awaiting delivery. Populated when `submitEvaluationJob` returns, consumed after evaluation delivery claim succeeds.

```
watchForDeliveries()
  for each Deliver event:
    1. Parse delivery data from IPFS
    2. Skip if requestId is not in pendingEvaluations or pendingEvaluationClaims
       (avoids wasting gas on claimDelivery for requests this client didn't create)
    3. claimDelivery(requestId) via Safe tx
    4. if pendingEvaluations.has(requestId):
       // Restoration delivery — post the evaluation job
       a. Build evaluation payload, upload to IPFS
       b. evalRequestId = submitEvaluationJob(routerAddress, requestId, ...)
       c. pendingEvaluationClaims.add(evalRequestId)
       d. pendingEvaluations.delete(requestId)  // only after eval job succeeds
    5. if pendingEvaluationClaims.has(requestId):
       // Evaluation delivery — claim already happened in step 3
       a. pendingEvaluationClaims.delete(requestId)
    6. yield DeliveredResult
```

**Evaluation mech address:** Phase 0 uses the same mech for both restoration and evaluation (`config.mechContractAddress`). If separate evaluation mechs are needed later, add an optional `evaluationMechAddress` to `MechAdapterConfig`.

**Persistence:** `pendingEvaluations` and `pendingEvaluationClaims` are in-memory. If the client crashes between posting a restoration job and the delivery arriving, the pending evaluation is lost. This is a known Phase 0 limitation — recovery can be added later by scanning recent `RestorationJobCreated` events on startup and rebuilding the pending set for any unclaimed requests.

### `watchForRequests()`

Mostly unchanged. Still polls `MarketplaceRequest` events on the marketplace (the router calls `marketplace.request()` internally, so the same events fire). The `requester` indexed field is now the router address, not the Safe — but we already filter by mech, not requester.

**Remove `isEvaluationReady` and `deferredEvaluations`.** The router enforces ordering on-chain. The client no longer needs to check marketplace delivery status before yielding evaluation requests — if the evaluation request exists on-chain, the router already verified the restoration was claimed.

## 4. Safe nonce budget

Nonces consumed per full loop:

| Step | Safe tx | Router counter |
|------|---------|----------------|
| `createRestorationJob()` | +1 | creationCount +1 |
| `mech.deliverToMarketplace()` | +1 | (none) |
| `claimDelivery(restoration)` | +1 | restorationDeliveryCount +1 |
| `createEvaluationJob()` | +1 | evaluationCreationCount +1 |
| Evaluation mech delivers | +1 | (none) |
| `claimDelivery(evaluation)` | +1 | evaluationDeliveryCount +1 |

6 nonces, 4 activity counters. `4 <= 6` passes the `total <= nonceDelta` bound in `isRatioPass()`.

No heartbeat logic is needed. The old jinn-node heartbeat compensated for V2's single-dimension checker. The JinnRouter counts real loop activity across four dimensions.

## 5. Error handling

### `claimDelivery` failures

| Error | Handling |
|-------|----------|
| `AlreadyClaimed` | Idempotent. Catch, log, continue. |
| `NotDelivered` | Race condition — delivery event seen but marketplace state not settled. Retry 3 times with 2s backoff. If all retries fail, skip — the entry remains in `pendingEvaluations`/`pendingEvaluationClaims` and will be retried on the next delivery poll cycle. |
| `RequestNotFound` | Request wasn't created through router. Log warning, skip. |

### `createEvaluationJob` failures

| Error | Handling |
|-------|----------|
| `RestorationNotClaimed` | Re-attempt `claimDelivery` first, then retry evaluation creation. |

### Delivery attribution

The deployed JinnRouter does not verify the claimer is the actual deliverer (Phase 0 simplification per spec section 6.2). Any Safe can claim any router-created request. However, `claimDelivery` credits `msg.sender` — the counter increments for the *claiming* Safe. The client must always claim deliveries from the same Safe that created the job to ensure activity counters align with the correct service multisig.

## 6. File-level changes

| File | Change |
|------|--------|
| `src/adapters/mech/types.ts` | Add `JINN_ROUTER_ABI`. Add `routerAddress` to `MechAdapterConfig`. |
| `src/adapters/mech/contracts.ts` | Replace `submitMarketplaceRequest()` with `submitRestorationJob()` and `submitEvaluationJob()`. Add `claimDelivery()`. Keep `getMechDeliveryRate`, `getTimeoutBounds`, `decodeDeliverLogs`, `callDeliverToMarketplace` unchanged. |
| `src/adapters/mech/adapter.ts` | Rewrite `postDesiredState()` (restoration only + pending map). Update `watchForDeliveries()` (add claim + evaluation). Remove `isEvaluationReady` and `deferredEvaluations`. |
| `scripts/e2e-validate.ts` | Update to use router address. Add claim + evaluation steps. |
| `test/adapters/mech/*.test.ts` | Update for new function signatures. Add tests for claim retry and evaluation-after-claim. |

No new files. No changes to the adapter interface, daemon, runners, store, IPFS, or Safe transaction handling.
