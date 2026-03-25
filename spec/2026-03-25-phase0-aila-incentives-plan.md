# Phase 0: Aila Marketplace Incentives Plan

> Version: 0.1.0-draft
> Date: 2026-03-25
> Status: Proposal

## Summary

Phase 0 uses the existing Olas Mech Marketplace on Base as the execution layer and OLAS staking contracts for distribution infrastructure. Rather than building ERC-8183 from scratch, we map the four-stage Jinn training loop onto the Mech Marketplace's existing primitives (requests, deliveries, karma) and write a custom activity checker that verifies participation across all four lifecycle stages.

Ritsu builds the client. This plan covers the smart contract and staking infrastructure side.

## 1. Mapping the Jinn Loop to the Mech Marketplace

The Mech Marketplace exposes the following on-chain primitives we can use:

| Jinn Stage | Marketplace Primitive | On-Chain Tracking |
|---|---|---|
| **Creation** | Posting a request via `MechMarketplace.request()` | `mapRequestCounts[requester]` increments |
| **Restoration** | Mech delivers via `deliverMarketplace()` | `mapMechServiceDeliveryCounts[serviceMultisig]` increments |
| **Evaluation** | Karma updates on delivery quality | `Karma.mapMechKarma[mech]` changes |
| **Outcome** | Successful delivery (positive karma delta) | `mapDeliveryCounts[requester]` increments; karma increases |

### Key Simplifications for Phase 0

- **Evaluation is implicit.** The Mech Marketplace doesn't have a separate evaluator role. At Phase 0, the delivery confirmation and karma system serve as the evaluation proxy. The activity checker treats karma-positive deliveries as successful outcomes.
- **Single service, multiple roles.** The Jinn service acts as both requester (creation) and mech (restoration). The activity checker must verify activity on both sides of the marketplace.
- **No anti-farming decay at Phase 0.** LSH-based novelty checking is deferred to Phase 1 when we have our own contracts. Phase 0 proves the loop works.

## 2. Architecture

```
┌──────────────────────────────────────────────────┐
│ OLAS Protocol (Ethereum Mainnet)                 │
│                                                  │
│  veOLAS ──vote──> VoteWeighting                  │
│                        │                         │
│                   vote weight                    │
│                        │                         │
│               Dispenser / Treasury               │
│                        │                         │
│                   OLAS emissions                  │
└────────────────────────┼─────────────────────────┘
                         │ (bridged to Base)
┌────────────────────────┼─────────────────────────┐
│ Base L2                ▼                         │
│                                                  │
│  ┌──────────────────────────────┐                │
│  │ ServiceStakingToken          │                │
│  │ (OLAS staking contract)      │                │
│  │                              │                │
│  │  activityChecker:            │                │
│  │  JinnActivityChecker ────────┼──> MechMarketplace
│  │                              │        │       │
│  │  serviceRegistry: Base reg   │    BalanceTracker
│  │  stakingToken: OLAS (bridged)│        │       │
│  └──────────────────────────────┘      Karma     │
│                                                  │
│  Jinn Service (multisig)                         │
│  ├── Posts requests (creation)                   │
│  ├── Delivers on requests (restoration)          │
│  ├── Receives karma (evaluation)                 │
│  └── Earns OLAS rewards (outcome)                │
└──────────────────────────────────────────────────┘
```

## 3. Custom Activity Checker: `JinnActivityChecker`

### 3.1 Interface

Extends the standard `StakingActivityChecker` pattern but tracks a **composite nonce** across all four lifecycle stages.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title JinnActivityChecker
/// @notice Activity checker for Jinn Phase 0 on the Olas Mech Marketplace.
///         Tracks four lifecycle stages: creation, restoration, evaluation, outcome.
contract JinnActivityChecker {
    // Mech Marketplace contract
    address public immutable mechMarketplace;
    // Karma contract
    address public immutable karma;
    // Minimum liveness ratio (1e18 format)
    uint256 public immutable livenessRatio;

    constructor(address _mechMarketplace, address _karma, uint256 _livenessRatio) { ... }

    /// @dev Returns composite nonces for all four lifecycle stages.
    /// @return nonces Array of 4 values:
    ///   [0] multisig tx nonce (base liveness)
    ///   [1] request count (creation)
    ///   [2] delivery count (restoration + outcome)
    ///   [3] karma score (evaluation signal)
    function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces);

    /// @dev Checks that ALL lifecycle stages show activity above threshold.
    ///      - Multisig nonce must have increased (base liveness)
    ///      - Request count must have increased (creation happened)
    ///      - Delivery count must have increased (restoration happened)
    ///      - Karma must not have decreased (evaluation signal)
    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view returns (bool ratioPass);
}
```

### 3.2 Nonce Composition

The key insight: `getMultisigNonces` returns a **4-element array** instead of the standard 1. The staking contract stores the full array at each checkpoint and passes both current and last arrays to `isRatioPass`.

| Index | Source | Tracks |
|---|---|---|
| 0 | `IMultisig(multisig).nonce()` | Base liveness — the service is alive and transacting |
| 1 | `IMechMarketplace(mechMarketplace).mapRequestCounts(multisig)` | Creation — desired states posted |
| 2 | `IMechMarketplace(mechMarketplace).mapMechServiceDeliveryCounts(multisig)` | Restoration — deliveries made by the service |
| 3 | `IKarma(karma).mapMechKarma(multisig)` | Evaluation — cumulative quality signal |

### 3.3 Ratio Check Logic

```
ratioPass = (
    curNonces[0] > lastNonces[0]         // service is alive
    && curNonces[1] > lastNonces[1]      // at least one creation
    && curNonces[2] > lastNonces[2]      // at least one delivery
    && curNonces[3] >= lastNonces[3]     // karma hasn't decreased
    && compositeRatio >= livenessRatio   // overall activity rate
)

where compositeRatio = ((curNonces[0] - lastNonces[0]) * 1e18) / ts
```

This ensures the service participates in the **full lifecycle** every epoch — it can't just create requests without delivering, or deliver without creating.

## 4. Staking Contract Deployment

### 4.1 Contract: `ServiceStakingToken` (existing OLAS contract)

Deploy an instance of the existing OLAS `ServiceStakingToken` on Base with:

| Parameter | Value | Rationale |
|---|---|---|
| `stakingToken` | OLAS (bridged on Base) | Standard OLAS staking |
| `serviceRegistry` | Base service registry | Existing OLAS infra |
| `activityChecker` | `JinnActivityChecker` (deployed) | Our custom checker |
| `livenessRatio` | TBD (start conservative) | Tune after observing initial activity |
| `minStakingDeposit` | TBD | Minimum OLAS to stake |
| `minNumStakingPeriods` | 2 | Prevent stake-unstake gaming |
| `maxNumInactivityPeriods` | 1 | Evict inactive services quickly |
| `numAgentInstances` | 1 | Single operator per service initially |
| `maxNumServices` | TBD | Start small (10-20 slots) |
| `rewardsPerSecond` | Determined by veOLAS votes | Set by OLAS emissions |

### 4.2 Deployment Sequence

1. Deploy `JinnActivityChecker` with marketplace + karma addresses and liveness ratio
2. Deploy `ServiceStakingToken` proxy with the activity checker address
3. Register the staking contract as a nominee in the OLAS `VoteWeighting` contract
4. Service operators register services in the Base service registry
5. Services stake into the staking contract

## 5. veOLAS Funding

The staking contract receives OLAS emissions proportional to its veOLAS vote weight. Zero votes = zero emissions.

### 5.1 Steps to Get Funded

1. **Nominate the staking contract.** Call `VoteWeighting.addNomineeEVM(stakingContractAddress, baseChainId)` on Ethereum mainnet. Anyone can do this.
2. **Secure veOLAS votes.** veOLAS holders must call `voteForNomineeWeights()` directing vote weight to our contract. This requires:
   - OLAS locked as veOLAS (longer lock = more voting power)
   - Active voting each epoch (votes must be refreshed, not set-and-forget due to the 53-week lookbehind)
3. **Monitor emissions.** After voting, the OLAS Dispenser bridges emissions to Base and credits the staking contract each epoch.

### 5.2 Bootstrap Strategy

For Phase 0, the Jinn team needs to:
- **Lock sufficient OLAS as veOLAS** — enough to give the staking contract meaningful emissions
- **Coordinate with aligned veOLAS holders** to also vote for the contract
- **Calculate minimum viable emissions** — enough to reward the expected number of services (e.g. 10 services × target reward rate)

### 5.3 Rough Economics

```
emissions_per_epoch = total_olas_emissions × (our_vote_weight / total_vote_weight)
reward_per_service = emissions_per_epoch / num_eligible_services
```

Eligible services are those that pass the `JinnActivityChecker` liveness check at the checkpoint.

## 6. Client Requirements (Ritsu's Side)

The client must ensure the service multisig performs all four lifecycle actions within each staking epoch:

### 6.1 Creation
- Post at least one request to the Mech Marketplace per epoch
- The request should represent a genuine desired state (even if simple at Phase 0)
- Tracked via `mapRequestCounts[multisig]`

### 6.2 Restoration
- Pick up and deliver on at least one request per epoch
- Submit structured evidence (checkpoint data) as part of the delivery payload
- Tracked via `mapMechServiceDeliveryCounts[multisig]`

### 6.3 Evaluation
- Deliver quality work that maintains or improves karma
- Karma must not decrease between checkpoints
- Tracked via `Karma.mapMechKarma[multisig]`

### 6.4 Outcome
- At least one delivery must complete the full round-trip (request → delivery → karma update)
- The staking contract checkpoints and verifies all four nonces moved

### 6.5 Epoch Timing

The client must be aware of the staking epoch length and checkpoint schedule. All four activities must complete within a single epoch for the service to be eligible for rewards.

## 7. Deployment Checklist

### Contracts (our side)

- [ ] Write `JinnActivityChecker.sol` — custom activity checker with 4-nonce composite
- [ ] Write tests for `JinnActivityChecker` (unit tests + integration with mock marketplace)
- [ ] Get Mech Marketplace and Karma contract addresses on Base
- [ ] Deploy `JinnActivityChecker` to Base
- [ ] Deploy `ServiceStakingToken` instance on Base with our activity checker
- [ ] Register staking contract as nominee in `VoteWeighting` on mainnet
- [ ] Lock OLAS as veOLAS and vote for the staking contract

### Client (Ritsu's side)

- [ ] Register Jinn service in Base service registry
- [ ] Implement request posting (creation)
- [ ] Implement delivery (restoration)
- [ ] Implement karma-aware delivery quality (evaluation)
- [ ] Implement epoch-aware scheduling (all 4 activities per epoch)
- [ ] Stake service into the staking contract
- [ ] Monitor checkpoint results and rewards

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Insufficient veOLAS votes → no emissions | Service operators unpaid | Bootstrap with team's own veOLAS; coordinate with aligned voters |
| Mech Marketplace contract changes | Activity checker reads break | Pin to known contract addresses; monitor for upgrades |
| Karma manipulation | False evaluation signals | Phase 0 accepts this risk (small community); Phase 1 adds proper evaluation |
| Epoch timing misalignment | Services miss checkpoint | Client implements buffer — complete activities early in epoch |
| Staking slots fill up | New operators can't join | Start with reasonable `maxNumServices`; deploy additional instances if needed |

## 9. Open Questions

1. **Exact MechMarketplace and Karma addresses on Base.** Need to confirm deployed contract addresses.
2. **Liveness ratio calibration.** What's a reasonable minimum activity rate? Needs experimentation.
3. **Service configuration.** What agent IDs, multisig config, and threshold to use for the Jinn service?
4. **veOLAS budget.** How much OLAS does the team have available to lock? This determines emission potential.
5. **Epoch length.** What checkpoint frequency works for the lifecycle? (OLAS default vs custom)
6. **Karma granularity.** Does the Karma contract on Base track per-service-multisig, or per-mech-address? This affects how `getMultisigNonces` queries it.
