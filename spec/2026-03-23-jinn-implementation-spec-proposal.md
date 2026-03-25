# Jinn Implementation Specification

> Version: 0.2.0-draft
> Date: 2026-03-24
> Author: Oak

This document describes how the Jinn protocol is implemented. It maps each stage of the protocol's training loop to concrete systems, defines the incentive architecture, and lays out a phased rollout.

## 1. Architecture Overview

```
┌─────────────────────────────────────────────┐
│           DAO (Ethereum Mainnet)             │
│                                             │
│  JINN Token    Treasury    ve-JINN Gauge    │
│       │            │             │          │
│       │      Epoch Emissions     │          │
│       │            │        Vote Weights    │
└───────┼────────────┼─────────────┼──────────┘
        │            │             │
   Canonical Bridges (OP Stack, Arbitrum, etc.)
        │            │             │
┌───────┼────────────┼─────────────┼──────────┐
│       ▼            ▼             ▼          │
│  Distribution Contracts (per chain)         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Creation │ │Restoration│ │Evaluation│    │
│  │ Rewards  │ │ Rewards   │ │ Rewards  │    │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘    │
│       │            │             │          │
│  Execution Layer (Base, Arbitrum, etc.)     │
│                                             │
│  ERC-8183: Jobs, escrow, evaluation         │
│  ERC-8004: Knowledge discovery, reputation  │
│  x402: Payment-gated knowledge access       │
└─────────────────────────────────────────────┘
```

## 2. DAO Layer

### 2.1 JINN Token

ERC-20 on Ethereum mainnet. Single canonical token with bridged representations on supported execution-layer chains.

### 2.2 Treasury

Holds the JINN supply. Emits tokens per epoch according to an emission schedule. The emission schedule and epoch length are governance parameters.

### 2.3 ve-JINN Gauge

Token holders lock JINN for ve-JINN. ve-JINN holders vote on how emissions are weighted across registered distribution contracts. This is how the DAO expresses its priorities — by directing incentives toward the contracts that embody the evaluation standards, incentive structures, and activity types it endorses.

- The DAO approves distribution contract factories — templates that define new types of distribution contract. Introduction of new factories is slow and precise.
- Once a factory is approved, instances can be deployed permissionlessly on any supported chain.
- Contracts receive emissions proportional to their vote weight.
- A contract with zero votes receives zero emissions.

### 2.4 Governance Surface

The DAO governs:

| Parameter | Change Frequency |
|---|---|
| Emission schedule, epoch length | Rare |
| Approved distribution contract factories | Rare |
| Challenge window parameters | Rare |

The governance surface is ultra-minimal. Parameters are set at launch and adjusted only under broad consensus with time-locks. Everything else is market-determined via the ve-JINN gauge.

### 2.5 Governance Evolution

Governance begins as a multisig and evolves toward full ve-JINN token-weighted participation as the token becomes widely distributed. At every stage, governance must satisfy:

- No unilateral control over parameters
- Time-locked changes
- Deterministic allocation given the same inputs
- Predictability for participants

## 3. Distribution Contracts

Distribution contracts are the DAO's instrument for directing incentives. Each contract:

- Defines who it pays (creators, restorers, evaluators)
- Defines what qualifying activity looks like (via its activity checker)
- Reads events from the execution layer to determine eligibility
- Distributes JINN to qualifying participants each epoch

The protocol defines four incentive channels: creation, restoration, outcome, and evaluation. Whether these map to four separate contracts or one contract with four channels handled by the activity checker is an open architectural decision — it determines whether the DAO steers *where* emissions go or *what kind of activity* is rewarded.

### 3.1 Creation Rewards

Pays participants who create desired states on the execution layer. Qualifying criteria are embedded in the contract — for example, "created a job on ERC-8183 that was subsequently attempted and positively evaluated." The DAO can fund contracts with stricter or looser creation standards and let the market discover which produces better training signal.

### 3.2 Restoration Rewards

Pays participants who attempt restoration, regardless of outcome. Qualifying criteria are defined by the activity checker — for example, structural checks on submitted evidence (minimum tool calls, minimum duration, interaction with the target system).

### 3.3 Outcome Rewards

Pays participants who achieve successful restoration — a positive evaluation. Outcome rewards should be significantly higher than restoration-only rewards to drive quality, not just volume.

### 3.4 Evaluation Rewards

Pays participants who perform evaluation on the execution layer. Qualifying criteria: participated in evaluation on an evaluation contract and, at N>1, aligned with consensus. This ensures evaluators are incentivised to participate and to evaluate honestly.

### 3.5 Market Dynamics

The market for evaluation quality lives in the gauge. ve-JINN holders choose which distribution contracts to fund. A contract with weak qualifying criteria (easy to game, low evaluation standards) attracts zero votes and receives zero emissions. A contract with credible criteria attracts votes and thrives.

Different distribution contracts can serve different execution environments (Base, Arbitrum, future chains), different marketplaces (OLAS Mech Marketplace, ERC-8183, MPP-compatible), and different incentive strategies. New contract types require DAO approval of a factory; instances of approved factories are deployed freely and compete for ve-JINN vote weight.

## 4. Execution Layer

### 4.1 Marketplace

The primary marketplace for the attempt lifecycle.

- Job creators post desired states with USDC escrow (demand signal)
- Restorers claim jobs, perform restoration, submit evidence
- Evaluator contracts verify whether the desired state was restored
- Escrow releases on positive evaluation

USDC in escrow is the marketplace-level settlement. It operates independently of JINN emissions. The fee can be small — its function is to signal genuine demand, not to be the primary incentive.

Phase 0 operates on the **OLAS Mech Marketplace** — the existing request/delivery infrastructure on Base. Requests represent desired states, deliveries represent restoration attempts and evaluations. The JinnRouter (see `2026-03-25-activity-checker.md`) mediates request creation and tracks per-role activity. ERC-8183 is a candidate for Phase 1+ as the marketplace evolves.

### 4.2 ERC-8004

Knowledge discovery and reputation.

- Restorers publish knowledge (artifacts) after attempting restoration
- Other participants search for and discover relevant knowledge
- Reputation is derived from evaluation record history
- Job creators can gate access by minimum reputation (e.g., minimum positive evaluations to attempt high-value states)
- Evaluator reputation may factor into quorum eligibility (per distribution contract)

### 4.3 x402

Payment-gated knowledge access. When a participant retrieves knowledge, x402 handles the payment to the knowledge creator according to the creator's terms. Denominated in USDC.

## 5. Incentive Model

Two layers, separated by concern:

### 5.1 Marketplace Layer (USDC)

- Demand signal — someone wants this state restored
- Flows through ERC-8183 escrow
- Job creator funds it and bears the risk
- Settlement is local to the execution environment
- Operates independently of protocol emissions
- The marketplace is the difficulty ratchet — external demand naturally escalates in ambition as the network proves itself

### 5.2 Protocol Layer (JINN)

- Network reward — the protocol incentivises participation in the training loop
- Distributed via distribution contracts from the mainnet treasury
- Four channels expressed through distribution contracts (§3.1–3.4)
- Relative weight between channels is determined by ve-JINN vote allocation

The separation means JINN emissions can flow even when marketplace fees are small. Early in the network, JINN is the primary incentive. As external demand grows, USDC marketplace fees become a larger share of total compensation. The transition from exploration (JINN-dominated) to exploitation (USDC-dominated) happens automatically as the emission schedule runs down.

## 6. Anti-Farming Decay

The network must avoid the degenerate equilibrium where operators farm the easiest restorable state indefinitely, collecting JINN without the network developing new capability.

### 6.1 Mechanism

When a restoration succeeds, the evidence submitted (structured execution checkpoints — see §7.1) is hashed via locality-sensitive hashing. The activity checker maintains hashes of prior successful evidence. If the new evidence is similar to prior work, the JINN emission reward decays. Novel evidence earns full reward.

The decay is deterministic, on-chain (LSH produces a bytes32), and scales — no vector search, no LLM, no corpus comparison.

**Decay applies only to protocol emissions (JINN), never to marketplace fees (USDC).** The USDC escrow cares about "was the state restored," not about novelty. This ensures operators are always paid for real work via the marketplace, while JINN emissions are directed toward work that expands the network's capability.

### 6.2 Parameters

- LSH scheme, similarity threshold, and decay curve are set in the activity checker
- Parameters are adjustable by the DAO (via deploying new contracts or updating activity checkers)
- These need experimentation — potentially on testnet first

### 6.3 Why Not Other Approaches

Three alternatives were considered and rejected:

- **DAO-managed curriculum**: centralised busywork, defeats autonomy
- **Pure economic pressure**: doesn't prevent farming — operators get 10x better at the same easy problem
- **Evaluator-assessed difficulty**: circular and unscalable

## 7. Evidence Integrity

### 7.1 Evidence Format

Evidence is structured checkpoint data captured by the client harness during restoration: tool calls, API requests, state observations. The activity checker defines the canonical checkpoint schema — what fields are captured, how they are normalised before LSH.

Checkpoints are submitted as-is at launch. LSH is tolerant of superficial reformatting by design — minor reordering or paraphrasing produces similar hashes. An operator would need to substantially restructure their evidence to evade decay, which at small network scale is detectable through community oversight and evaluator review.

### 7.2 Phased Integrity

Evidence integrity improves over time as the network grows and the threat model changes.

**Phase 0–1: Optimistic evidence with challenges.**

Operators submit structured checkpoint evidence without proofs. The evaluation layer confirms states are actually restored. Anyone can challenge the authenticity of evidence within a window — if challenged, the operator must produce a ZK proof for the disputed checkpoints. Failure to prove results in loss of the emission reward. Challengers post a bond and earn a reward if the challenge succeeds.

This is sufficient for early phases because:
- The operator community is small and known — farming is visible
- The evaluation layer already catches operators who don't do real work
- LSH tolerates superficial evidence reformatting
- Challenge-based verification is proven in production (Morph's Responsive Validity Proof)
- Zero proving cost in the happy path

**Phase 2+: ZK-proven checkpoints.**

As the network grows — more operators, higher JINN value, greater anonymity — proactive ZK proving replaces optimistic evidence. The architecture:

1. Agent runs freely — any model, any harness, any strategy. Execution is unconstrained.
2. The harness captures checkpoints at meaningful operations.
3. For external interactions (API calls, state reads), zkTLS attests that the data came from a real server interaction.
4. A zkVM guest program (SP1, RISC Zero, or future alternatives) proves claims about the checkpoint data and commits a hash.
5. The activity checker verifies the proof on-chain (~250k gas on L2) and runs LSH on the proven checkpoint sequence.

The transition from optimistic to ZK is non-breaking: the evidence schema is the same, the LSH comparison is the same, the activity checker just gets more trustworthy inputs. New distribution contracts can require ZK evidence via their activity checkers — the gauge determines whether the network shifts to ZK-requiring contracts.

## 8. Evaluation Mechanism

### 8.1 Evaluator Pool

Evaluators are drawn from a reputation-gated pool via ERC-8004. A single evaluator is randomly assigned per job at launch (N=1). The evaluator verifies whether the desired state was restored and produces an evaluation record.

Role independence is enforced by the evaluation contract: the evaluator must not be the creator or restorer on the same desired state.

### 8.2 Evolution to Quorum

As the evaluator pool matures, N increases. Consensus among multiple evaluators determines the result. Evaluators who consistently disagree with consensus lose reputation. Commit-reveal prevents copycat evaluations. These mechanics are designed when N>1 is imminent — they add complexity without benefit at N=1.

## 9. Clients

Operators run client software to participate in the network. The protocol and implementation are agnostic to client choice — multiple clients are expected to emerge independently.

The first client includes:
- Agent harness with checkpoint capture for evidence submission
- x402 artifact serving for knowledge monetisation
- ERC-8004 integration for discovery and reputation

An operator's selection of model, harness, and strategy determines their competitive position. Knowledge sharing and compounding are client-level features, not protocol-enforced. Client development is not a DAO responsibility.

## 10. Domain-Specific Contracts

An optional DAO training strategy, not a launch requirement. The system supports deploying distribution contracts scoped to specific domains (web infrastructure, data pipelines, monitoring, etc.):

- ve-JINN holders vote weight toward domains they want the network to develop
- Saturated domains lose votes naturally; new domains attract votes
- No governance vote needed to add a domain — just deploy and attract votes

When used, each domain naturally progresses: new (high emissions, diverse approaches) → maturing (proven approaches, emissions moderate) → mature (USDC demand strong) → commodity (pure marketplace economics).

## 11. Cross-Chain Distribution

- Treasury on mainnet emits JINN per epoch
- Canonical bridges (OP Stack native, Arbitrum native) move JINN to distribution contracts on each supported chain
- Distribution contracts are pre-funded 2 epochs ahead to absorb bridge latency
- Participants claim locally on their execution-layer chain — no mainnet interaction required
- Which chains receive emissions and in what proportion is determined by ve-JINN vote weights on the contracts deployed to those chains

## 12. Identity and Reputation

- ERC-8004 provides portable reputation across execution environments
- Reputation is derived from evaluation record history
- Job creators can require minimum reputation to gate access to high-value desired states
- No staking required for restorers — evaluation is the gate

## 13. Phased Rollout

### Phase 0 — Prove on OLAS

- Operate within the OLAS ecosystem using existing contracts
- OLAS staking contracts for distribution infrastructure
- Build Jinn-specific activity checkers (JinnRouter) that read Mech Marketplace request and delivery counters
- Validate the full training loop end-to-end: creation → restoration → evaluation → knowledge → improved restoration
- Single execution environment (Base)
- No JINN token — use OLAS mechanisms as-is
- Optimistic evidence — structured checkpoints, no ZK requirement
- Goal: prove the loop works, identify gaps

### Phase 1 — JINN Token and DAO

- Fair-launch JINN on Ethereum mainnet
- Deploy DAO governance (multisig initially, evolving to ve-JINN)
- Fork minimal OLAS contract surface:
  - Treasury and dispenser (emission logic with JINN)
  - VoteWeighting / gauge (ve-JINN allocation)
  - Cross-chain bridge contracts
  - Distribution contract template
  - Deprecate: bonding, service registries, developer rewards, protocol-owned liquidity
- Deploy first distribution contracts on Base
- USDC in ERC-8183 escrow for marketplace settlement
- JINN emissions on top via distribution contracts
- Anti-farming decay active in activity checkers
- Challenge mechanism live for evidence disputes

### Phase 2 — Multi-Environment

- Additional execution environments (Arbitrum, others)
- New distribution contracts with environment-specific qualifying criteria
- Gauge voting becomes meaningful as environments and contract types compete for emissions
- External demand grows: entities beyond the DAO posting desired states with USDC
- ve-JINN governance broadens as token distribution widens
- ZK-requiring distribution contracts deployed — gauge determines adoption

### Phase 3 — Autonomous

- Full ve-JINN governance
- Multiple competing distribution contracts per environment and per incentive channel
- External USDC revenue exceeds JINN emissions as primary incentive
- DAO role is minimal: emission schedule parameters
- Creation, restoration, and evaluation are fully market-driven
- ZK evidence integrity is standard — optimistic contracts have lost gauge weight

## Open Questions

**One contract vs four.** Whether the four incentive channels map to four separate contracts or one contract with four channels in the activity checker. This determines whether the DAO steers *where* emissions go or *what kind of activity* is rewarded.

**Evidence schema.** What fields constitute the canonical checkpoint format. What normalisation is applied before LSH. This is the central design decision of the anti-farming mechanism — everything downstream depends on it. Must be resolved before testnet.

**LSH parameters.** Hashing scheme, similarity threshold, decay curve. Need experimentation on testnet.

**Challenge mechanism design.** Challenge window duration, bond size, challenger reward structure. Must be designed to avoid griefing.

**Evaluation quorum.** When to move from N=1 to N>1. How to manage the evaluator pool. Commit-reveal design deferred until N>1 is imminent.
