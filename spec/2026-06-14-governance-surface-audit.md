# On-chain governance-surface audit (governance minimisation)

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

- **Version:** 0.1 (spike finding — open for discussion)
- **Date:** 2026-06-14
- **Author:** drafted with Opus for the #223 spike, for Oak + Ritsu review
- **Status:** Open. This is the concrete audit that [Discussion #222 — launch gating criteria](https://github.com/Jinn-Network/mono/discussions/222) relies on to converge on **C17–C19** (governance architecture). It is a *finding*, not an implementation: it enumerates and classifies every discretionary on-chain surface and registers the redesign work (each **Needs redesign** entry becomes a follow-up issue). It does not change any contract.
- **Related:** [`spec/2026-05-14-launch-gating-criteria.md`](2026-05-14-launch-gating-criteria.md) (C17–C19); [`spec/2026-06-05-independent-blockchain-launch.md`](2026-06-05-independent-blockchain-launch.md) (the sovereign-chain decision that deletes a whole class of surfaces below); [`PRINCIPLES.md`](../PRINCIPLES.md) (Governance Minimal); [`SPEC.md` §Tokenomics](../SPEC.md); Issue [#223](https://github.com/Jinn-Network/mono/issues/223).

---

## In plain English (read this first)

We walked every contract that could be live at mainnet and listed every place where *someone with a key* can change how the protocol behaves — admin roles, upgrade switches, parameter dials, pause buttons, mint/withdraw authorities. For each one we asked: does this **have to** exist, is it just **convenient** (and should be removed before mainnet), or does it have to exist but in its **current form concentrates too much power** (and should be redesigned)?

The short version:

- **The Jinn-authored token + governance core is already close to minimal.** JINN has one minter (the Distributor); the Distributor and token are owned by a standard OpenZeppelin **Governor + Timelock**; the Governor itself has no magic admin — it can only change its own rules through its own vote. That is the shape governance-minimisation wants. Two clean tasks remain: **transfer every owner from the deploy EOA to the Timelock** before launch, and decide what (if anything) stays tunable afterwards.
- **The single biggest surface is upgradeability.** Several proxies let an *admin key* swap the implementation with **no timelock and no veto** — which silently overrides every other "minimal" property, because whoever holds that key can rewrite the contract. One of them is even labelled "for testnet components." This is the first thing to fix or renounce.
- **A large class of surfaces disappears if the sovereign-chain decision holds.** The cross-chain claim loop (claim emitter → OP-Stack messenger → `Distributor.setMessenger`) is exactly what [`spec/2026-06-05-independent-blockchain-launch.md`](2026-06-05-independent-blockchain-launch.md) §conclusion-3 deletes by putting mint + activity on one chain. Audited as currently designed, these are trust surfaces; under the decided pivot they are **Removable** outright.
- **There are parallel governance channels next to ve-JINN.** The gauge/vote-weighting stack lets an *owner* remove gauges (`removeNominee`) and, in `Lock.sol`, an owner proposes/votes/withdraws on behalf of locked tokens. That is a direct **C18** problem — a discretionary channel competing with the gauge vote it is supposed to be subordinate to.
- **The vendored OLAS stack carries OLAS's own owner→timelock pattern.** Wherever Jinn deploys and owns one of these (tokenomics Treasury/Dispenser/Depository, stOLAS L1/L2, registry-staking verifier/factory, mech marketplace), the owner must be a Timelock/DAO and not an EOA, and several whitelist/upgrade authorities need DAO-gating or removal.

---

## Scope and method

**In scope.** Every contract under `contracts/src/**` that could be live at mainnet, plus the JINN token / Treasury / Distributor / ve-JINN stack as currently designed for Phase A.

**A discretionary surface** is any access-controlled lever: admin/owner roles; upgrade paths (proxy implementation swaps); parameter setters (rates, thresholds, addresses, eligibility/activity checkers, oracles, whitelists); pause/emergency mechanisms; mint/burn/treasury-withdraw/sweep authorities; role grants; ownership transfers; trusted-remote/relayer setters.

**Method.** Four parallel reads over the contract tree, enumerating each surface (contract, function, access control, surface type, power, classification). The load-bearing Jinn-authored surfaces (JINN, JinnGovernor, JinnDistributor, JinnUpgradeableProxy) were then re-read first-hand to confirm the enumeration.

**Two caveats that shape every verdict below:**

1. **The sovereign-chain pivot.** [`spec/2026-06-05-independent-blockchain-launch.md`](2026-06-05-independent-blockchain-launch.md) decides (in principle) to launch Jinn as its own Cosmos-EVM chain with token + DAO native from genesis, which **deletes the entire cross-chain claim loop**. The EVM contracts run unchanged on that substrate, so this audit's enumeration still holds — but the *classification* of the cross-chain cluster flips from "trust surface to constrain" to "remove." Both verdicts are recorded.
2. **Vendored vs authored.** `contracts/src/vendor/**` is forked OLAS. Those contracts carry OLAS's governance model, not Jinn's. They matter to this audit only where Jinn **deploys and owns** an instance at mainnet; the owned-by-OLAS-mainnet instances are out of Jinn's governance footprint. Which OLAS pieces survive the sovereign pivot is itself **Open** (independent-launch §7).

## Classification framework

Per the issue, every surface is classified against governance minimisation:

- **Justified** — must exist for the protocol to function; the audit names what constrains its abuse.
- **Removable** — exists for convenience / familiarity / future flexibility, not required at launch; remove before mainnet.
- **Needs redesign** — required, but the current form concentrates power excessively; the audit names a redesign direction (move to ve-JINN gauge vote, replace admin with mechanism, time-lock + public veto, renounce after deploy).

---

## 1. Jinn-authored core — token, governance, distribution

This is Jinn's *owned* governance footprint and the heart of C17. Verdict: **already close to minimal**; the residual work is owner-handover and a few ratify-or-renounce decisions.

| Contract | Surface | Access | Type | Power | Verdict |
|---|---|---|---|---|---|
| `jinn/token/JINN.sol` | `mint(to, amount)` | `minter` only | mint | Mint JINN | **Justified** — single minter, set to the Distributor; supply policy enforced one layer up. |
| `jinn/token/JINN.sol` | `setMinter(newMinter)` | `onlyOwner` (→ Timelock) | param-setter | Repoint / unset the minter | **Justified** — must be governance-settable to hand minting to the Distributor and to revoke a compromised minter; constrain by owner = Timelock, renounce-eligible later. |
| `jinn/token/JINN.sol` | `transferOwnership` / `acceptOwnership` (Ownable2Step) | `onlyOwner` | admin-role | Hand over token ownership | **Justified** — two-step transfer is the deploy-EOA → Timelock handover path. |
| `jinn/governance/JinnGovernor.sol` | (constructor-set voting delay/period/threshold/quorum) | n/a | param-setter | Governance timing | **Justified** — stock OZ Governor + `TimelockController`; no out-of-band admin. |
| `jinn/governance/JinnGovernor.sol` | `setVotingDelay` / `setVotingPeriod` / `setProposalThreshold` / `updateQuorumNumerator` (inherited) | `onlyGovernance` | param-setter | Governor amends its own rules | **Justified** — self-amendment only *through a passed proposal via the Timelock*; this is the C19 meta-governance surface (see §6). |
| `jinn/distribution/JinnDistributor.sol` | `claim(...)` | permissionless | mint-trigger | Mints owed JINN to operator + DAO per on-chain accounting | **Justified** — formulaic, no discretion; the mint amounts derive from recorded activity. |
| `jinn/distribution/JinnDistributor.sol` | `setMessenger(newMessenger)` | `onlyOwner` (→ Timelock) | param-setter | Swap the cross-chain claim-proof verifier | **Needs redesign / Removable** — swaps the contract that authenticates every claim. **Removable** under the sovereign pivot (no cross-chain loop). If a bridged mainnet is retained: timelock + public-veto window. → see ND-2. |
| `jinn/distribution/JinnDistributor.sol` | `setRatios(operator, dao)` | `onlyOwner` (→ Timelock) | param-setter | Tune operator/DAO emission split | **Ratify (low severity)** — each side capped by `MAX_RATIO`; sum deliberately uncapped per Phase A §2=B. Bounded, so not a redesign; but it is a *directional* emission lever and C18 asks whether such levers should be gauge-anchored rather than Timelock-discretionary (see §5). |
| `jinn/distribution/JinnDistributor.sol` | `setWeights(taskCreation, solutionDelivery, verdictDelivery)` | `onlyOwner` (→ Timelock) | param-setter | Tune per-channel emission weights | **Ratify (low severity)** — each weight capped by `MAX_WEIGHT`; same C18 question as ratios. |
| `jinn/distribution/JinnDistributor.sol` | `transferOwnership` / `acceptOwnership` | `onlyOwner` | admin-role | Hand over Distributor ownership | **Justified** — deploy-EOA → Timelock handover. |

**Reading.** The token/Governor/Distributor triangle is the minimal shape: one capped minter, governance behind a Timelock, no side-door admin. The two real obligations are (a) **the launch checklist must verify every `owner` is the Timelock, not the deploy EOA** (the 2026-04-21 minter-drift incident — JINN.minter left as the deployer EOA — is the cautionary precedent), and (b) **decide, per setter, whether it stays tunable or is renounced** at launch.

**Dead-code note.** `vendor/governance/JINN.sol` (single-step `changeOwner`, built-in inflation schedule) is the superseded OLAS-vendored token. It must **not** be deployed — `jinn/token/JINN.sol` replaces it. Flag for deletion to remove the footgun. **Removable.**

## 2. Upgradeability — the dominant surface

Upgrade authority overrides every other property in this document: whoever can swap an implementation can rewrite the contract. This is the first cluster to resolve for C17.

| Contract | Surface | Access | Power | Verdict |
|---|---|---|---|---|
| `proxy/JinnUpgradeableProxy.sol` | `upgradeTo(newImpl)` | `admin` (EOA, **no timelock**) | Swap implementation of whatever sits behind it | **Needs redesign** — admin key with no delay/veto; docstring even says "for **testnet** protocol components." Either route through Timelock + veto or make immutable at mainnet. → ND-1. |
| `proxy/JinnUpgradeableProxy.sol` | `changeAdmin(newAdmin)` | `admin` | Transfer the upgrade key | **Needs redesign** — same key; same fix. → ND-1. |
| `staking/RestorationActivityCheckerV2.sol` (via `Implementation`) | `changeImplementation(newImpl)` | `owner` | Swap the anti-farming / activity-counting logic that gates staking rewards | **Needs redesign** — timelock-gate or renounce; this logic decides who earns. → ND-1. |
| `staking/TaskActivityCheckerV3.sol` (via `Implementation`) | `changeImplementation(newImpl)` | `owner` | Swap task weight/credit logic | **Needs redesign** — same. → ND-1. |
| `staking/JinnRouterProxy.sol`, `staking/ActivityCheckerProxy.sol` | constructor-pinned implementation; **no `upgradeTo`** | n/a | Immutable forwarder | **Justified** — these proxies pin the implementation at construction with no upgrade path; this is the minimal pattern and the model the others should follow. |

**Reading.** Two upgrade *models* coexist in the tree: pinned-at-construction (`JinnRouterProxy`, `ActivityCheckerProxy`) and live-admin-swap (`JinnUpgradeableProxy`, the `Implementation`-based checkers). Governance-minimisation prefers the first. The launch decision is binary per contract: **renounce upgradeability (immutable)** or **gate every swap behind the Timelock + a public veto window**. An unguarded admin EOA on any mainnet-live proxy is the highest-severity finding here.

## 3. Cross-chain claim stack — deletion-bound under the sovereign pivot

Audited as currently designed (a bridged L1↔L2 claim loop). Under [`spec/2026-06-05-independent-blockchain-launch.md`](2026-06-05-independent-blockchain-launch.md) the whole loop is deleted (mint + activity on one chain), which flips these from "trust surface" to **Removable**.

| Contract | Surface | Access | Power | Verdict |
|---|---|---|---|---|
| `jinn/cross-chain/CanonicalOpStackMessenger.sol` | constructor-set `optimismPortal`, `disputeGameFactory`, `expectedEmitter` | immutable | Anchors all proof validation to fixed addresses | **Justified as-built** (immutable, no admin) / **Removable** under the pivot. |
| `jinn/cross-chain/CanonicalOpStackMessenger.sol` | `verifyClaim(bytes)` | permissionless (view) | Verifies a cross-chain proof | **Justified** — no discretion. |
| `jinn/cross-chain/JinnClaimEmitter.sol`, `TaskClaimEmitter.sol` | `emitClaim(serviceId)` | permissionless | Emits a claim ticket; no value movement | **Justified as-built** / **Removable** under the pivot. |
| `jinn/distribution/JinnDistributor.sol` | `setMessenger` | `onlyOwner` | (see §1) | **Removable** under the pivot — the messenger it swaps ceases to exist. → ND-2. |

**Reading.** The messenger is immutable (good — the trust is fixed at deploy, not held by a live key); the only *discretionary* surface in the loop is `Distributor.setMessenger`. The cleanest governance-minimisation outcome is the one the sovereign decision already implies: **delete the loop**, which removes both the trusted-address anchor and the setter.

## 4. ve-JINN gauge / vote-weighting / lock — the C18 cluster

C18 asks whether ve-JINN gauge voting is the **only** directional governance mechanism, or whether parallel discretionary channels compete with it. **Finding: there are parallel channels.**

| Contract | Surface | Access | Power | Verdict |
|---|---|---|---|---|
| `vendor/governance/veOLAS.sol` | lock / increase / withdraw | user, time-locked | Mint/burn voting power by locking | **Justified** — ownerless, immutable, pure mechanism; the model the rest of the stack should match. |
| `vendor/governance/VoteWeighting.sol` | `voteForNomineeWeights(...)` (+ batch) | ve-holders | Allocate gauge weight | **Justified** — the intended directional surface. |
| `vendor/governance/VoteWeighting.sol` | `addNomineeEVM` / `addNomineeNonEVM` | permissionless | Add a gauge | **Justified** — open nomination is fine; the asymmetry is the *removal* side below. |
| `vendor/governance/VoteWeighting.sol` | `removeNominee(...)` | `owner` | Remove a gauge, zeroing its weight | **Needs redesign** — an owner key that can delete any gauge is a discretionary veto competing with the gauge vote. Move removal to a governance/gauge decision or an immutable policy. → ND-3. |
| `vendor/governance/VoteWeighting.sol` | `changeDispenser(newDispenser)` | `owner` | Repoint the dispenser the gauge feeds | **Needs redesign** — owner repointing of the reward sink; timelock-gate or pin. → ND-3. |
| `vendor/governance/VoteWeighting.sol` | `changeOwner(newOwner)` | `owner` | Transfer the above authority | **Needs redesign** — single-step owner; must be Timelock or renounced. → ND-3. |
| `vendor/stolas/l1/Lock.sol` | `propose` / `castVote` / `withdraw` / `changeGovernor` / `changeLockTimeIncrease` | `owner` | Owner proposes, votes, withdraws on behalf of locked tokens, and can repoint the governor | **Needs redesign / Removable** — if `Lock.sol` is deployed for Jinn, its owner is a parallel governance *master* (the deepest C18 violation). Drop it for mainnet, or de-owner it. → ND-4. |

**Answer to C18: No.** As currently designed, ve-JINN gauge voting is **not** the only directional channel. `VoteWeighting.removeNominee` and, if deployed, `Lock.sol`'s owner-proxied proposing/voting/withdrawing are discretionary channels that override or bypass the gauge vote. Closing these is a launch-gate for C18.

## 5. Activity / eligibility — who earns

| Contract | Surface | Access | Power | Verdict |
|---|---|---|---|---|
| `staking/RestorationActivityChecker.sol` (V1) | `recordActivity(...)` | **no access control** | Increment activity counters | **Needs redesign / Removable** — forge-able if deployed; `setCallerAuthorization` exists but is **not enforced** in `recordActivity`. V1 is superseded by V2 (which enforces `authorizedRouter`). Confirm V2/V3 are the mainnet checkers and retire V1. → ND-6. |
| `staking/RestorationActivityCheckerV2.sol`, `TaskActivityCheckerV3.sol` | `recordActivity*` | `authorizedRouter` only | Record activity | **Justified** — properly gated to the router. |
| `staking/*` (V2/V3, `TaskCoordinator`) | `setRouterAddresses` / `setAuthorizedRouter` / `setActivityChecker` / `setAntifarmingParameters` | `owner` | Repoint the trusted router / checker / tune anti-farming | **Justified** — required wiring; constrain by owner = Timelock at mainnet, and note these are the levers that decide reward eligibility (treat as sensitive). The `changeImplementation` swap behind these is the §2 upgrade finding. |
| `staking/JinnRouterV3.sol` | `transferOwnership`, `setActivityChecker` | `owner` | Repoint the checker the router consults | **Justified** — owner = Timelock; flagged sensitive. |

## 6. Vendored OLAS owner / whitelist surfaces

These carry OLAS's standard `owner` EOA → Timelock + veOLAS-Governor pattern. They are in Jinn's footprint **only** where Jinn deploys and owns the instance (Open per independent-launch §7). For every owned instance the rule is the same: **owner must be a Timelock/DAO, not an EOA**, and the whitelist/upgrade authorities below need DAO-gating or removal.

| Contract | Highest-leverage owned surfaces | Verdict |
|---|---|---|
| `vendor/tokenomics/Treasury.sol` | `withdraw` (drain reserves), `enableToken`/`disableToken`, `changeManagers`, `pause` | `withdraw` & token-whitelist **Needs redesign** (DAO/multisig); `pause` **Justified** (emergency, → DAO); `changeManagers` **Removable** (pin at construction). → ND-5. |
| `vendor/tokenomics/Tokenomics.sol` | `changeTokenomicsParameters`, `changeManagers`, `changeRegistries` | params **Justified** (→ Timelock); manager/registry repointing **Removable** (pin). → ND-5. |
| `vendor/tokenomics/Dispenser.sol` | `setDepositProcessorChainIds` (bridge whitelist), `changeStakingParams`, `setPauseState` | bridge whitelist **Needs redesign** (DAO); params/pause **Justified**. → ND-5. |
| `vendor/tokenomics/Depository.sol` | `create` (bond terms), `changeBondCalculator` | bond creation **Needs redesign** (DAO-gate terms). → ND-5. |
| `vendor/stolas/l1/Depository.sol` | `changeLzOracle`, `setDepositProcessorChainIds`, `createAndActivateStakingModels`, `setStakingModelStatuses` | privileged oracle + bridge + staking-model authorities **Needs redesign** (DAO-elect or immutable). → ND-5. |
| `vendor/stolas/l1/stOLAS.sol` | `initialize(...)` | **Needs redesign** — unprotected initializer (front-runnable); use a factory/guarded init. → ND-5. |
| `vendor/stolas/l2/StakingManager.sol` | `changeStakingProcessorL2` | **Needs redesign** — privileged processor repointing (DAO/immutable). → ND-5. |
| `vendor/registries/staking/StakingVerifier.sol` | `setImplementationsStatuses`, `setImplementationsCheck` | **Needs redesign** — the implementation whitelist is the guard against rogue staking contracts; owner-only disabling/whitelisting is a centralisation vector (DAO-gate). → ND-5. |
| `vendor/registries/staking/StakingFactory.sol` | `changeVerifier` | **Needs redesign** — repointing the verifier bypasses the whitelist (immutable/DAO). → ND-5. |
| `vendor/mech/MechMarketplace.sol` | `changeImplementation` (proxy upgrade), `setMechFactoryStatuses`, `changeMarketplaceParams` | upgrade & factory-whitelist **Needs redesign** (Timelock/DAO); params **Justified**. → ND-5. |

## C17 — is the launch governance surface minimal?

**Mostly, for the Jinn-authored core; not yet, accounting for upgradeability and the vendored stack.** The token/Governor/Distributor design is the minimal shape (one capped minter, Timelock-owned, self-amending-only governor). The gaps that keep C17 from "yes":

1. **Upgrade authority (§2)** — unguarded admin/owner implementation swaps override everything else. Resolve to immutable-or-timelocked-with-veto before mainnet.
2. **Owner handover (§1, §5, §6)** — every `owner` must be the Timelock/DAO at launch, verified on the launch checklist (minter-drift precedent).
3. **Vendored whitelist/withdraw authorities (§6)** — for every OLAS instance Jinn owns, DAO-gate the whitelists and treasury withdraw.
4. **Dead code (§1)** — delete `vendor/governance/JINN.sol` and retire activity-checker V1 to remove footguns.

"Anything that cannot be justified should be removed before launch, not after" (C17). The **Removable** rows above are exactly that list; the **Needs redesign** rows are the residual-but-required surfaces with their redesign direction named.

## C18 — is ve-JINN gauge voting the only directional channel?

**No, as currently designed.** §4 names the parallel channels: `VoteWeighting.removeNominee` (owner gauge-veto), `VoteWeighting.changeDispenser`, and — if deployed — `Lock.sol`'s owner-proxied propose/vote/withdraw. Additionally, `Distributor.setRatios`/`setWeights` (§1) are Timelock-discretionary *directional* emission levers sitting beside the gauge; they are bounded and deliberate, but C18 wants a ratified answer to whether directional emission should be **gauge-anchored** rather than discretionary. Closing the §4 owner channels and ratifying the §1 levers is the C18 launch-gate.

## C19 — what is the legitimate process for changing the governance architecture itself?

The Jinn-authored answer is already encoded and clean: **the Governor can only amend its own parameters through its own vote** (`onlyGovernance` setters routed via the Timelock — §1). There is no out-of-band meta-admin in the authored core. The open C19 items are (a) **who can swap a proxy implementation** (§2) — today an admin key, which is a *de facto* meta-governance surface that bypasses the Governor entirely, so it must be brought under the same Timelock-vote path or renounced; and (b) **the vendored owners** (§6) must be wired to the same Timelock so that changing them is a governance act, not an EOA action. C19 is satisfied when the *only* path to change any rule — including upgrades — is a passed proposal through the Timelock (or the rule is immutable).

---

## Needs-redesign register (→ follow-up issues)

Each entry below is filed as a follow-up issue linked to this spec. Grouped by redesign direction (not one row per table line — near-identical "point owner at the Timelock" items are consolidated into the coherent work unit).

- **ND-1 — Upgrade authority: timelock-gate or renounce all proxy implementation swaps.** `JinnUpgradeableProxy.upgradeTo`/`changeAdmin` (admin EOA, no delay, testnet-labelled), `RestorationActivityCheckerV2`/`TaskActivityCheckerV3` `changeImplementation`. Direction: route every swap through the Timelock + public-veto window, or pin immutable at mainnet (the `JinnRouterProxy` model). *Highest severity.*
- **ND-2 — Cross-chain claim trust path: delete under the sovereign pivot, or timelock-gate `setMessenger` if a bridged mainnet is retained.** Resolve against [`spec/2026-06-05-independent-blockchain-launch.md`](2026-06-05-independent-blockchain-launch.md).
- **ND-3 — ve-JINN gauge parallel channels: remove the owner gauge-veto.** `VoteWeighting.removeNominee` / `changeDispenser` / `changeOwner`. Direction: make gauge removal a governance/gauge decision or immutable policy; pin the dispenser; owner = Timelock or renounce. *C18 launch-gate.*
- **ND-4 — `Lock.sol` governance-power concentration: drop or de-owner for mainnet.** Owner-proxied `propose`/`castVote`/`withdraw`/`changeGovernor` is a parallel governance master. *C18.*
- **ND-5 — Vendored OLAS owner + whitelist surfaces: timelock-ify owners, DAO-gate whitelists, guard `stOLAS.initialize`.** Scoped to whichever OLAS instances Jinn deploys+owns at mainnet (gated on independent-launch §7).
- **ND-6 — Activity-checker access control: confirm V2/V3 are the mainnet checkers and retire V1.** `RestorationActivityChecker` (V1) `recordActivity` has no access control and `setCallerAuthorization` is defined-but-unenforced. Plus: delete `vendor/governance/JINN.sol`.

**Not filed as redesign issues** (captured here and surfaced to #222 as decisions, not contract redesigns): the C18 ratification of `setRatios`/`setWeights` (gauge-anchored vs Timelock-discretionary) and the C19 statement that the only path to any rule change is a Timelock proposal. These are `design`-shape decisions for the discussion, not contract changes.

## What this audit does not yet cover

- **Off-chain / operational keys.** Relayer signers, deploy EOAs, multisig membership and thresholds. The audit covers on-chain *surfaces*; who holds the keys behind `owner`/`admin` at launch is a separate operational-security artifact the launch checklist must pin.
- **The sovereign substrate's own governance.** Validator-set gating, chain-upgrade governance, and consensus-stake authorities on the Cosmos-EVM chain (independent-launch §5/§7) are governance surfaces *of the chain*, not of these contracts, and are out of scope here.
- **Economic abuse bounds.** This audit classifies *who can pull a lever*, not the full economic blast radius of each lever. The "what constrains its abuse" column is a one-line argument, not a parameter-by-parameter economic proof (that is C16 adversarial-review territory).
- **Vendored-instance ownership map.** Which OLAS instances Jinn actually deploys+owns at mainnet is **Open** (independent-launch §7); §6's verdicts are conditional on that map, which a follow-up must pin.
