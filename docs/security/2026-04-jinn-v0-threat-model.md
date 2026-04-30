# Jinn v0 — Threat Model (pre-testnet review)

> Status: **v0 pre-testnet review**
> Date: 2026-04-27
> Branch: `jinn-mono/jinn-mono-zwj` (forked from `jinn-mono/jinn-mono-1bo`)
> Issue: bd `jinn-mono-sz0`
> Related:
> - [`2026-04-jinn-v0-slither.md`](./2026-04-jinn-v0-slither.md) — Slither static analysis pass
> - [`2026-04-v2-checker-audit.md`](./2026-04-v2-checker-audit.md) — V2 checker audit findings (B' hardening)
> - `cargo/spec/2026-04-06-phase-1a-design.md` — Phase 1a design lock
> - `cargo/docs/planning/2026-04-cross-chain-claim-spec.md` — A4 cross-chain spec
> - `cargo/docs/planning/2026-04-olas-staking-reward-semantics.md` — Architecture B / v3 lock

## 1. Scope and methodology

### 1.1 Contracts in scope

This threat model covers the bespoke v0 contracts that will be deployed for the Jinn minimum-viable issuance (MVI) testnet milestone. v0 is **not** a mainnet release — it targets Sepolia (JINN chain) and Base Sepolia (measurement chain). Mainnet hardening, formal verification, and a third-party auditor pass are **out of scope** for this review and are explicitly gated on later milestones.

| Contract | Path | Purpose |
|---|---|---|
| `JINN` | `cargo/contracts/src/jinn/token/JINN.sol` | OZ ERC20Votes + ERC20Permit + Ownable2Step + ERC-6372 timestamp clock + minter pattern |
| `JinnDistributor` | `cargo/contracts/src/jinn/distribution/JinnDistributor.sol` | Sole minter; weighted-snapshot per-channel + operator/DAO ratio + monotonic per-service accumulators |
| `JinnGovernor` | `cargo/contracts/src/jinn/governance/JinnGovernor.sol` | OZ Governor module composition (Settings, CountingSimple, Votes, QuorumFraction, TimelockControl) |
| `JinnClaimEmitter` | `cargo/contracts/src/jinn/cross-chain/JinnClaimEmitter.sol` | Stateless event emitter on Base; reads V2 checker + V2 router + ServiceRegistry |
| `CanonicalOpStackMessenger` | `cargo/contracts/src/jinn/cross-chain/CanonicalOpStackMessenger.sol` | OP-Stack storage-proof verification: DisputeGameFactory lookup + finality airgap, output-root preimage check, emitter account proof, `claimSnapshotHashes[claimId]` storage proof, and snapshot tuple binding. |
| `MockMessenger` | `cargo/contracts/src/jinn/cross-chain/MockMessenger.sol` | Owner-controlled fixture; insecure by design; testnet/dev only |
| `IClaimMessenger` | `cargo/contracts/src/jinn/interfaces/IClaimMessenger.sol` | Interface contract for messenger implementations |
| `RestorationActivityCheckerV2` | `cargo/contracts/src/staking/RestorationActivityCheckerV2.sol` | V2 hardening — `verifiedCreations` mapping, C4 access control, C1 circular buffer |
| `JinnRouterV2` | `cargo/contracts/src/staking/JinnRouterV2.sol` | V2 hardening — `creators` mapping + creator passing |

### 1.2 Trust model — who can do what at v0

The trust model assumed throughout this document:

- **Multisig (3-of-N)** — initial owner of `JINN`, `JinnDistributor`, and `RestorationActivityCheckerV2`. Holds privileged setters (`setMinter`, `setMessenger`, `setRatios`, `setWeights`, `setAntifarmingParameters`, `setRouterAddresses`). Multisig is **temporary**; it transfers ownership to the JinnGovernor's TimelockController during Phase A6.
- **TimelockController** — post-handover owner of all governance-controlled state. Minimum delay: 48h on testnet, intended to be 7d on mainnet. Only a successful Governor proposal can queue an operation. The Timelock is also the canonical `daoTreasury` recipient on the distributor.
- **JinnGovernor** — sole proposer/canceller into the Timelock. Voting power is sourced from JINN's ERC20Votes checkpoints in **timestamp** mode. Quorum is a fraction of `totalSupply` at the proposal block (4% targeted; configurable at deploy).
- **Distributor** — sole `minter` of JINN post-handover. Cannot mint without a successful `IClaimMessenger.verifyClaim` and a delta against the per-service accumulators. Has no external admin surface beyond the Governor-mutable setters.
- **Restorer / evaluator services** — OLAS service multisigs (Safe). They run the off-chain Jinn loop, call the V2 router on Base, and receive operator-share JINN mints on the JINN chain. They are **not trusted** beyond the cryptographic guarantees of the OLAS service registry and Mech marketplace.
- **External relayers / claimers** — anyone who pays gas to call `JinnClaimEmitter.emitClaim` on Base or `JinnDistributor.claim(proof)` on the JINN chain. Permissionless. The mint always routes to the recovered `multisig` and `daoTreasury`, regardless of the caller, so paying gas is a service to the operator, not a privilege.

### 1.3 Out of scope

- **Vendored OLAS** (`cargo/contracts/src/vendor/**`) — covered by upstream OLAS audits. Reused without modification for v0.
- **MechMarketplace, ServiceRegistry, OLAS staking contract** — third-party, deployed and operated by OLAS. We assume they behave as documented and as they do on Base mainnet.
- **The Optimism dispute game and OptimismPortal2** — third-party (OP Stack canonical contracts). The messenger trusts these contracts to surface honest L2 output roots after a finalised dispute.
- **Off-chain Jinn client + relayer infra** — operational risks are documented but cryptographic guarantees do not depend on them.
- **Mainnet deployment** — mainnet ships under a separate security gate (full external audit, formal verification on JinnDistributor, locked-in messenger).

### 1.4 Methodology

For each attack we record:

- **Attack** — concrete adversary and goal.
- **Severity** — Critical / High / Medium / Low / Informational. Severity is the v0 testnet-deploy severity, not the mainnet severity (which is universally one notch higher).
- **Pre-conditions** — what the adversary must already have (capital, keys, position).
- **Mitigation in v0** — what protects us today.
- **Residual risk** — what remains uncovered after the v0 mitigations apply.

---

## 2. Attack surface map

```
                          ┌─────────────────────────────┐
                          │       JinnGovernor          │
                          │  (proposer + canceller)     │
                          └───────────────┬─────────────┘
                                          │ propose / queue / execute
                                          ▼
                          ┌─────────────────────────────┐
                          │     TimelockController      │
                          │  (executes governance ops)  │
                          └───────────────┬─────────────┘
                                          │ post-handover owner of:
              ┌───────────────────────────┼───────────────────────────────┐
              │                           │                               │
              ▼                           ▼                               ▼
    ┌──────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
    │       JINN       │◄─────┤   JinnDistributor    │      │  RestorationActivity │
    │ (ERC20Votes,     │ mint │  (sole minter, per-  │      │   CheckerV2 (Base)   │
    │  ERC-6372 ts,    │      │   svc accumulators)  │      └──────────────────────┘
    │  Ownable2Step)   │      └──────────┬───────────┘
    └──────────────────┘                 │ verifyClaim(proof)
                                         ▼
                          ┌─────────────────────────────┐
                          │      IClaimMessenger        │
                          │ ┌────────────┬────────────┐ │
                          │ │ Canonical  │ Mock       │ │
                          │ │ OpStack    │ Messenger  │ │
                          │ │ Messenger  │ (testnet)  │ │
                          │ └────────────┴────────────┘ │
                          └────────────┬────────────────┘
                                       │ verifies OP storage snapshot vs dispute game
                                       ▼
                          ┌─────────────────────────────┐
                          │   JinnClaimEmitter (Base)   │
                          │  reads V2 checker, V2       │
                          │  router, ServiceRegistry    │
                          └─────────────────────────────┘
```

The single asymmetry across the architecture is: the JINN chain (Sepolia in v0) **mints**; the measurement chain (Base Sepolia) **counts**. Replay protection lives entirely on the minting chain (per-service monotonic accumulators inside the distributor). The messenger is required to be stateless. The emitter is required to be stateless. Adversaries must therefore either (a) compromise governance, (b) forge a proof, or (c) inflate the counts on the measurement chain.

The next four sections work through each attack class in turn.

---

## 3. Governance attacks

### 3.1 Proposal spam

- **Attack**: an adversary spams the Governor with proposals, hoping to drown out legitimate proposals or grief node operators who have to vote against each one.
- **Severity**: **Low**.
- **Pre-conditions**: any address can call `propose()` because `proposalThreshold = 0` is set at deploy under the v0 design. No JINN balance is required.
- **Mitigation in v0**:
    - **Voting delay (172,800 s = 48h on testnet, 7d on mainnet planned)** — every proposal has to wait this long before voting opens. Spam proposals never reach a state where they can do damage; they can be ignored.
    - **Voting period (5 days planned)** — proposals expire if quorum isn't met.
    - **Gas cost** — every spam proposal still costs the proposer gas. With nothing to gain (no proposal succeeds without quorum) the attack has no payoff.
    - **Off-chain triage** — node operators are expected to filter the proposal queue at the UI layer (subgraph / Tally-style indexer). This is a UX problem, not a protocol problem.
- **Residual risk**: noise in the proposal indexer. No on-chain damage. If the indexer becomes a load-bearing dependency at mainnet, raise `proposalThreshold` to a non-zero value or add a sponsorship fee.

### 3.2 Quorum manipulation through early-supply concentration

- **Attack**: a small group of early-distribution recipients realises they jointly hold > 4% of `totalSupply` and can reach quorum on a hostile proposal before broader distribution dilutes them.
- **Severity**: **High** (testnet is acceptable; mainnet would block deploy).
- **Pre-conditions**:
    - The adversary holds > `quorumFraction * totalSupply(proposalBlock)` voting power AND has it self-delegated (ERC20Votes requires explicit delegation).
    - The adversary either authors the hostile proposal themselves or finds one already queued.
    - Pre-distribution circulating supply is small enough that a few wallets cross 4%.
- **Mitigation in v0**:
    - **Quorum is taken at the proposal block**, not at execution. An adversary who acquires > 4% mid-vote does NOT retroactively gain quorum. They have to time-travel to the proposal block.
    - **Voting delay (48h)** — gives operators 48h to notice a hostile queue and respond (transfer to a higher-quality voter, propose a counter-proposal, etc.) before voting opens.
    - **Timelock delay (48h)** — even if the proposal passes, there is a 48h window between queue and execute where the multisig (still the owner of `JinnDistributor` in early Phase A) can intervene by upgrading the messenger or pausing emissions.
    - **Initial distribution is heavily over-collateralised by the 6/8 multisig.** During Phase A6 the multisig is the sole owner of every privileged setter; the Governor is bootstrapped but does not have keys yet. The Phase A → B handover is documented in the deploy script and will be executed only when distribution is broad enough that the 4% bar is meaningful.
    - **Vote token is timestamp-mode (ERC-6372)**, so flash-loaning JINN votes is not possible (any voting power requires a delegation that was committed before the proposal block — no spot-balance vote).
- **Residual risk**:
    - During Phase A6 → B handover, there is a transition window where ownership has been transferred to the Timelock but distribution is still narrow. We manage this by keeping the multisig as `proposer` on the Timelock for a 21-day cooldown post-handover. This is an operational mitigation, not a contract one — the contract grants no special role to the multisig after `acceptOwnership()` runs on the Timelock.
    - **Action item**: the multisig must NOT relinquish its `PROPOSER_ROLE` on the Timelock until distribution diversifies. Track via a runbook checklist; flagged in §6.

### 3.3 Timelock bypass

- **Attack**: an adversary tries to execute a privileged operation directly, bypassing the Timelock delay.
- **Severity**: **Critical** (would invalidate the entire governance design).
- **Pre-conditions**: knowledge of the contracts, attempt to call any owner-only setter directly.
- **Mitigation in v0**:
    - All privileged setters (`setMinter`, `setMessenger`, `setRatios`, `setWeights`, `setAntifarmingParameters`, `setRouterAddresses`) carry `onlyOwner` (or `OwnerOnly` revert) modifiers. After Phase A6 handover, `owner()` returns the Timelock address.
    - The Timelock executes operations only after the configured delay has elapsed. There is no admin role on the Timelock that can shortcut this delay. The OZ `TimelockController` admin-renounce path is part of the deploy script: post-handover, `DEFAULT_ADMIN_ROLE` is renounced so neither the multisig nor any deployer EOA can bypass.
    - The Governor is the sole `PROPOSER_ROLE` holder and the sole `EXECUTOR_ROLE` holder (apart from the temporary 21-day multisig override on `PROPOSER_ROLE` from §3.2).
- **Residual risk**:
    - If the deploy script is mis-configured and `DEFAULT_ADMIN_ROLE` is **not** renounced, an attacker who compromises the deployer EOA inherits a Timelock admin. **Action item**: post-deploy verifier script must check `getRoleMemberCount(DEFAULT_ADMIN_ROLE) == 0`. Track in the deploy runbook.
    - The Governor's own `_executor()` is `address(this)` per OZ default — meaning Governor calls itself before delegating to the Timelock. This is the OZ-blessed pattern and has been audited extensively at the Governor contract level.

### 3.4 Compromise of a JINN holder with majority voting power

- **Attack**: an adversary steals a private key (phishing, key compromise, social engineering) of a JINN holder who controls majority delegated voting power.
- **Severity**: **Critical** at mainnet; **High** at testnet (no real value at stake).
- **Pre-conditions**: a single-key counterparty controls a majority of delegated voting power. We avoid this by encouraging multisig delegation and broad distribution.
- **What is recoverable**:
    - **Future emissions**: a successful counter-proposal can `setRatios(0, 0)` and `setWeights(0, 0, 0)` after the hostile proposal's execution. The Timelock delay (48h) is a recovery window — the legitimate community has at least 48h to organise.
    - **Cross-chain mint flow**: a counter-proposal can `setMessenger(address(0))` (rejected by the zero-check) — instead, the counter-proposal points the messenger at a trusted no-op messenger contract. Until that proposal executes, the existing minted entitlement keeps moving forward.
    - **Future emissions (alternative)**: revoke the distributor's mint role by calling `JINN.setMinter(address(newDistributor))` or a no-op address. This is a one-line proposal.
- **What is NOT recoverable**:
    - **Already-minted JINN held in the attacker's wallet.** ERC20 has no clawback; we cannot un-mint.
    - **Already-issued voting power that was used on the hostile proposal.** Once the proposal passed and executed, the on-chain effects are observed. We can roll forward (counter-proposal) but not roll back.
- **Mitigation in v0**:
    - The distribution plan (Phase A) targets 8+ independent multisig recipients in the initial allocation, with no single party exceeding 25% of allocation. This makes single-key compromise insufficient for unilateral quorum.
    - Voting power requires explicit ERC20Votes delegation. Tokens sitting in cold storage or in a Safe without a delegation choice are non-voting. This is a mechanical mitigation — passive holders do not contribute to a hostile quorum.
    - The 48h timelock + 48h voting delay gives a 96h total window between proposal creation and earliest execution. Standard incident-response practice (key rotation, social mobilisation) applies.
- **Residual risk**:
    - Mainnet readiness requires concrete commitments on initial distribution diversity and on a public response runbook. Both are out of v0 scope. Track under the mainnet readiness gate.

### 3.5 Hostile `setMessenger` swap

- **Attack**: an adversary executes a hostile Governor proposal (or compromises the multisig pre-handover) to swap the `JinnDistributor.messenger` to either `MockMessenger` (which lets the messenger owner mint at will) or to an attacker-controlled implementation that reports inflated counters.
- **Severity**: **High** at mainnet; **Medium** at testnet.
- **Pre-conditions**:
    - Either:
        - (a) Attacker controls the multisig before Phase A6 handover, OR
        - (b) Attacker has won a Governor proposal that calls `setMessenger(attackerMessenger)`.
    - Attacker has deployed an `IClaimMessenger` implementation that, on `verifyClaim`, returns arbitrary high counters for arbitrary multisigs.
- **Mitigation in v0**:
    - **18-day observation window before each proposal can take effect** — at v0 testnet timing this collapses to roughly 4 days (48h voting delay + 5 day voting period + 48h timelock + safety margin). On mainnet the design intent is 7 day delay + 14 day voting period + 7 day timelock = 28 days. The "18 day" figure in the testnet deploy reflects the current compressed schedule. During this window, anyone can call `JinnGovernor.cancel(...)` *if* they already have a ready-to-cancel role, but the more reliable mitigation is to upgrade the multisig's response posture: call `setMessenger(trustedNoOpMessenger)` themselves before the hostile proposal can execute.
    - **`MockMessenger` is testnet-only**. The Phase 1a deploy script never deploys `MockMessenger` on Sepolia mainnet. The contract is `internal` to the test fixture set; if it were ever deployed on mainnet, it is owner-controlled, and the owner is by deploy-time convention the same address that owns the Distributor — which after handover is the Timelock, which can only be reached via a successful Governor proposal anyway. Net: deploying it on mainnet adds no new attack surface beyond what governance compromise already grants.
    - **Per-channel weights are independent.** A hostile messenger that returns inflated `verifiedCreations` can be neutralised by a counter-proposal that sets `wCreation = 0`. Disabling each channel takes one `setWeights` call. In the limit, `setWeights(0, 0, 0)` halts all minting without breaking the contract surface.
    - **Per-service accumulators are sticky.** Even after a hostile mint, the high-water mark is recorded — replaying the same proof or downgrading the messenger does not unmint. The mitigation is forward-looking only.
    - **Distributor `claim()` is permissionless and idempotent** — there is no admin path to replay a claim, only to set future mint policy.
- **Residual risk**:
    - Inflated mints **between** the hostile execution and the counter-proposal's execution are not recoverable by contract. The defender must lean on the timelock delay to organise, and on tradable JINN being valueless in early testnet (so the dollar damage is bounded).
    - **Action item**: post-deploy, ensure the `setMessenger` runbook documents (a) the no-op messenger address, (b) the cancellation flow, (c) the off-chain alerting that watches for `MessengerUpdated` events from non-routine proposers.

### 3.6 Governor parameter retuning

- **Attack**: a hostile proposal alters voting delay / period / quorum to favour the attacker (e.g. drops voting delay to zero so the next hostile proposal is instant).
- **Severity**: **High** if it succeeds; **Medium** end-to-end because the proposal that does this is itself subject to the current voting delay.
- **Pre-conditions**: same as §3.2 — adversarial quorum.
- **Mitigation in v0**:
    - The `GovernorSettings` extension's setters (`setVotingDelay`, `setVotingPeriod`, `setProposalThreshold`) and `GovernorVotesQuorumFraction.updateQuorumNumerator` are all `onlyGovernance` — they can only be called via a successful proposal that goes through the Timelock.
    - Same 48h voting delay + 48h timelock window as §3.2.
- **Residual risk**: identical to §3.2. Once the parameters are reset, the *new* parameters apply to subsequent proposals — meaning a successful "compress voting delay to zero" proposal opens the door for fast follow-ups. Defence-in-depth: monitor `VotingDelaySet`, `VotingPeriodSet`, `QuorumNumeratorUpdated` events with off-chain alerting. **Action item** for the off-chain alerting runbook.

---

## 4. Cross-chain attacks

The cross-chain surface is the most novel piece of v0. It is also the surface most exposed to assumptions about third-party infrastructure (OP-Stack canonical bridge, dispute games). This section is therefore the most defensive.

### 4.1 Forged proofs

- **Attack**: an adversary submits a `JinnDistributor.claim(proof)` with a forged `proof` that doesn't correspond to any real Base snapshot, but recovers attacker-favourable counters.
- **Severity**: **Critical** at mainnet; **High** at testnet.
- **Pre-conditions** (post bd `jinn-mono-7x5`, commit `fa1948e2`):
    - The adversary must either (a) win a dispute game with an invalid output root and survive the portal finality windows (extremely expensive — exceeds OP-Stack security model assumption), or (b) find a flaw in the OZ 5.6.1 RLP / TrieProof library that lets a forged account/storage MPT proof verify against a real L2 state root, or (c) find a flaw in the messenger's snapshot-hash binding logic.
- **Mitigation in v0**:
    - **Cryptographic checks now in place** (per `7x5`):
        - `IDisputeGameFactory.gameAtIndex(...)` lookup; assert factory/proxy game-type agreement, `game.wasRespectedGameTypeWhenCreated()` or current portal-respected type, `game.status() == DEFENDER_WINS`, and elapsed `proofMaturityDelaySeconds()` plus `disputeGameFinalityDelaySeconds()`.
        - Output-root preimage: recompute `keccak256(version, stateRoot, messagePasserStorageRoot, latestBlockHash)` from the proof's `OutputRootProof` struct and compare to `game.rootClaim()`.
        - Account/storage MPT verification: prove the configured `JinnClaimEmitter` account under `stateRoot`, extract its `storageRoot`, then prove `claimSnapshotHashes[claimId]`.
        - Snapshot binding: recompute `keccak256(abi.encode(claimId, serviceId, verifiedCreations, noveltyWeightedRestorationDeliveries, evaluationDeliveryCount, multisig))` and compare to the proven storage value.
    - **Surface-level checks**:
        - Account proof is keyed to `expectedEmitter` (rejects storage proofs from the wrong contract).
        - `claimTicketTopic` remains pinned deploy metadata for event discovery/canary tooling.
        - `multisig != address(0)` enforced via `if (multisig == address(0)) revert ZeroMultisig()` in the distributor.
    - **MockMessenger remains available** for testnet burn-in convenience and CI; it is testnet/dev only by deploy convention, never deployed on mainnet. Fixtures are keyed by `claimId` and mirror the same tuple the canonical messenger returns. The choice between MockMessenger and CanonicalOpStackMessenger on testnet is operational (finality timing per R-1) rather than security.
- **Residual risk**:
    - The canonical messenger's security depends on OP-Stack dispute-game soundness. If the OP-Stack canonical bridge is itself compromised (e.g. a successful invalid-output-root attack that survives the airgap), JINN is exposed. This is the same trust assumption every OP-Stack-native rollup-bridge contract makes.
    - The OZ 5.6.1 `TrieProof.sol` and `RLP.sol` libraries are used as-is; a flaw in those would propagate into the messenger. The libraries are upstream-audited; v0 does not re-audit them but acknowledges the dependency.

### 4.2 Replay attacks

- **Attack**: an adversary observes a successful `claim(proof)`, then resubmits the same `proof` (or an older snapshot of `proof`) hoping to mint again.
- **Severity**: **Critical** if it worked; **N/A** because it is impossible by design.
- **Pre-conditions**: any proof that the messenger accepts.
- **Mitigation in v0**:
    - **Per-service monotonic accumulators** in the distributor:

      ```solidity
      uint256 owedOperator = entitledOperator > alreadyOperator
          ? entitledOperator - alreadyOperator
          : 0;
      ```

      A resubmitted proof produces the same `entitledOperator` and `entitledDao`. The `alreadyOperator` and `alreadyDao` accumulators have already advanced to those values, so `owedOperator == 0 && owedDao == 0` and the function returns at line 226 without minting anything.
    - **Older snapshots**: if the proof came from an older Base block, `entitledOperator` is *smaller* than the current accumulator. Same clamp-to-zero math. Mints zero.
    - **Messenger is required-stateless** — the `IClaimMessenger` NatSpec says explicitly: "Implementations MUST be stateless / idempotent — no nonce tracking, no seen-proof registry, no storage writes during `verifyClaim`. Replay protection lives in the JinnDistributor's per-service monotonic accumulators, NOT in the messenger." Both `CanonicalOpStackMessenger` and `MockMessenger` honour this.
- **Residual risk**: none. Replay is structurally impossible at the distributor layer regardless of messenger correctness.

### 4.3 Messenger compromise

- **Attack**: the deployed messenger contract is itself compromised — either an admin function on the messenger is exploited, or a flaw in `verifyClaim` returns adversarial values.
- **Severity**: **High** at mainnet; **Medium** at testnet.
- **Pre-conditions**:
    - For `MockMessenger`: attacker controls the messenger owner (multisig pre-handover, Timelock post-handover).
    - For `CanonicalOpStackMessenger`: attacker has found a bug in the OP-Stack storage-proof / dispute-game verification logic post-7x5, OR the canonical OP-Stack contracts have been compromised upstream.
- **Mitigation in v0**:
    - **Governor-driven messenger swap** is the recovery path. `setMessenger(newMessenger)` is one Governor proposal away. The 48h timelock delay applies; during that window, no further mints happen if the attacker is detected and the operator multisig pauses by setting weights to zero (a faster proposal).
    - **Weights-to-zero is the immediate mitigation.** `setWeights(0, 0, 0)` (or `setRatios(0, 0)`) halts future mints from any messenger. This is a one-line proposal and can be queued in parallel with the messenger swap.
    - **Per-service accumulators clamp** mitigates the blast radius even if a hostile messenger has briefly returned inflated counters: once `setWeights(0, 0, 0)` lands, `entitledOperator = 0 < alreadyOperator`, so even legitimate proofs cannot trigger more mints. The accumulator never moves backwards.
- **Residual risk**:
    - Inflated mints between detection and `setWeights(0, 0, 0)` execution are not recoverable on-chain.
    - Off-chain monitoring of `MessengerUpdated` and `Claimed` events is required to detect the attack quickly. **Action item** for operations.

### 4.4 MockMessenger as a mainnet attack surface

- **Attack**: an operations error deploys `MockMessenger` on a mainnet chain, where it can be used to mint arbitrary JINN.
- **Severity**: **Critical** if it happens.
- **Pre-conditions**: someone runs a deploy script that includes `MockMessenger` against a mainnet RPC.
- **Mitigation in v0**:
    - **Operational, not contract**: the Phase 1a deploy script (`scripts/deploy-phase1a-jinn-token.ts`, `scripts/deploy-phase1b-bridge.ts`) does NOT include `MockMessenger` in any mainnet code path. It is only deployed by test fixtures and by a deliberate `--with-mock-messenger` flag on testnet deploys.
    - **`MockMessenger` is owner-controlled** (deployer EOA at construction). Deploying it on mainnet still requires the mainnet distributor's Governor / Timelock to accept it via `setMessenger`. So the attack is two-step: (a) deploy `MockMessenger` to mainnet, (b) win a Governor proposal to swap. Step (b) is the same as §3.5 (hostile messenger swap) which is already covered.
    - **Action item**: the deploy runbook checklist for mainnet must include "verify `MockMessenger` is not deployed on the production network" as a pre-flight check, and a post-flight check on the deploy ledger.
- **Residual risk**: pure operations risk. Contract surface is fine.

### 4.5 Emitter manipulation on Base

- **Attack**: an adversary calls `JinnClaimEmitter.emitClaim(serviceId)` for a service they don't operate, hoping to trigger a mint to a service they do not control. (This is an emitter-side variant of "race-conditioning the claim flow".)
- **Severity**: **None** (no exploit path).
- **Pre-conditions**: any address calling `emitClaim`.
- **Mitigation in v0**:
    - **`emitClaim` is permissionless and the attacker's address only appears in the `claimer` event field** (analytics-only). It is not used to route the mint.
    - **The mint recipient on the JINN chain is the service's `multisig`, recovered from the OLAS ServiceRegistry** at emit time, NOT from `msg.sender`. So calling `emitClaim` for someone else's service simply pays gas to confirm that service's counters — it does not redirect the mint.
    - **The counters being read (`verifiedCreations`, `noveltyWeightedCounts`, `evaluationDeliveryCount`) are all keyed by the service multisig**, not by the `claimer`. Attempting to inflate by calling `emitClaim` for a service you don't operate is a no-op at the counter level.
- **Residual risk**: none. The emitter design is structurally safe against this attack class.

### 4.6 Counter inflation on Base (cross-references §5)

- See §5 for the activity-checker and router-side attack surface. From the cross-chain perspective: the v0 cross-chain pipeline is only as honest as the counters it reads. Any inflation there propagates linearly into mints. Section 5 is therefore the substance of the cross-chain mint integrity story.

### 4.7 Canonical storage-proof verification

The old receipt/log-proof design has been replaced by storage-proof verification. Audit-completeness summary of the canonical checks:

| Original marker | Closed by |
|---|---|
| Dispute-game lookup | `IDisputeGameFactory.gameAtIndex(...)`; assert factory/proxy type agreement, respected game type at creation or current portal type, `DEFENDER_WINS`, and elapsed portal finality delays. |
| Output-root proof | Recompute `keccak256(version, stateRoot, messagePasserStorageRoot, latestBlockHash)` from `OutputRootProof` struct and compare to dispute game's `rootClaim()`. |
| Account/storage MPT proof | OZ 5.6.1 `TrieProof.sol` proves the emitter account under `stateRoot`, then proves `claimSnapshotHashes[claimId]` under the account storage root. |
| Snapshot tuple binding | The proof carries `(claimId, serviceId, counters, multisig)` and the messenger accepts it only if it hashes to the proven storage value. |
| Legacy receipt/log proof path | Removed from the canonical source of truth. Events remain discovery-only; the proof validates the stored snapshot hash. |

**Cumulative effect now**: the canonical messenger cryptographically validates that a `ClaimTicket` snapshot hash was stored by the configured `JinnClaimEmitter` on Base and is covered by a finalised dispute game on L1. The trust model collapses to OP-Stack canonical security plus the OZ 5.6.1 RLP / TrieProof libraries.

**Operational consequence**: testnet burn-in (`r5z`) uses MockMessenger as the active messenger. Canonical Base Sepolia still exercises the real OP output/dispute-game pipeline, but only as a verifier-only canary via `eth_call` against `CanonicalOpStackMessenger.verifyClaim`.

MockMessenger is accepted for active testnet burn-in because it mirrors the same `claimId` snapshot identity and tuple shape that canonical verification proves. **Mainnet still requires the canonical messenger** — `MockMessenger` is testnet/dev only by deploy convention, never deployed on mainnet.

The post-7x5 invariant suite (under follow-up to bd `jinn-mono-sz0`) must include:

- A negative test that mutates the account/storage proof or snapshot tuple and asserts revert.
- A negative test that mutates `disputeGameId` to point at an `IN_PROGRESS` or `CHALLENGER_WINS` game and asserts revert.
- A negative test that constructs an output-root proof against the wrong root and asserts revert.
- A positive test that uses real proofs harvested via `viem`'s `op-stack` actions on Base Sepolia.

These will live in `CanonicalOpStackMessenger.invariant.t.sol` (the stub added in this commit).

---

## 5. Mining attacks

This section covers attacks against the activity-counting machinery on Base. The emitter passes those counters cross-chain verbatim, so any inflation here mints inflated JINN.

### 5.1 C4 — permissionless pumping of `noveltyWeightedCounts`

- **Attack**: an unauthorised contract or EOA calls `RestorationActivityCheckerV2.recordActivity*` to increment `noveltyWeightedCounts[multisig]` for any multisig.
- **Severity**: **Critical** if it succeeded.
- **Pre-conditions**: an EOA or contract other than `authorizedRouter`.
- **Mitigation in v0**:
    - **Already addressed in V2 hardening** (`78bfeac4` on `jinn-mono-1bo`). All three write paths (`recordActivity`, `recordActivityWithEvidence`, `recordRestorationEvidence`) gate on `if (msg.sender != authorizedRouter) revert UnauthorizedRouter(...)`. Confirmed in this audit by reading `RestorationActivityCheckerV2.sol#189, #228, #254`.
    - **The Architecture B single-gate property** holds: only the authorised router can mutate the counters that drive OLAS rewards and JINN minting. `setRouterAddresses` is owner-only.
- **Residual risk**: an attacker who compromises the *authorized router* contract can still mutate counters through the legitimate path. That collapses to "JinnRouterV2 compromise" — see §5.4.

### 5.2 Eval delivery is ungated

- **Attack**: an adversary spams `claimDelivery` for evaluation jobs they posted themselves (loop: `createRestorationJob` → fake delivery → `claimDelivery(restoration)` → `createEvaluationJob` → fake delivery → `claimDelivery(eval)`). Each eval delivery increments `evaluationDeliveryCount[multisig]` at full weight.
- **Severity**: **Medium** at testnet; **Medium** at mainnet (intentional design tradeoff).
- **Pre-conditions**: an OLAS service running through the marketplace; gas to spam `request` calls; willingness to run mech mocks that return delivered status.
- **Mitigation in v0**:
    - **Accepted by design** per Q1.5 ("deterministic-evals reasoning") in the cross-chain spec. Evaluations are deterministic — given the same restoration evidence, the same evaluator should always return the same verdict. Anti-farming via Hamming distance assumes the *evidence* varies; eval verdicts are 0/1 and so a Hamming check is meaningless.
    - **Operational mitigation**: evaluation work is rate-limited by the loop enforcement in `JinnRouterV2.createEvaluationJob` — it requires the upstream restoration to have been delivered AND claimed (`if (!restorationDeliveryClaimed[restorationRequestId]) revert RestorationNotClaimed`). So eval-spam is bounded by restoration-spam, which IS gated by the V2 checker.
    - **Distributor-side mitigation**: `wEvaluationDelivery` is Governor-mutable. If eval-spam becomes a real problem on testnet, the Governor can cap or zero this weight.
- **Residual risk**: eval channel emissions can be inflated by a determined operator who pays for restoration AND eval gas. Capped indirectly by the restoration-side Hamming gate. The distributor's tunable weight is the lever; the threat-model entry exists to make sure this is consciously accepted, not a blind spot.

### 5.3 Creation channel — ε creation gating

- **Attack**: an adversary creates restoration jobs with low-quality / repetitive desired states and harvests `verifiedCreations` credit.
- **Severity**: **Medium** at testnet; **Low** at mainnet (designed to handle this).
- **Pre-conditions**: a creator + a restorer (which can be a sybil) running the loop end-to-end.
- **Mitigation in v0**:
    - **ε creation gating** in `RestorationActivityCheckerV2.recordRestorationEvidence`: creator credit is granted only when the deliverer's evidence passes the Hamming/SimHash novelty test. Specifically:

      ```solidity
      if (weight > 0 && creator != address(0)) {
          verifiedCreations[creator] += weight;
          emit CreationCredited(creator, multisig, evidenceHash, weight);
      }
      ```

      Cheap/repeat tasks fail the novelty test (or get decayed weight) and the creator is credited proportionally less.
    - **JinnRouterV2 tracks creators**: `creators[requestId] = msg.sender` on `createRestorationJob`. This is forwarded into the checker on `claimDelivery`. The slot-13 mapping is part of the V2 hardening commit and is exercised in the test suite.
- **Residual risk**:
    - The Hamming threshold is owner-settable (`setAntifarmingParameters`). A poorly-tuned threshold makes the gate easy to bypass. The default (64 / 256 = 25%) is the result of the V2 hardening discussion; further tuning is expected on testnet.
    - The SimHash itself is computed off-chain. A creator who pre-computes a varied set of evidence can game the Hamming check at low cost. The defence is the gate's existence (it forces *some* effort on diversity); the offence is real, and is monitored via the `noveltyWeight` field of `ActivityRecordedWithEvidence` events.

### 5.4 JinnRouterV2 compromise

- **Attack**: the router contract itself is compromised — either a bug in `claimDelivery` allows an attacker to mark `claimed[requestId] = true` and call `recordRestorationEvidence` without a real delivery, or the router's `initialize` is called twice (impossible per the `if (initialized) revert AlreadyInitialized()` guard but worth flagging).
- **Severity**: **Critical** if successful.
- **Pre-conditions**: a bug in the router, or a re-init.
- **Mitigation in v0**:
    - **Re-init**: blocked by the `initialized` boolean. Verified in the test suite.
    - **`claimDelivery` re-claim**: blocked by `if (claimed[requestId]) revert AlreadyClaimed`.
    - **Marketplace-status check**: `claimDelivery` calls `IMechMarketplace.getRequestStatus(requestId)` and reverts unless the result is `Delivered`. So an attacker who has not actually delivered through the marketplace cannot claim.
    - **Reentrancy**: §F-2 in the Slither doc covers the post-call event/state pattern. Net: no exploit.
- **Residual risk**: the router is upgradeable (proxy). An attacker who compromises the proxy admin can swap the implementation. The proxy admin is the deployer multisig pre-handover and the Timelock post-handover. This is the same threat as §3.4 / §3.5 — governance compromise. No additional surface.

### 5.5 Self-griefing (operator self-bond mode)

- **Attack**: an operator running in self-bond mode (i.e. the operator owns both the EOA and the service multisig) calls the OLAS `claim` mid-flight while a JINN claim is in progress, hoping to confuse the per-service accumulator.
- **Severity**: **Low** (no exploit).
- **Pre-conditions**: operator runs in self-bond mode.
- **Mitigation in v0**:
    - **The accumulator never moves backwards** (clamp-to-zero math at distributor `claim()` lines 219–224). Even if the operator manages to put the service into a state where the next snapshot's `entitledOperator` is *smaller* than `totalClaimedOperator[serviceId]`, `owedOperator = 0` and no mint happens. The accumulator stays at the high-water mark.
    - **Cross-chain proofs are independent** of OLAS-side claim status. The OLAS staking contract's `checkpoint()` reads counters but does not reset them, so JINN claims continue to use the canonical counter values.
- **Residual risk**: none. This is the protocol-safe scenario the design envisions.

---

## 6. Token + minting attacks

### 6.1 JINN minter compromise

- **Attack**: an adversary compromises the address listed at `JINN.minter()` and mints arbitrary JINN.
- **Severity**: **Critical**.
- **Pre-conditions**: control of the distributor (or whatever address is set as minter).
- **Mitigation in v0**:
    - **The minter is the JinnDistributor in v0.** The distributor has no admin path that allows arbitrary minting — every mint is gated by a successful `verifyClaim` AND a positive accumulator delta. So compromising "the minter" is equivalent to compromising the distributor's Governor-mutable state, which collapses to §3 (governance compromise).
    - **Recovery path**: `JINN.setMinter(newMinter)` is `onlyOwner`. The owner is the Timelock post-handover. A successful Governor proposal can swap the minter to a new distributor or to `address(0)` (which disables minting; see §F-4 in the Slither doc). The 48h timelock delay applies.
    - **The `setMinter` does not require a zero-check** because `address(0)` is the explicit "disabled" sentinel. This is documented in the Slither triage and intentional.
- **Residual risk**: 48h between detection and recovery. Same blast-radius mitigations as §3.5.

### 6.2 JINN.owner compromise

- **Attack**: an adversary compromises the address listed at `JINN.owner()` and resets the minter or transfers ownership to themselves.
- **Severity**: **Critical**.
- **Pre-conditions**: control of the Timelock (post-handover) or the multisig (pre-handover).
- **Mitigation in v0**:
    - **`Ownable2Step`** — ownership transfer is a two-step ceremony. `transferOwnership(attacker)` only marks the attacker as `pendingOwner`; until `acceptOwnership()` is called from the attacker's address, the actual `owner()` is unchanged. An attacker who briefly steals the Timelock cannot complete the transfer without also calling `acceptOwnership()` from a transaction whose `msg.sender` is the new owner.
    - **`pendingOwner` does not have privileged access.** Reading `JINN.sol#19` (inheritance), the pending-owner role grants no `onlyOwner` capability. So the attacker stealing `transferOwnership` and then losing access (e.g. the legitimate operators retake the Timelock) leaves the contract in a recoverable state — call `transferOwnership(legitimateAddress)` again to overwrite the pending pointer.
    - **The Governor + Timelock is the legitimate `owner()` post-handover.** The Governor's `_executor()` is `address(this)` per OZ default; any `transferOwnership` call must come through a Governor proposal. So compromising "the JINN owner" means compromising the entire Governor, which collapses to §3.
- **Residual risk**: same as §3.4. No additional surface.

### 6.3 JINN supply integrity

- **Attack**: an adversary finds a path that mints more JINN than the per-service entitlement should allow.
- **Severity**: **Critical** at mainnet.
- **Pre-conditions**: a math bug in the distributor's weighted-snapshot or accumulator logic.
- **Mitigation in v0**:
    - **Re-read of distributor `claim()`**:
        - `weighted = wCreation * vCreations + wRestorationDelivery * vRestoration + wEvaluationDelivery * evalDelivery` — three uint256 multiplications + two additions. Overflow-safe under `^0.8.30` checked arithmetic.
        - `entitledOperator = (weighted * operatorRatio) / 1e18` — same. The division floor-rounds, never up.
        - `owedOperator = entitledOperator > alreadyOperator ? entitledOperator - alreadyOperator : 0` — clamp-to-zero.
        - `totalClaimedOperator[serviceId] = entitledOperator` — set BEFORE the external mint (CEI ordering).
    - **The CEI ordering is the single most important invariant**: any reentrant `claim()` call against the same `serviceId` observes the post-update accumulator and short-circuits.
    - **Ratios and weights are independent and uncapped** (`operatorRatio + daoRatio` is intentionally not constrained per the §2 = B uncapped lock in the Phase A spec). This is by design — they are tuned independently. A misconfiguration that sets both to a very large value still floor-rounds and produces a finite mint, but it could over-mint. **Action item**: governance review must include a sanity check on weight/ratio bounds before any proposal.
    - **The Foundry invariant stubs** added in this commit will be filled in to test:
        - `totalSupply()` ≤ Σ (`Claimed.operatorMinted` + `Claimed.daoMinted`) over all events.
        - Per-service accumulator monotonicity.
        - Mint-equals-delta property.
- **Residual risk**: until the invariant tests are authored, the supply-integrity property is verified only by manual review and the Hardhat test suite (which has 385 passing tests, including coverage of `JinnDistributor`'s claim flow). Track the invariant authoring under a follow-up to bd `jinn-mono-sz0`.

---

## 7. Operational risks

These are not contract-level threats but failure modes that affect the security posture of the deployed system.

### 7.1 Pre-existing fast-test profile failure

- **Issue**: `test/phase1/DeployL1Stack.test.ts` line 234 fails with `AssertionError: expected 10000 to equal 1000` on the fast-test governance timing profile assertion.
- **Severity**: **Low** (test-only, no contract effect).
- **Mitigation in v0**: this failure is **pre-existing** on `jinn-mono/jinn-mono-1bo` and is unrelated to the v0 audit surface. The 384 other tests pass.
- **Action item**: file a follow-up to fix `DeployL1Stack.test.ts:234` so CI is clean. Track separately from the v0 deploy gate.

### 7.2 Storage layout caveat — `creators` mapping at slot 13

- **Issue**: `JinnRouterV2.creators` lives at slot 13. The proxy storage layout is sensitive to ordering.
- **Severity**: **High** if violated (would corrupt all mappings on upgrade).
- **Mitigation in v0**:
    - **Slot reservations are explicit** — `_proxyReserved0` (slot 0) and `_proxyReserved1` (slot 1) are placeholder variables documented as "DO NOT USE". This is why Slither flags them as `unused-state` / `constable-states` (see §F-6 in the Slither doc); marking them constant would reorder the layout.
    - **Comment block above slot 13** explicitly says: "ε creation gating (slot 13)". Future upgrades MUST preserve this layout.
- **Residual risk**:
    - A contributor who adds a new mapping in the middle of the storage block without checking slot positions will corrupt every subsequent mapping. **Action item**: add a `forge inspect JinnRouterV2 storageLayout` check to CI to catch slot drift. Track under invariant authoring follow-up.

### 7.3 ERC-6372 timestamp mode

- **Issue**: JINN's `clock()` returns `block.timestamp` rather than the OZ default `block.number`. `CLOCK_MODE()` returns `"mode=timestamp"`.
- **Severity**: **Informational**, but flagged for auditor clarity.
- **Mitigation in v0**: this is **intentional and documented**. The v0 governance plan locks Governor parameters in seconds (e.g. 172,800 s voting delay), so anchoring checkpoints to `block.timestamp` is required for the timing math to make sense. ERC-6372 + ERC-5805 explicitly support timestamp mode. The OZ Governor reads `IERC5805.CLOCK_MODE()` and defers to JINN's choice.
- **Residual risk**:
    - Indexers that don't support ERC-6372 timestamp mode may misreport voting power as block-number-based. The Tally / off-chain dashboard tooling MUST be configured to expect timestamp mode.
    - Cross-chain comparisons (e.g. comparing JINN voting checkpoints to a Base block) require unit conversion. Out of v0 scope (no cross-chain governance).

### 7.4 Multisig role retention during Phase A6 → B handover

- **Issue**: §3.2's residual risk — the multisig retains `PROPOSER_ROLE` on the Timelock for a 21-day cooldown post-handover.
- **Severity**: **Medium** if the multisig is compromised during the cooldown.
- **Mitigation in v0**:
    - **Operational, not contract**. The cooldown is documented; the runbook mandates revocation 21 days post-handover.
    - The 6-of-N threshold on the multisig provides defence-in-depth.
- **Residual risk**: 21 days of dual-control. Tradeoff for rollback capability if the new Governor's parameters are misconfigured.

### 7.5 Off-chain monitoring requirements

- **Issue**: several mitigations in this document depend on off-chain alerting (events for `MessengerUpdated`, `RatiosUpdated`, `WeightsUpdated`, `MinterUpdated`, `Claimed` with abnormal magnitudes, `OwnershipTransferred`, `OwnershipTransferStarted`).
- **Severity**: **Medium** (alerting gap = slower incident response).
- **Mitigation in v0**:
    - **Operational**: a subgraph + monitoring runbook is part of the testnet readiness gate (separate task).
    - The events themselves are emitted by all contracts in scope — no contract changes required.
- **Residual risk**: until the alerting is wired, response time depends on manual chain-watching. Acceptable for a low-value testnet; not acceptable for mainnet.

---

## 8. Summary — pre-deploy readiness

### 8.1 Contract-level readiness

| Concern | Status |
|---|---|
| Governance compromise (§3) | Mitigated for testnet. Quorum and timelock parameters are conservative; voting-delay window gives operators 96h to organise. |
| Cross-chain replay (§4.2) | Structurally impossible by per-service accumulator design. |
| Cross-chain forged proofs (§4.1) | Canonical contract verification implemented against storage proofs; active testnet burn-in uses MockMessenger, and canonical Base Sepolia is verifier-only until the durable daemon proof builder passes canary. |
| C4 permissionless pumping (§5.1) | **Already addressed** in V2 hardening (78bfeac4). |
| ε creation gating (§5.3) | **Already addressed** in V2 hardening; tunable on testnet. |
| Eval delivery ungated (§5.2) | **Accepted** by design (deterministic evals). Distributor weight is the lever. |
| Mint integrity (§6.3) | Manual review + 385 passing Hardhat tests. Foundry invariant suite stubbed; **authoring deferred** to follow-up. |
| Storage layout (§7.2) | OK; CI lint recommended. |

### 8.2 Operational readiness — open items

These do not block testnet deploy but must be tracked:

1. **Canonical verifier-only daemon builder** must pass a real Base Sepolia canary before any mainnet messenger swap. Owner: cross-chain workstream.
2. **Off-chain alerting runbook** must cover `MessengerUpdated`, `WeightsUpdated`, `RatiosUpdated`, `MinterUpdated`, `OwnershipTransferStarted`, abnormal `Claimed` magnitudes. Owner: operations.
3. **Foundry invariant authoring** for the three stubs added in this commit (`JINN.invariant.t.sol`, `JinnDistributor.invariant.t.sol`, `CanonicalOpStackMessenger.invariant.t.sol`). Owner: contracts.
4. **`DeployL1Stack.test.ts:234` fast-test profile fix** (§7.1). Owner: contracts.
5. **CI storage-layout check** via `forge inspect JinnRouterV2 storageLayout` (§7.2). Owner: contracts.
6. **Multisig `PROPOSER_ROLE` revocation 21 days post-handover** (§7.4). Owner: operations.
7. **Mainnet readiness — third-party audit + formal verification on JinnDistributor + Governor parameter sanity-check workflow.** Owner: deferred to mainnet milestone.

### 8.3 Verdict for v0 testnet

The bespoke v0 contracts are **ready for testnet deployment** on Sepolia / Base Sepolia, conditional on:

- Using `MockMessenger` for the cross-chain bridge until bd `jinn-mono-7x5` closes.
- Wiring the off-chain alerting runbook before any non-trivial JINN value sits in the system.
- Tracking the operational open items above.

No high- or medium-severity findings from this review block the v0 testnet deploy. The cross-chain pipeline is the most novel surface and the most exposed to follow-up work; that is the right ordering — testnet exists precisely to burn in the assumptions before mainnet.

---

## Appendix A — `JinnDistributor.claim` state machine

This appendix walks through every storage-and-event observable along the `claim()` flow, so a reviewer can confirm the CEI ordering and the no-reentrancy invariants hold.

### A.1 Function entry

```solidity
function claim(bytes calldata proof) external {
    (
        uint256 serviceId,
        uint256 vCreations,
        uint256 vRestoration,
        uint256 evalDelivery,
        address multisig
    ) = messenger.verifyClaim(proof);
```

- `messenger.verifyClaim` is `view` per `IClaimMessenger`. Both `CanonicalOpStackMessenger.verifyClaim` and `MockMessenger.verifyClaim` are declared `view`. **Therefore no state on the messenger contract can be mutated by this call**, satisfying the messenger statelessness requirement structurally (the EVM enforces it for `view` calls).
- The returned `multisig` is the only data flowing from the messenger to the rest of the function that has security significance — it is the operator-share mint recipient. Section 4.5 covered why the emitter cannot maliciously redirect this; the messenger's responsibility is to faithfully recover the value.

### A.2 Multisig zero-check

```solidity
if (multisig == address(0)) revert ZeroMultisig();
```

This guards against a buggy messenger that returns the zero address. `MockMessenger` already enforces a non-zero multisig at fixture-set time, so this revert is defensive double-checking. In canonical mode, `multisig` is bound into the proven `claimSnapshotHashes[claimId]` value, and `JinnClaimEmitter.emitClaim` already enforces `require(multisig != address(0))` when reading from the OLAS ServiceRegistry — so the zero-check at the distributor is in fact triple-belt-and-braces.

### A.3 Snapshot weighting

```solidity
uint256 weighted = wCreation * vCreations
    + wRestorationDelivery * vRestoration
    + wEvaluationDelivery * evalDelivery;

uint256 entitledOperator = (weighted * operatorRatio) / 1e18;
uint256 entitledDao      = (weighted * daoRatio)      / 1e18;
```

- All arithmetic is in `^0.8.30` checked mode. Overflow reverts the call without state change.
- Division by `1e18` is floor-rounding. Across a series of calls the floor-rounding is bounded: each `claim()` mints at most `(weighted * ratio - epsilon) / 1e18` rounded down, and the accumulator is updated to that exact value. So the high-water mark is consistent with the floor; a subsequent claim with a larger weighted snapshot produces the matching delta.
- **Attack consideration**: can a sequence of (weight change → claim → weight change → claim) produce a per-step rounding loss that accumulates to a meaningful drift? No — the next `claim` reads `weighted` based on the *current* weights and the proof's counter values; it does not accumulate roundings from prior claims. Each `entitledOperator` is computed fresh from current state.

### A.4 Accumulator read

```solidity
uint256 alreadyOperator = totalClaimedOperator[serviceId];
uint256 alreadyDao      = totalClaimedDao[serviceId];
```

- Storage reads. Free of side effects.

### A.5 Clamp-to-zero

```solidity
uint256 owedOperator = entitledOperator > alreadyOperator
    ? entitledOperator - alreadyOperator
    : 0;
uint256 owedDao = entitledDao > alreadyDao
    ? entitledDao - alreadyDao
    : 0;

if (owedOperator == 0 && owedDao == 0) {
    return;
}
```

- This is the replay-defence centroid. **Property**: for any sequence of valid proofs against the same `serviceId`, total minted operator share equals `max(entitledOperator)` over the sequence, NOT `Σ entitledOperator`. The accumulator is monotone in `entitledOperator`.
- **Attack consideration**: can an adversary observe an in-flight claim and front-run it with a stale (smaller `entitledOperator`) proof to "trap" the accumulator at a lower value, blocking the legitimate large claim? No — submitting a stale proof against an empty accumulator (`alreadyOperator == 0`) advances the accumulator to the stale value, but the legitimate large claim that follows simply produces `entitledOperator(legitimate) > entitledOperator(stale)` and mints the difference. The accumulator never traps.
- **Edge case**: simultaneous `claim()` calls for the same service in the same block — both reach `claim`, the first succeeds, the second observes the post-update accumulator and short-circuits (the function returns at line 226 with no mint). This is the intended deduplication.

### A.6 Effects (storage updates)

```solidity
if (owedOperator > 0) {
    totalClaimedOperator[serviceId] = entitledOperator;
}
if (owedDao > 0) {
    totalClaimedDao[serviceId] = entitledDao;
}
```

- **CEI ordering**: storage is updated *before* any external call. A reentrant `claim()` for the same `serviceId` arriving after this point sees the post-update accumulator.
- **Property**: each accumulator stores `entitledOperator` (or `entitledDao`), not `alreadyOperator + owedOperator`. These are equal by construction (`alreadyOperator + (entitledOperator - alreadyOperator) == entitledOperator`), but the explicit assignment makes the high-water-mark semantics obvious.

### A.7 External mint calls

```solidity
if (owedOperator > 0) {
    jinn.mint(multisig, owedOperator);
}
if (owedDao > 0) {
    jinn.mint(daoTreasury, owedDao);
}
```

- Two `external` calls into `JINN.mint`. `JINN.mint` is `external` and writes balances + voting checkpoints via OZ's `_mint` → `_update`. **No callback**: ERC20Votes does not invoke any hook on `to`. JINN does not implement ERC777 or ERC1363.
- Even if `multisig` were a contract that implemented some malicious hook (it cannot — there is no hook to implement), the post-state of the distributor is already settled: the accumulator is at the new high-water mark.
- **Property**: the only state change to the distributor caused by `claim()` after this point is the event emission (which is logs, not storage).

### A.8 Event emission

```solidity
emit Claimed(
    serviceId,
    multisig,
    owedOperator,
    owedDao,
    totalClaimedOperator[serviceId],
    totalClaimedDao[serviceId]
);
```

- The event re-reads the accumulator from storage so the logged high-water marks reflect actual stored state. Useful for off-chain reconcilation of mint-event-stream → accumulator-state.
- **Slither flagged this as `reentrancy-events` (low)** in §F-1 of the Slither doc; the triage there explains why it is intentional.

### A.9 Function exit

- Control returns to the caller. The caller paid gas; no return value (the function returns nothing). The mint recipients are determined by the recovered tuple, not by the caller.
- **Permissionless property**: the caller's address is not stored, not used in the mint routing, and not used in event topics (the event indexes `serviceId` and `multisig`, both derived from the proof). So an arbitrary relayer paying gas to call `claim()` adds no attack surface — the worst case is they pay gas for a no-op (clamp-to-zero short-circuit).

---

## Appendix B — Sequence diagram for a successful claim

```
Operator (Base)            JinnRouterV2 (Base)         RestorationActivityCheckerV2 (Base)
   │                              │                              │
   ├──createRestorationJob()─────►│ creators[reqId] = msg.sender │
   │                              │                              │
   │                       ... time passes; mech delivers ...    │
   │                              │                              │
   ├──claimDelivery(reqId, hash)─►│ claimed[reqId] = true        │
   │                              ├──recordRestorationEvidence──►│ noveltyWeightedCounts[ms] += w
   │                              │                              │ verifiedCreations[creator] += w (ε)
   │                              │                              │
   │                              │
Relayer (Base)            JinnClaimEmitter (Base)        OLAS ServiceRegistry (Base)
   │                              │                              │
   ├──emitClaim(serviceId)───────►│                              │
   │                              ├──mapServices(serviceId)─────►│
   │                              │◄─────multisig───────────────┤
   │                              ├──checker.verifiedCreations(ms)──► (read)
   │                              ├──checker.noveltyWeightedCounts(ms)──► (read)
   │                              ├──router.evaluationDeliveryCount(ms)──► (read)
   │                              │
   │                       ... ClaimTicket log emitted + snapshot hash stored on Base ...
   │                              ▼
   │                       (waits for OP-Stack finality —
   │                        7-day default fault-proof window)
   │                              │
Relayer (Sepolia)         CanonicalOpStackMessenger (Sepolia)        JinnDistributor (Sepolia)
   │                              │                                          │
   │                              │     (canonical canary;                    │
   │                              │      burn-in uses claimId MockMessenger)  │
   │                              │                                          │
   ├──claim(proof)───────────────────────────────────────────────────────────►│
   │                              │                                          ├──verifyClaim(proof)──►
   │                              │  (validates dispute game, output root,   │
   │                              │   account/storage MPT + snapshot hash)   │
   │                              │                                          │◄─tuple──────────────
   │                              │                                          ├──update accumulators
   │                              │                                          ├──jinn.mint(multisig, owedOperator)
   │                              │                                          ├──jinn.mint(daoTreasury, owedDao)
   │                              │                                          ├──emit Claimed(...)
   │                              │                                          │
```

This diagram is informative for incident response — at any point, if you observe a `Claimed` event with abnormal magnitude, you can walk back: was the `ClaimTicket` legitimate (check the Base log and stored snapshot hash)? Was the proof legitimate (check the dispute game id and storage proof)? Were the underlying counters legitimate (check the V2 checker / router state at the emit block)?

---

## Appendix C — Summary table of all severities

| Section | Attack | Severity (testnet) | Severity (mainnet) |
|---|---|---|---|
| 3.1 | Proposal spam | Low | Low |
| 3.2 | Quorum manipulation | High | Critical |
| 3.3 | Timelock bypass | Critical | Critical |
| 3.4 | Majority-key compromise | High | Critical |
| 3.5 | Hostile setMessenger | Medium | High |
| 3.6 | Governor parameter retuning | Medium | High |
| 4.1 | Forged proofs | High | Critical |
| 4.2 | Replay attacks | N/A | N/A |
| 4.3 | Messenger compromise | Medium | High |
| 4.4 | MockMessenger on mainnet | (testnet n/a) | Critical |
| 4.5 | Emitter manipulation | None | None |
| 4.7 | Canonical daemon proof-builder gap | Mock active for burn-in; canonical verifier-only canary required before mainnet | High until canary passes |
| 5.1 | C4 permissionless pumping | Critical (already mitigated) | Critical (already mitigated) |
| 5.2 | Eval delivery ungated | Medium (accepted) | Medium (accepted) |
| 5.3 | Creation channel | Medium | Low |
| 5.4 | Router compromise | Critical | Critical |
| 5.5 | Self-griefing | Low (no exploit) | Low (no exploit) |
| 6.1 | Minter compromise | Critical | Critical |
| 6.2 | Owner compromise | Critical | Critical |
| 6.3 | Supply integrity | Manual review only | Requires invariant suite + audit |
| 7.1 | Pre-existing test failure | Low | n/a |
| 7.2 | Storage layout | High if violated | High if violated |
| 7.3 | ERC-6372 timestamp | Informational | Informational |
| 7.4 | Multisig role retention | Medium | Medium |
| 7.5 | Off-chain monitoring | Medium | High |

The mainnet column is informational — it documents what the same threats look like with non-trivial dollar value at stake. Mainnet readiness is a separate gate.
