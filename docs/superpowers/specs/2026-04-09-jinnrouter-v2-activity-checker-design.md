# JinnRouter V2 + Activity Checker Integration Design

> Version: 0.1.0
> Date: 2026-04-09
> Author: Oak, Claude

## 1. Goal

Integrate the JinnRouter with the RestorationActivityCheckerV2 so that the client makes a single call per marketplace action, and anti-farming evidence for restoration deliveries is automatically forwarded from the router to the checker. The staking contract reads eligibility from the checker, which combines raw activity counts (from the router) with novelty-weighted evidence (for restoration deliveries).

## 2. Architecture

```
Client
    │
    │ createRestorationJob(...)
    │ claimDelivery(requestId, evidenceHash)
    │ createEvaluationJob(...)
    │
    ▼
JinnRouter (behind proxy, upgradeable)
    │
    ├── routes request to MechMarketplace
    ├── increments own activity counters
    └── on restoration delivery claim: forwards evidenceHash to checker
         │
         ▼
RestorationActivityCheckerV2 (behind proxy, upgradeable)
    │
    ├── stores evidence hash, computes novelty weight
    ├── maintains novelty-weighted restoration delivery count
    └── implements getMultisigNonces() + isRatioPass()
         │
         ▼
Staking Contract
    │
    └── calls getMultisigNonces() + isRatioPass() at checkpoint
```

## 3. Responsibilities

**JinnRouter** — routes marketplace requests, enforces training loop ordering, maintains raw activity counters, forwards evidence to the checker on restoration delivery claims. Does NOT determine reward eligibility.

**RestorationActivityCheckerV2** — determines reward eligibility. Reads raw activity counts from the JinnRouter for creation, eval creation, and eval delivery. Maintains its own novelty-weighted count for restoration deliveries (via forwarded evidence). Implements the OLAS activity checker interface.

**Staking contract** — unchanged. Calls `getMultisigNonces()` and `isRatioPass()` on the activity checker. Binary pass/fail per service per checkpoint.

## 4. Activity Types and Evidence

| Action | Router counter | Evidence required | Checker handling |
|--------|---------------|-------------------|-----------------|
| Create restoration job | `creationCount++` | No | Raw count from router |
| Restoration delivery claim | `restorationDeliveryCount++` | Yes (`evidenceHash`) | Novelty-weighted count in checker |
| Create evaluation job | `evaluationCreationCount++` | No | Raw count from router |
| Evaluation delivery claim | `evaluationDeliveryCount++` | No | Raw count from router |

Anti-farming applies only to restoration deliveries. This is the primary farming vector — an operator could deliver canned results to similar jobs. Other actions are either self-limiting (creation costs gas/fees), linked to other actions (eval creation), or naturally similar by design (evaluation deliveries verify the same kinds of states).

## 5. JinnRouter V2 Changes

### 5.1 New state

```solidity
// Reference to the activity checker (set during initialize)
address public activityChecker;
```

### 5.2 Modified initialize

```solidity
function initialize(
    address _mechMarketplace,
    uint256 _livenessRatio,
    address _activityChecker  // NEW
) external
```

### 5.3 Modified claimDelivery

```solidity
function claimDelivery(
    bytes32 requestId,
    bytes32 evidenceHash  // NEW: optional, forwarded to checker for restoration deliveries
) external
```

When `jobType == RESTORATION` and `evidenceHash != bytes32(0)`:
- Call `IActivityChecker(activityChecker).recordRestorationEvidence(msg.sender, evidenceHash)`

When `evidenceHash == bytes32(0)` or `jobType == EVALUATION`:
- Skip evidence forwarding (backward compatible)

### 5.4 Unchanged functions

`createRestorationJob` and `createEvaluationJob` signatures are unchanged. They don't submit evidence.

### 5.5 Removed from router

`getMultisigNonces()` and `isRatioPass()` are removed from the JinnRouter. The staking contract now points to the V2 checker, not the router. The router's counters remain public for the checker to read, but the router no longer implements the activity checker interface.

## 6. RestorationActivityCheckerV2 Changes

### 6.1 New state

```solidity
// Reference to the JinnRouter (to read raw activity counters)
address public jinnRouter;

// Only the router can forward evidence
address public authorizedRouter;
```

### 6.2 New function

```solidity
/// @notice Called by the JinnRouter when a restoration delivery is claimed with evidence.
function recordRestorationEvidence(
    address multisig,
    bytes32 evidenceHash
) external
```

Only callable by `authorizedRouter`. Stores the evidence hash, computes novelty weight, increments `noveltyWeightedCounts[multisig]`.

### 6.3 Modified getMultisigNonces

Returns a 2-slot array for the OLAS interface:

```solidity
function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
    nonces = new uint256[](2);
    nonces[0] = IMultisig(multisig).nonce();
    nonces[1] = _computeTotalWeightedActivity(multisig);
}
```

`_computeTotalWeightedActivity` combines:
- Router's `creationCount[multisig]` — full weight (1e18 per activity)
- Checker's `noveltyWeightedCounts[multisig]` — novelty-weighted restoration deliveries
- Router's `evaluationCreationCount[multisig]` — full weight
- Router's `evaluationDeliveryCount[multisig]` — full weight

### 6.4 Modified isRatioPass

Uses the total weighted activity from `getMultisigNonces`:

```solidity
function isRatioPass(
    uint256[] memory curNonces,
    uint256[] memory lastNonces,
    uint256 ts
) external view returns (bool ratioPass) {
    if (ts > 0 && curNonces[1] > lastNonces[1]) {
        uint256 diffWeighted = curNonces[1] - lastNonces[1];
        uint256 ratio = diffWeighted / ts;
        ratioPass = (ratio >= livenessRatio);
    }
}
```

### 6.5 Backward compatibility

`recordActivity()` and `recordActivityWithEvidence()` remain for direct use (scripts, testing). The router path is the primary production path.

## 7. Proxy Architecture

Both contracts sit behind upgradeable proxies:

```
ActivityCheckerProxy → RestorationActivityCheckerV2 (implementation)
JinnRouterProxy → JinnRouter V2 (implementation)

StakingContract.activityChecker → ActivityCheckerProxy
JinnRouter.activityChecker → ActivityCheckerProxy
```

The existing JinnRouter deployed at `0x3930ff...` is not behind a proxy. We deploy a new JinnRouter V2 behind a proxy for upgradeability. The existing deployment is abandoned.

## 8. Deployment Sequence

1. Deploy RestorationActivityCheckerV2 implementation
2. Deploy ActivityCheckerProxy pointing to V2 implementation
3. Deploy JinnRouter V2 implementation
4. Deploy JinnRouterProxy pointing to V2 implementation
5. Initialize JinnRouter V2: `initialize(mechMarketplace, livenessRatio, activityCheckerProxy)`
6. Set `authorizedRouter` on V2 checker to JinnRouterProxy
7. Set `jinnRouter` on V2 checker to JinnRouterProxy
8. Create new StakingToken proxy via existing StakingFactory with `activityChecker = activityCheckerProxy`
9. Fund staking proxy with JINN rewards

## 9. Client Changes

Minimal. The client's MechAdapter already calls `claimDelivery(requestId)`. The change is:
- After a restoration delivery, compute the SimHash of the execution evidence
- Call `claimDelivery(requestId, evidenceHash)` instead of `claimDelivery(requestId)`

The JinnRouter ABI in `client/src/adapters/mech/types.ts` gets the updated `claimDelivery` signature. The adapter computes the SimHash using the existing `evidence-simhash.ts` module.

For evaluation deliveries, `claimDelivery(requestId, bytes32(0))` — no evidence.

## 10. What This Does NOT Include

- Challenge mechanism (future work)
- Evidence for non-delivery actions (not needed — creation costs gas, eval delivery is naturally similar)
- Graduated decay (binary: novel = full weight, similar = zero)
- On-chain evidence verification (client is trusted for Phase 1b; challenge mechanism closes this gap)
