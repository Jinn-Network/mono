# Jinn Activity Checker Specification

> Version: 0.1.0-draft
> Date: 2026-03-25
> Author: Oak, Ritsu

This document specifies the JinnRouter — a dual-purpose contract that serves as both the request router for the Jinn training loop and the OLAS-compatible activity checker for staking rewards.

## 1. Motivation

The Jinn training loop has three roles — creator, restorer, evaluator — but previous activity checkers could only track one dimension:

- V1 (`DeliveryActivityChecker`): tracked deliveries only
- V2 (`WhitelistedRequesterActivityChecker`): tracked requests only, with whitelist

Neither captures the full training loop. A creator who posts well-defined desired states gets zero credit in V1. A restorer who delivers restorations gets zero credit in V2. And neither can distinguish restoration from evaluation on-chain.

The JinnRouter solves this by routing all marketplace requests through a single contract that tags job types and tracks per-role activity, while also implementing the standard OLAS activity checker interface.

## 2. Architecture

The JinnRouter is deployed as the implementation behind the existing activity checker proxy on Base. The staking contract calls the proxy, which delegates to the JinnRouter.

```
┌──────────────────────┐
│   Staking Contract    │
│ (activityChecker →)   │
└──────────┬───────────┘
           │ staticcall
           ▼
┌──────────────────────┐
│  Activity Checker     │
│  Proxy (upgradeable)  │
└──────────┬───────────┘
           │ delegatecall
           ▼
┌──────────────────────┐        ┌──────────────────────┐
│    JinnRouter         │───────▶│   Mech Marketplace    │
│ (implementation)      │request │                      │
│                       │◀───────│                      │
│ • createRestorationJob│        │ • request()          │
│ • createEvaluationJob │        │ • getRequestStatus() │
│ • claimDelivery       │        │ • deliverMarketplace()│
│ • getMultisigNonces   │        └──────────────────────┘
│ • isRatioPass         │                  ▲
└───────────────────────┘                  │ deliver (unchanged)
                                           │
                                    ┌──────┴───────┐
                                    │  Agent Mech   │
                                    └──────────────┘
```

### 2.1 On-Chain Setup (Base)

| Component | Address |
|-----------|---------|
| Staking contract | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| Activity checker proxy | `0x477C41Cccc8bd08027e40CEF80c25918C595a24d` |
| Current implementation | `0xEE70221cFb894257dF7F5aFA6502Be4A190FcED5` |
| Proxy owner | `0x900Db2954a6c14C011dBeBE474e3397e58AE5421` |
| Mech marketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |

## 3. Tracked Activities

The Jinn training loop produces four on-chain activities:

| Activity | Marketplace primitive | Router function | Counter |
|----------|----------------------|-----------------|---------|
| Creation | Request (desired state) | `createRestorationJob()` | `creationCount[multisig]` |
| Restoration delivery | Delivery (attempt) + claim | `claimDelivery(requestId)` | `restorationDeliveryCount[multisig]` |
| Evaluation creation | Request (evaluation job) | `createEvaluationJob()` | `evaluationCreationCount[multisig]` |
| Evaluation delivery | Delivery (verdict) + claim | `claimDelivery(requestId)` | `evaluationDeliveryCount[multisig]` |

All four counters are monotonically increasing per multisig address.

## 4. Lifecycle

### 4.1 Creation

The creator's Safe multisig calls `Router.createRestorationJob(requestData, priorityMech, maxDeliveryRate, responseTimeout, paymentType, paymentData)`.

The router:
1. Increments `creationCount[msg.sender]`
2. Calls `marketplace.request(requestData, maxDeliveryRate, paymentType, priorityMech, responseTimeout, paymentData)`, forwarding any attached payment
3. Stores `requestId → { type: RESTORATION, creator: msg.sender }`
4. Returns the `requestId`

### 4.2 Restoration delivery

The restorer's mech delivers to the marketplace as normal — this flow is unchanged:

```
Agent mech → marketplace.deliverMarketplace(requestIds, rates)
```

After delivery, the restorer's Safe calls `Router.claimDelivery(requestId)`.

The router:
1. Verifies the request was created through the router (`requestTypes[requestId]` exists)
2. Verifies the marketplace reports the request as delivered
3. Verifies the claim has not been made before
4. Reads `requestTypes[requestId]` — it's RESTORATION
5. Increments `restorationDeliveryCount[msg.sender]`

### 4.3 Evaluation creation

After a restoration delivery is claimed, anyone can create an evaluation job. The evaluator's (or creator's) Safe calls `Router.createEvaluationJob(restorationRequestId, requestData, evaluationMech, maxDeliveryRate, responseTimeout, paymentType, paymentData)`.

The router:
1. **Verifies loop ordering**: a restoration delivery must have been claimed for `restorationRequestId`
2. Increments `evaluationCreationCount[msg.sender]`
3. Calls `marketplace.request(...)` with the evaluation mech as priority
4. Stores `requestId → { type: EVALUATION, creator: msg.sender }`
5. Returns the `requestId`

### 4.4 Evaluation delivery

Same as §4.2 but for evaluation requests. The evaluator's mech delivers to the marketplace, then the evaluator's Safe calls `Router.claimDelivery(requestId)`.

The router verifies delivery, reads the type as EVALUATION, and increments `evaluationDeliveryCount[msg.sender]`.

## 5. Activity Checker Interface

The router implements the standard OLAS activity checker interface.

### 5.1 Nonce array

```solidity
function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
    nonces = new uint256[](5);
    nonces[0] = IMultisig(multisig).nonce();
    nonces[1] = creationCount[multisig];
    nonces[2] = restorationDeliveryCount[multisig];
    nonces[3] = evaluationCreationCount[multisig];
    nonces[4] = evaluationDeliveryCount[multisig];
}
```

### 5.2 Ratio check

```solidity
function isRatioPass(
    uint256[] memory cur,
    uint256[] memory last,
    uint256 ts
) external view returns (bool ratioPass) {
    if (ts == 0 || cur[0] <= last[0]) return false;

    uint256 nonceDelta = cur[0] - last[0];
    uint256 total = 0;
    for (uint256 i = 1; i <= 4; i++) {
        if (cur[i] > last[i]) total += cur[i] - last[i];
    }

    if (total == 0 || total > nonceDelta) return false;

    uint256 ratio = (total * 1e18) / ts;
    ratioPass = (ratio >= livenessRatio);
}
```

The ratio sums all four activity deltas. Any combination of activities can satisfy the liveness requirement — a pure creator, a pure restorer, or a mixed agent. The `total <= nonceDelta` bound ensures claimed activities cannot exceed the number of Safe transactions executed.

## 6. Design Details

### 6.1 Payment forwarding

The router calls `marketplace.request()` on behalf of the caller. For native payments, the caller sends ETH with the call and the router forwards it. For token payments, the caller approves the router, which transfers tokens to the marketplace.

### 6.2 Delivery claim attribution

The `claimDelivery` function credits `msg.sender`. To prevent one multisig from claiming another's delivery, the router should verify the claiming multisig is the actual deliverer. The marketplace's `requestInfo[requestId].deliveryMech` identifies the delivering mech. The router can verify this mech belongs to the claimer's service.

### 6.3 Request attribution

When the router calls `marketplace.request()`, `msg.sender` from the marketplace's perspective is the router contract. The marketplace's `mapRequestCounts[router]` increments globally, not per-multisig. The router's own `creationCount` and `evaluationCreationCount` mappings are the authoritative per-multisig counters.

### 6.4 Loop enforcement

`createEvaluationJob(restorationRequestId)` requires that `claimDelivery` was previously called for `restorationRequestId` and that it was a restoration-type request. This enforces the create → restore → evaluate ordering on-chain and prevents evaluation farming without actual restoration.

### 6.5 Storage layout

The current activity checker implementation uses immutables (`livenessRatio`, `mechMarketplace`) which live in bytecode, not storage. The JinnRouter adds storage mappings. Since the current implementation has minimal storage footprint, there should be no collision. The new implementation should use ERC-7201 namespaced storage to guarantee safety across future upgrades.

## 7. Deployment

1. Deploy the `JinnRouter` implementation contract on Base
2. Call `upgradeTo(newImplementation)` on the activity checker proxy from the proxy owner
3. Update the jinn-node client to route requests through the JinnRouter and claim deliveries after mech delivery

No operator migration, no new staking contract, no vote redirection.

## 8. Evolution

### Phase 1 — Anti-farming

Upgrade the router proxy. Add LSH evidence hashing to `createEvaluationJob`. Similar evidence reduces the effective activity count in `isRatioPass`.

### Phase 1 — Weighted rewards

The router's per-activity counters become the data source for Jinn distribution contracts. Each distribution contract reads the counter for its channel. The router narrows to a binary liveness gate for OLAS staking.

### Phase 1 — Delivery routing

If needed, the router can be upgraded to mediate deliveries directly (register as a mech or add delivery forwarding). The proxy architecture makes this non-breaking.

## 9. Incentive Analysis

**Creators** are incentivised to post real desired states. Trivial requests cost USDC (delivery rate + marketplace fee) and gas.

**Restorers** are incentivised to attempt restorations and claim their deliveries. The claim step makes their work visible on-chain.

**Evaluators** are incentivised to create evaluation jobs and deliver verdicts. Loop enforcement means evaluation jobs can only exist after claimed restoration deliveries.

**Not yet tracked:** successful outcomes (pass/fail), novel work (anti-farming decay), per-role weighted rewards. These are Phase 1 distribution contract concerns. The router's per-activity counters provide the data foundation.
