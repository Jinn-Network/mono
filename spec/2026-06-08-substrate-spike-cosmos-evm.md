# Substrate spike — Cosmos EVM vs BeaconKit/reth: finding

- **Version:** 1.1
- **Date:** 2026-06-08
- **Author:** drafted with Opus, for Oak + Ritsu review
- **Shape:** `spike` — output is a *finding*, not merged code. Resolves the open sub-question in [`spec/2026-06-05-independent-blockchain-launch.md`](2026-06-05-independent-blockchain-launch.md) §2 / §9.1.
- **Status:** **Decided — Cosmos EVM.** Desk evidence (contract analysis + landscape research) plus the **empirical `evmd` run now done and CONFIRMED** (§5): all five port-target contracts deploy and run unchanged on a Cosmos EVM `evmd` v0.7.0 devnet with identical state and gas versus an independent EVM baseline. Residual confirms (Anvil re-run, v1.0 re-check, mech end-to-end, precompile-heavy paths) are noted in §5 but do not gate the decision.
- **Changelog:**
  - **v1.1 (2026-06-08)** — added the empirical result to §5: built `evmd` v0.7.0, deployed JINN/veJINN/gauge/router/checker unchanged, lock→vote→tick produced identical state (8/9 reads bit-identical; the lone delta is veOLAS time-decay from a ~14 s run gap, not divergence) and identical gas (bar three timestamp-sensitive sub-25-gas ops). No PUSH0/opcode/precompile issue. Flipped Status to **Decided**.
  - **v1.0 (2026-06-08)** — initial finding (desk evidence): recommend Cosmos EVM; the decisive factor is that BeaconKit/reth is consensus-only (no Cosmos SDK modules), foreclosing the bake-to-node plan.

---

## Recommendation (in plain English)

**Use Cosmos EVM. The lean was correct — and for a stronger reason than "one binary is simpler."**

The spike was framed as a trade-off: Cosmos EVM gives a *reimplemented* EVM in a single binary (fidelity risk, pre-v1), while a BeaconKit/reth build gives a *real* reth EVM at a two-component ops cost. The research collapses that trade-off:

1. **The "real EVM" path forecloses the thing we most want.** BeaconKit is a *consensus-only* client; with reth, all execution and state live in reth behind the Engine API. There is **no Cosmos SDK application layer** in that configuration — no `x/staking` / `x/slashing` / custom modules sharing the state machine, and no way for the EVM to call native module logic in-band. So the BeaconKit/reth path **cannot deliver the "bake protocol logic into the node via modules behind stateful precompiles" plan** that §3 of the parent spec is built on. The reimplemented EVM in Cosmos EVM is not a compromise — it is the *enabling* choice: by living *inside* the Cosmos SDK app, the EVM shares one multistore with the other modules, which is exactly what makes stateful precompiles (module logic callable from Solidity) possible.

2. **The fidelity risk is negligible for our actual contracts** (§3). They use none of the EVM features where reimplementations diverge.

The honest cost we accept: Cosmos EVM is pre-v1.0 and under audit (§4). That is a *timing* risk, manageable because genesis is not imminent — target the v1 (post-audit) release.

---

## 1. Why the symmetry breaks: real-EVM and Cosmos-modules are mutually exclusive

This is the load-bearing point, and it is architectural (not just a current-implementation accident):

- A **real reth EVM** keeps *all* EVM state and execution inside reth. Cosmos SDK modules keep their state in the SDK multistore — a *separate* state machine.
- The only channel between a BeaconKit consensus client and reth is the **Engine API** (`newPayload` / `forkchoiceUpdated`). That interface has no hook for "the EVM calls a Cosmos module mid-execution, atomically." So you cannot have reth-real-EVM **and** in-band Cosmos SDK module calls.
- **Cosmos EVM resolves this by reimplementing the EVM as a module inside the SDK app.** EVM and the other modules share one multistore; modules are exposed to Solidity as **stateful precompiles** (Cosmos EVM ships precompiles for staking, gov, distribution, bank, IBC, ERC20, and supports custom "EVM Extensions" — the documented pattern for exposing your own Go module behind a Solidity interface).

Consequence for Jinn: the bake-to-node path (start as EVM contracts → re-home the value-bearing logic into native Go modules behind precompiles, parent spec §3) is **native to Cosmos EVM and impossible on BeaconKit/reth**. That alone decides it.

*Confidence / open check:* the BeaconKit-is-consensus-only point is well-evidenced (Berachain mainnet, Feb 2025; BeaconKit README; Engine-API split) and architecturally sound, but it is the single most decision-relevant external claim — worth a 30-minute direct confirmation before closing reth out entirely. If some "reth-as-execution + Cosmos-SDK-app" hybrid exists with a module bridge, re-evaluate; nothing in the research suggested one does.

## 2. Precedent for "bake contract logic into the node"

- **dYdX v4 — the canonical precedent.** dYdX moved its central-limit-order-book and matching engine *out of* Ethereum contracts (v3 / StarkEx) *into* a Cosmos-SDK validator-run Go module, **`x/clob`**; every validator runs the matching engine. Confirms the pattern of value-bearing logic living in the node beside `x/staking`/`x/gov`. (It did this *natively*, not via an EVM precompile.)
- **Canto** built its DEX / lending / unit-of-account as **native chain modules** on an Evmos-derived EVM Cosmos chain — protocol logic in the node beside an EVM.
- **Honest gap:** there is **no clean, widely-cited precedent for the specific move we describe — "ship as a mainnet ERC20/contract, then re-home the value logic into a native module *behind a stateful precompile*."** dYdX was native-from-scratch; Canto native-from-genesis. The *capability* (custom stateful precompiles + module keepers) is productized and documented, but the *migration step* is comparatively novel. Implication: keep the bake-down as a later, separately-de-risked spike; for genesis we run the contracts as-is on the EVM module (the well-trodden path).

## 3. Contract-fidelity analysis (our actual port targets)

Grep over the port-target contracts — `JINN.sol`, `veOLAS.sol` (→ veJINN), `VoteWeighting.sol` (gauge), `JinnRouterV3.sol`, `TaskActivityCheckerV3.sol`, `JinnDistributor.sol` (~2,970 LOC):

| Feature (where reimplemented EVMs diverge) | Found in our contracts? | Verdict |
|---|---|---|
| Inline `assembly` | **None** | No low-level/gas-hack surface to mis-execute |
| `selfdestruct`, `create2` | **None** | — |
| Block-context opcodes: `prevrandao`, `block.difficulty`, `block.coinbase`, `block.basefee`, `tx.gasprice`, `block.gaslimit`, `blobhash` | **None** | The highest-divergence-risk class — entirely unused |
| Transient storage (`tstore`/`tload`, EIP-1153) | **None** | — |
| `ecrecover` | permit (EIP-2612) | Standard precompile 0x01 — supported |
| `delegatecall` | EIP-1967 proxies (`JinnRouterProxy`, `ActivityCheckerProxy`) | Standard — supported |
| PUSH0 (solc ≥ 0.8.20 default) | Yes (pragmas `^0.8.15` / `^0.8.25` / `^0.8.30`) | Cosmos EVM supports EIP-3855 |
| `block.timestamp` | **Heavy** (veOLAS 39×, VoteWeighting 14×) | Semantically fine — see note |

**Reading:** the contracts are clean, modern, standard Solidity. The one real dependency is **time**: veJINN locks and gauge weights are functions of `block.timestamp`. On CometBFT that is BFT median block time — monotonic and ~wall-clock, so the math behaves; the only action item is to **calibrate epoch/lock durations to the chain's actual block cadence** (not Ethereum's ~12 s). This is a parameter choice, not a fidelity bug.

**Net:** the documented Cosmos EVM divergences (gas-*estimation* differences, issue #765; missing EIP-7623 data-floor gas) touch tooling/estimation, **not** the execution semantics our contracts rely on. Fidelity risk for the port: **low**, pending the §5 empirical check.

## 4. Residual risks (and mitigations)

1. **Pre-v1.0 / audit-in-progress.** Cosmos EVM is v0.x (v0.5–v0.7 "Krakatoa"); v1 is targeted post-audit (a Sherlock audit covered v0.3; a new audit is live — the repo's `audit/all` / `audit/scope` branches confirm it). → **Target the v1 release for genesis**; track releases; do not pin to a pre-audit tag for mainnet.
2. **Gas-estimation divergence (#765).** Affects deploy-gas estimation and state-override calls, not native execution. → Verify in the §5 smoke test; our contracts do no gas introspection.
3. **`block.timestamp` cadence.** → Recalibrate veJINN/gauge/epoch durations to real block time (§3).
4. **Bake-down novelty.** No precedent for the precompile-migration step specifically (§2). → Separate, later spike; genesis runs contracts as-is.
5. **Throughput.** A single Cosmos EVM chain is low-thousands TPS at the base (v0.7 adds BlockSTM parallel execution, raising the ceiling). Per parent spec §4 the base is *settlement/attestation*, not execution — SolverNets-as-rollups carry volume — so base TPS need only clear the settlement floor. → §5 measures it as a sanity floor, not a scaling bet.

## 5. The empirical confirmation — done, CONFIRMED (2026-06-08)

**Result: CONFIRMED.** A live run built `evmd` and exercised the contracts on it against an independent EVM baseline. Headline: **all five port-target contracts compiled, deployed, and ran unchanged on Cosmos EVM with identical on-chain state and effectively identical gas — not one byte of contract change.**

- **evmd built and ran with no patches.** `cosmos/evm` @ tag **v0.7.0** ("Krakatoa"; `v1.0.0-rc2` exists but is an RC, so the newest *stable* tag was used), `make install` → `evmd` (cosmos-sdk v0.54.3). The shipped `./local_node.sh` brought up a single-node devnet with EVM JSON-RPC on `:8545`, **EVM chain-id 262144 (0x40000)**.
- **All five deployed unchanged** (live JINN is `jinn/token/JINN.sol`, an OZ-v5 `ERC20Votes`): JINN, veOLAS (=veJINN), VoteWeighting (gauge), JinnRouterV3, TaskActivityCheckerV3 — solc 0.8.25/0.8.30, Cancun (PUSH0 + Cancun opcodes live).
- **The lock→vote→tick loop produced identical state.** Run the *same* script against the baseline (Hardhat in-process EVM; Anvil isn't installed here) and evmd: **8 of 9 read-back values bit-identical** (locked amount, lock end, total supply, nominee weight, all activity/novelty weights). The lone differing value is veOLAS's *continuously time-decaying* `getVotes`, and the implied read-times back out to exactly the ~14 s gap between the two runs — a clock artifact, **not** an EVM-semantic divergence.
- **Gas identical** on 11/14 ops; the three deltas are all sub-25-gas and all on operations that write/branch on `block.timestamp` (veOLAS genesis point, VoteWeighting week-rounding) — i.e. timestamp-shift, not a different gas schedule.
- **No PUSH0 / opcode / precompile problem.** No `invalid opcode` / stack reverts; JINN runtime bytecode is live via `eth_getCode`. Jinn contracts occupy normal EVM address space and never collide with evmd's Cosmos stateful precompiles (`0x…0100/0400/0800…`).

**Caveats (do not gate the decision, worth a later pass):** baseline was Hardhat's EVM, not Anvil (re-run vs real Anvil for extra rigour — but identical state against an *independent* EVM impl already de-risks semantics); the "tick" exercised the activity checker directly (deployer-as-router), not the full `createTask → claim → deliver` mech+IPFS loop; tested on **evmd v0.7.0 only** (re-confirm against the v1.0 line before pinning an SDK version); ecrecover-in-contract and the Cosmos stateful precompiles were not stressed (own check if Jinn later relies on them). Sandbox note: the repo's own `contracts/` Hardhat toolchain couldn't be used directly here (`repo.yarnpkg.com` + `binaries.soliditylang.org` are network-blocked); compilation used the same solc versions/settings via the npm `solc` packages — a CI limitation, not a portability finding.

---

The procedure that was run (reproducible, ~half-day):

1. `git clone https://github.com/cosmos/evm` (reachable — confirmed); build `evmd`; run a single-node devnet.
2. Deploy, **unchanged**, via the existing Hardhat config: `JINN` → `veOLAS` (veJINN) → `VoteWeighting` (one gauge) → `JinnRouterV3` + `TaskActivityCheckerV3`.
3. Exercise the loop: lock JINN → gauge-vote → record an activity tick through the router → read back weights/escrow. Diff state against an Anvil baseline.
4. **Prototype the JINN bond+slash two ways:** (a) pure-contract escrow+slash on the EVM module (works today, no chain changes); (b) sketch the native route via `x/staking`+`x/slashing` behind the staking precompile (this is the validator-stake-slashing piece the §5 cold-start model wants native — the part most worth de-risking early).
5. Throughput sanity floor: rough base TPS on the devnet.

**Exit / flip criteria:** the recommendation stands unless (a) any of JINN/veJINN/gauge/router show *state* divergence or critical *execution*-gas divergence on evmd, or (b) the v1/audit timeline slips materially past our genesis window. Either flips us back to re-examining a real-EVM (reth) path — at the known cost of losing the Cosmos-module bake-to-node route.

## 6. Decisions for the parent spec

- §2 open sub-question (**Cosmos EVM vs BeaconKit/reth**): **resolved — Cosmos EVM** (empirically confirmed, §5). The deciding factor is not ops simplicity but that BeaconKit/reth forecloses Cosmos SDK modules + stateful precompiles, i.e. the §3 bake-to-node plan.
- §9.1 substrate spike: this document is the finding; the empirical run is **done — confirmed**. Remaining work is the later, separate *bake-down* spike (the EVM-contract → native-module migration mechanism — see the migration-framing note below).
