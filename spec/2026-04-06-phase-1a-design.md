# Phase 1a Design: JINN Token + DAO + Distribution (Testnet)

> Version: 0.1.0-draft
> Date: 2026-04-06
> Author: Oak, Claude

> **Status (2026-05-01): superseded for forward planning.** Phase 1a as
> described here shipped on Sepolia + Base Sepolia. The Phase 1b roadmap
> in §9 of this document is **subsumed by the Phase A umbrella** under
> the knowledge-market substrate framing ratified in DR-2026-04-30.
> Anti-farming decay, ve-JINN deployment, and full client integration on
> testnet are already shipped; evidence-schema work is executing through
> Phase A.1; the residual challenge mechanism is re-homed to Phase B.2.
> No structural conflict — the kill criterion in DR-2026-04-30 §"Door
> type and reversibility" does not trip.
>
> **For current roadmap, read instead:**
>
> - `spec/2026-04-30-phase-a-umbrella.md` — Phase A.1 spec (the active
>   operational frame)
> - `docs/superpowers/plans/2026-04-30-phase-a-umbrella-plan.md` —
>   implementation plan
> - `log/decisions/2026-04-30-knowledge-market-vision-framing.md` —
>   DR-2026-04-30 (six framing choices)
> - GitHub Discussion [#59](https://github.com/Jinn-Network/mono/discussions/59)
>   — *Jinn as the knowledge market — implementation roadmap proposal*
>   (substrate vision)
> - GitHub Discussion [#57](https://github.com/Jinn-Network/mono/discussions/57)
>   — *Unified GTM around the Prediction SolverNet* (paired GTM)
>
> The body of this document is preserved unchanged as a historical record
> of the Phase 1a deployment and the Phase 1b transition plan as
> originally framed.
>
> Update (2026-06-30): the JINN-token tokenomics described here is now dropped entirely by DR-2026-06-30 (tokenless, OLAS-native) — not re-roadmapped. See `spec/2026-06-30-tokenless-olas-native.md`.

## 1. Overview

Phase 1a deploys the core JINN tokenomics stack on testnet (Sepolia + Base Sepolia) by forking OLAS contracts with minimal or zero modifications. The goal is a working token → treasury → bridge → distribution flow that can be stood up, torn down, and redeployed cheaply until it feels solid.

Phase 1a defers ve-JINN gauge voting. Emission weights are set by a multisig. Phase 1b adds ve-JINN locking and gauge voting on top of the working foundation.

## 2. Design Principles

1. **Fork, don't write from scratch.** OLAS contracts are battle-tested. Redeploy with config changes where possible. Where interface dependencies require it, deploy no-op stub contracts. Only modify contract code as a last resort.
2. **Testnet iteration.** Deploy to Sepolia + Base Sepolia. Redeploy as many times as needed. Move to mainnet only when confident. May deploy a test version on mainnet but ideally won't need to.
3. **Staged complexity.** Get the basic emission/distribution flow working before adding gauge voting. A multisig setting weights is functionally identical for testing purposes.

## 3. Components

### 3.1 JINN Token (Sepolia)

Fork the OLAS ERC-20 token contract. Deploy on Sepolia with:
- Name: "Jinn" / Symbol: "JINN"
- Mint authority assigned to the Treasury contract
- No other modifications expected — the OLAS token contract is a standard ERC-20 with owner-gated minting

**Source:** `github.com/valory-xyz/autonolas-governance` — OLAS token contract

### 3.2 Treasury + Dispenser (Sepolia)

Fork OLAS Treasury and Dispenser contracts. These manage epoch-based emissions and distribution to approved targets.

**What we use:**
- Epoch timing and advancement (`checkpoint()`)
- Emission per epoch accounting
- Distribution to approved staking/distribution targets
- Ownership and governance patterns

**What we don't use (but may leave in place):**
- Bonding / Depository integration
- Component/agent registry lookups for developer rewards
- Donator top-up mechanisms
- IDF (inverse discount factor) calculations

**Key question to resolve during implementation:** Can these unused features be left dormant (never called, zero-address dependencies), or do they revert during epoch advancement? If they revert, either deploy no-op stub contracts satisfying the interfaces, or make targeted surgical removals.

**Configuration:**
- Epoch length: governance-settable (start with 1 week for fast iteration on testnet)
- Emission rate: governance-settable flat rate per epoch
- Channel weights: four weights (creation, restoration, outcome, evaluation) summing to 100%, set by the multisig via Dispenser configuration

**Source:** `github.com/valory-xyz/autonolas-tokenomics` — Treasury.sol, Dispenser.sol, Tokenomics.sol

### 3.3 Governance (Sepolia)

OpenZeppelin TimelockController with a Safe multisig as proposer/executor. No custom governance contracts needed for Phase 1a — this is standard infrastructure.

The multisig controls:
- Treasury emission rate
- Distribution channel weights
- Approved distribution targets
- Epoch length (if adjustable)

Time-lock delay: short on testnet (e.g., 1 hour), longer on mainnet.

### 3.4 Cross-Chain Bridge (Sepolia → Base Sepolia)

JINN must flow from Sepolia (L1) to Base Sepolia (L2) for distribution.

**Approach:** Fork the OLAS DepositProcessor (L1) and TargetDispenser (L2) bridge adapter contracts. These use the OP Stack canonical bridge (StandardBridge) which operates on Sepolia ↔ Base Sepolia.

Alternatively, use the OP Stack StandardBridge directly with a bridged JINN token representation on Base Sepolia. Whichever approach the OLAS contracts already implement with less friction wins.

The Treasury/Dispenser pre-funds distribution contracts 1-2 epochs ahead to absorb bridge latency.

**Source:** `github.com/valory-xyz/autonolas-tokenomics` — DepositProcessorL1.sol, OptimismTargetDispenserL2.sol (or similar)

### 3.5 Distribution / Staking Contract (Base Sepolia)

Receives bridged JINN and distributes to qualifying participants based on activity.

**Approach:** Deploy an OLAS-pattern staking contract on Base Sepolia that accepts JINN instead of OLAS. Point it at a JinnRouter-pattern activity checker that tracks the four activity dimensions (creation, restoration delivery, evaluation creation, evaluation delivery).

The existing JinnRouter contract architecture (deployed on Base mainnet for Phase 0) serves as the template. For testnet, deploy fresh instances of both the staking contract and the activity checker.

**Activity checker interface** (already proven in Phase 0):
- `getMultisigNonces(multisig)` → `[safeNonce, creationCount, restorationDeliveryCount, evalCreationCount, evalDeliveryCount]`
- `isRatioPass(curNonces, lastNonces, ts)` → bool

**Staking parameters** (testnet defaults, adjustable):
- Minimum staking deposit: TBD (lower than mainnet for testing convenience)
- Liveness period: 86,400s (1 day)
- Rewards per second: TBD based on emission rate
- Max services: 100

**Source:** `github.com/valory-xyz/autonolas-registries` — StakingBase.sol and related; existing JinnRouter.sol at `legacy/jinn-cli-agents-reference/contracts/staking/JinnRouter.sol`

### 3.6 Client Updates

Minimal changes to the existing client daemon:

- **Testnet chain config:** Add Sepolia + Base Sepolia RPC URLs, contract addresses alongside existing Base mainnet config. Config key `network: "testnet" | "mainnet"` or separate address sets.
- **JINN reward claiming:** New function in the earning module that calls the distribution/staking contract to claim JINN rewards. Mirrors the existing OLAS staking claim pattern.
- **No changes to daemon loops.** The creator, restorer, and delivery-watcher loops already generate the activity that earns rewards. They just need to point at testnet contract addresses.

## 4. Dependency Graph

```
JINN Token (Sepolia)
    │
    ▼
Treasury + Dispenser (Sepolia)
    │         │
    │    TimelockController + Safe Multisig
    │
    ▼
DepositProcessor (Sepolia, L1 bridge adapter)
    │
    │  OP Stack Canonical Bridge
    │
    ▼
TargetDispenser (Base Sepolia, L2 bridge adapter)
    │
    ▼
Staking Contract (Base Sepolia)
    │
    ▼
Activity Checker / JinnRouter (Base Sepolia)
    │
    ▼
Client Daemon (points at testnet addresses)
```

## 5. What Phase 1a Does NOT Include

- **ve-JINN locking and gauge voting** — deferred to Phase 1b. Multisig sets weights directly.
- **Anti-farming LSH decay** — deferred. Activity checker uses simple liveness ratio (same as Phase 0).
- **Challenge mechanism** — deferred. Optimistic evidence continues.
- **Evidence schema standardization** — deferred.
- **Fair-launch token distribution** — deferred to Phase 2 (mainnet launch). Testnet tokens are free.
- **Multi-chain beyond Base** — single L2 (Base Sepolia) for Phase 1. Multi-chain is Phase 2.

## 6. Deployment Script

A single script that stands up the entire Phase 1a stack end-to-end:

1. Deploy JINN token on Sepolia
2. Deploy Treasury + Dispenser on Sepolia (with any required stub contracts)
3. Deploy TimelockController + configure multisig
4. Deploy bridged JINN representation on Base Sepolia (if needed beyond OP Stack default)
5. Deploy DepositProcessor on Sepolia + TargetDispenser on Base Sepolia
6. Deploy staking contract + activity checker on Base Sepolia
7. Configure Treasury → bridge → staking flow
8. Mint initial JINN supply to Treasury
9. Run a simulated epoch: generate activity via client, advance time (on testnet), trigger epoch checkpoint, verify JINN distributed to staking contract, claim rewards

This script is the "redeploy the whole thing" button — tear down, redeploy, iterate.

## 7. Success Criteria

Phase 1a is complete when:

1. JINN token deployed on Sepolia with Treasury as mint authority
2. Treasury emits JINN per epoch on schedule
3. JINN bridges from Sepolia to Base Sepolia via canonical bridge
4. Staking contract on Base Sepolia receives bridged JINN
5. Client daemon generates activity on Base Sepolia (create, restore, evaluate)
6. Activity checker confirms liveness
7. Participant claims JINN rewards from staking contract
8. Multisig can adjust emission rate and channel weights
9. Full cycle repeatable: redeploy, generate activity, earn JINN

## 8. Open Questions for Implementation

1. **OLAS contract surgery scope.** How many OLAS contract dependencies can be satisfied with zero-addresses vs. requiring stub contracts? Determined by reading the actual epoch advancement code paths.
2. **Bridge token representation.** Does the OP Stack StandardBridge on Sepolia handle custom ERC-20s out of the box, or do we need a custom bridge adapter?
3. **Staking contract token swap.** The OLAS staking contracts reference OLAS token addresses. Is this a constructor param (easy swap) or hardcoded (requires fork)?
4. **Testnet faucets.** Sepolia ETH is needed for deployment and testing. Base Sepolia ETH for L2 operations. Availability and rate limits may affect iteration speed.

## 9. Transition to Phase 1b

Once Phase 1a is stable:

- Fork veOLAS as veJINN (vote-escrow locking)
- Fork VoteWeighting (gauge contract)
- Replace multisig-set weights with gauge-voted weights
- The Treasury/Dispenser already support this — the gauge just provides the weight inputs that the multisig was setting manually
