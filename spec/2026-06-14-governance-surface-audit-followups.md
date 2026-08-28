# Governance-surface audit — ready-to-file follow-ups + #222 comment

> **Status (2026-06-30): superseded by DR-2026-06-30 (tokenless, OLAS-native).** Jinn drops the native token and the sovereign chain; OLAS is the economic layer. For the current direction read `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md`.

Companion to [`2026-06-14-governance-surface-audit.md`](2026-06-14-governance-surface-audit.md) (spike [#223](https://github.com/Jinn-Network/mono/issues/223)).

This file holds the deliverables the spike produced that require an **external publish** (filing GitHub issues, posting to Discussion #222). They are drafted here verbatim and ready to post; a human (or an approved session) files them. They were not auto-filed because creating public issues / posting to a public discussion is an outward-facing action that this autonomous session is gated from performing without sign-off.

When filed, replace the `ND-N` references in the audit spec's register with the resulting issue numbers (a one-line edit per entry).

---

## Follow-up issues (one per Needs-redesign entry)

> Filing recipe (run after sign-off): `gh issue create --repo Jinn-Network/mono --title "<title>" --body "<body>"`. Set the Issue Type at create-time per the suggested shape, and link each back to `#223` and the audit spec.

### ND-1 — Timelock-gate or renounce all proxy implementation swaps
*Suggested shape: `refactor` · severity: highest*

**Context.** Surfaced by the governance-surface audit (`spec/2026-06-14-governance-surface-audit.md`, ND-1). Answers part of C17/C19 in Discussion #222. Upgrade authority overrides every other governance-minimisation property: whoever can swap an implementation can rewrite the contract.

**Surfaces.**
- `contracts/src/proxy/JinnUpgradeableProxy.sol` — `upgradeTo` / `changeAdmin`, gated only by an `admin` key with **no timelock / no veto** (docstring: "for testnet protocol components").
- `contracts/src/staking/RestorationActivityCheckerV2.sol` and `TaskActivityCheckerV3.sol` — `changeImplementation` (owner), swaps the logic that decides who earns.
- Contrast model: `JinnRouterProxy.sol` / `ActivityCheckerProxy.sol` pin the implementation at construction with no upgrade path.

**Acceptance criteria.**
- Each mainnet-live proxy is either made immutable (constructor-pinned, no `upgradeTo`) or has every implementation swap routed through the Timelock + a public-veto window.
- No mainnet-live proxy is upgradeable by a bare admin/owner EOA.

**Related:** audit spec ND-1 · Discussion #222 (C17, C19) · parent spike #223.

### ND-2 — Cross-chain claim trust path: delete under sovereign pivot or timelock-gate `setMessenger`
*Suggested shape: `design`*

**Context.** Audit ND-2. `JinnDistributor.setMessenger` (onlyOwner) swaps the contract that authenticates **every** claim. The whole cross-chain claim loop (claim emitter → OP-Stack messenger → distributor) is what `spec/2026-06-05-independent-blockchain-launch.md` §conclusion-3 deletes by putting mint + activity on one chain.

**Acceptance criteria.**
- Decision recorded: (a) **delete** the cross-chain claim loop under the sovereign-chain pivot (removing both the trusted-address anchor and `setMessenger`), OR (b) if a bridged mainnet is retained, gate `setMessenger` behind the Timelock + public-veto window.
- Verdict reconciled with the independent-launch spec's open items (§7).

**Related:** audit spec ND-2 · Discussion #222 (C17) · parent spike #223.

### ND-3 — ve-JINN gauge parallel channels: remove the owner gauge-veto
*Suggested shape: `refactor` · C18 launch-gate*

**Context.** Audit ND-3. C18 requires ve-JINN gauge voting to be the *only* directional channel; it currently is not.

**Surfaces (`contracts/src/vendor/governance/VoteWeighting.sol`).**
- `removeNominee` (owner) — deletes any gauge, zeroing its weight: a discretionary veto competing with the gauge vote.
- `changeDispenser` (owner) — repoints the reward sink the gauge feeds.
- `changeOwner` (owner, single-step) — transfers the above authority.

**Acceptance criteria.**
- Gauge removal becomes a governance/gauge decision or an immutable policy — not a bare owner key.
- The dispenser is pinned (or repointing is Timelock-gated).
- `owner` is the Timelock or renounced.

**Related:** audit spec ND-3 · Discussion #222 (C18) · parent spike #223.

### ND-4 — `Lock.sol` governance-power concentration: drop or de-owner for mainnet
*Suggested shape: `design` then `refactor` · C18*

**Context.** Audit ND-4. If `contracts/src/vendor/stolas/l1/Lock.sol` is deployed for Jinn, its `owner` proxies `propose` / `castVote` / `withdraw` / `changeGovernor` on behalf of locked tokens — a parallel governance *master*, the deepest C18 violation.

**Acceptance criteria.**
- Decide whether `Lock.sol` is in Jinn's mainnet deployment at all.
- If retained, de-owner it (no owner-proxied propose/vote/withdraw; no owner `changeGovernor`); if not, confirm it is excluded.

**Related:** audit spec ND-4 · Discussion #222 (C18) · parent spike #223.

### ND-5 — Vendored OLAS owner + whitelist surfaces: timelock-ify owners, DAO-gate whitelists, guard `stOLAS.initialize`
*Suggested shape: `refactor` · conditional on independent-launch §7*

**Context.** Audit ND-5/§6. The vendored OLAS stack carries OLAS's `owner` EOA → Timelock + Governor pattern. For every instance Jinn deploys+owns at mainnet, the owner must be a Timelock/DAO, and several whitelist/upgrade authorities need DAO-gating or removal.

**Highest-leverage surfaces.**
- `vendor/tokenomics/Treasury.sol` — `withdraw` (drain), `enableToken`/`disableToken`; `vendor/tokenomics/Dispenser.sol` — `setDepositProcessorChainIds`; `vendor/tokenomics/Depository.sol` — `create` (bond terms).
- `vendor/stolas/l1/Depository.sol` — `changeLzOracle`, `setDepositProcessorChainIds`, `createAndActivateStakingModels`, `setStakingModelStatuses`; `vendor/stolas/l1/stOLAS.sol` — unprotected `initialize`; `vendor/stolas/l2/StakingManager.sol` — `changeStakingProcessorL2`.
- `vendor/registries/staking/StakingVerifier.sol` — `setImplementationsStatuses` / `setImplementationsCheck`; `StakingFactory.sol` — `changeVerifier`; `vendor/mech/MechMarketplace.sol` — `changeImplementation`, `setMechFactoryStatuses`.

**Acceptance criteria.**
- First pin which OLAS instances Jinn deploys+owns at mainnet (gated on independent-launch §7).
- For each: owner = Timelock/DAO; whitelist/upgrade/withdraw authorities DAO-gated or made immutable; `stOLAS.initialize` guarded (factory/guarded init).

**Related:** audit spec ND-5/§6 · independent-launch §7 · Discussion #222 (C17) · parent spike #223.

### ND-6 — Activity-checker access control: confirm V2/V3 are the mainnet checkers, retire V1, delete vendored JINN
*Suggested shape: `chore`/`refactor`*

**Context.** Audit ND-6/§5. `contracts/src/staking/RestorationActivityChecker.sol` (V1) `recordActivity` has **no access control**, and its `setCallerAuthorization` is defined but **not enforced** in `recordActivity` — forge-able if deployed. V2/V3 enforce `authorizedRouter`. Separately, `contracts/src/vendor/governance/JINN.sol` is the superseded OLAS-vendored token (single-step `changeOwner`, built-in inflation) and must not be deployed.

**Acceptance criteria.**
- Confirm V2/V3 (authorizedRouter-enforced) are the mainnet activity checkers; retire/remove V1 or document why it cannot be deployed.
- Delete `vendor/governance/JINN.sol` (or clearly mark deploy-forbidden).

**Related:** audit spec ND-6/§5 · Discussion #222 (C17) · parent spike #223.

---

## Discussion #222 — summary comment (ready to post)

> Post to https://github.com/Jinn-Network/mono/discussions/222 after sign-off.

**On-chain governance-surface audit — answers to C17–C19 (spike #223)**

The full enumeration + classification is in [`spec/2026-06-14-governance-surface-audit.md`](https://github.com/Jinn-Network/mono/blob/main/spec/2026-06-14-governance-surface-audit.md). Every discretionary on-chain surface (admin roles, upgrade paths, parameter setters, pause/emergency, mint/burn/withdraw) is classified **Justified / Removable / Needs redesign**. Headline answers:

**C17 — is the launch governance surface minimal?** *Mostly, for the Jinn-authored core; not yet overall.* The token + Governor + Distributor design is the minimal shape — one capped minter (the Distributor), Timelock-owned, a stock OZ Governor that can only amend its own rules through its own vote. The gaps that keep C17 from a clean "yes":
1. **Upgradeability is the dominant surface.** Several proxies (`JinnUpgradeableProxy`, the `Implementation`-based activity checkers) let an admin/owner key swap the implementation with **no timelock and no veto** — one is even labelled "for testnet components." This silently overrides every other minimal property. Fix-or-renounce before mainnet (ND-1, highest severity).
2. **Owner handover.** Every `owner`/`admin` must be the Timelock/DAO at launch, verified on the launch checklist (the 2026-04-21 minter-drift incident is the precedent).
3. **Vendored OLAS whitelist/withdraw authorities** need DAO-gating wherever Jinn owns the instance (ND-5).
4. **Dead code** (`vendor/governance/JINN.sol`, activity-checker V1) should be deleted/retired (ND-6).

**C18 — is ve-JINN gauge voting the only directional channel?** *No, as currently designed.* `VoteWeighting.removeNominee` is an owner gauge-veto; if `Lock.sol` is deployed, its owner proposes/votes/withdraws on behalf of locked tokens. Both are discretionary channels that bypass the gauge vote (ND-3, ND-4). Separately, `Distributor.setRatios`/`setWeights` are bounded but Timelock-discretionary *directional* emission levers — C18 wants a ratified decision on whether directional emission should be **gauge-anchored** rather than discretionary.

**C19 — legitimate process for changing the governance architecture itself?** The authored core already encodes the right answer — the Governor amends only its own parameters, only through its own vote via the Timelock; there is no out-of-band meta-admin. The open C19 work is to bring the **proxy-upgrade path** (today a bare admin key, a de-facto meta-governance bypass) and the **vendored owners** under that same Timelock-vote path, or make them immutable. C19 is satisfied when the only path to change any rule — including upgrades — is a passed proposal through the Timelock.

**A large class of surfaces disappears under the sovereign-chain decision** ([`spec/2026-06-05-independent-blockchain-launch.md`](https://github.com/Jinn-Network/mono/blob/main/spec/2026-06-05-independent-blockchain-launch.md)): the cross-chain claim loop (emitter → OP-Stack messenger → `setMessenger`) is exactly what putting mint + activity on one chain deletes. Audited as-built they are trust surfaces; under the pivot they are **Removable** (ND-2).

Filed follow-ups (one per Needs-redesign entry): ND-1 … ND-6 — see the audit spec's register. *(Replace with issue numbers once filed.)*
