# Jinn Minimum Viable Implementation on OLAS — Launch Proposal

> Status: **Adopted 2026-04-27** — all nine decisions walked and
> locked. **Scope is testnet-first** (Sepolia + Base Sepolia);
> mainnet launch is a future decision and not yet in beads. The
> locked architectural decisions hold for both the testnet deploy
> and any eventual mainnet deploy — only the deploy timeline and a
> few mainnet-specific tasks (external audit scoping, OLAS courtesy
> note, launch announcement) shift.
> Date: 2026-04-13 (updated 2026-04-27)
> Decision Record: `log/decisions/2026-04-27-jinn-mvi-on-olas-decisions.md`

> **2026-04-27 update — home chain + cross-chain shape.** JINN
> token, Governor, and Timelock deploy on **Ethereum mainnet** as
> the home of the protocol. `JinnDistributor` deploys on mainnet
> too; OLAS staking measurement remains on Base. Operator claim
> flow is two-tx: a permissionless `JinnClaimEmitter` on Base
> emits a `ClaimTicket(serviceId, snapshot, claimer)`; a
> `CanonicalOpStackMessenger` on mainnet validates the ticket
> against the OptimismPortal output root and the distributor
> mints. The messenger is a Governor-pluggable interface so
> faster proof systems (OP Succinct ZK proofs, third-party
> bridges) can be voted in later via standard 18-day flow. See
> Locked Decisions §9 for the full topology and the constraints
> any future messenger must satisfy.

## Proposal

**A reference implementation of the Jinn protocol with token +
governance on Ethereum (mainnet eventually; Sepolia first) and
measurement on Base (mainnet for the existing Phase 0 staking
instance; Base Sepolia for the testnet deploy).** Six contract
deploys — `JINN.sol`, `JinnDistributor.sol`,
`CanonicalOpStackMessenger`, `JinnClaimEmitter`, OpenZeppelin
`TimelockController`, and OpenZeppelin `Governor` — running on
top of the existing Jinn staking instance and unmodified OLAS
infrastructure. v0 ships testnet-first; mainnet launch is a
future decision and not yet scheduled.

**Every JINN that ever exists is minted in response to
measurable operator work.** No pre-mine. No team allocation. No
sale. No airdrop. JINN is deployed with total supply zero; the
distributor is the sole minter; JINN comes into existence only
through the two-step claim flow: a permissionless emitter on the
measurement chain (Base) records the service's accumulated OLAS
reward in a `ClaimTicket` event; a messenger on the governance
chain (Ethereum) validates that ticket via canonical OP-Stack
proof; the distributor reads `(serviceId, snapshot)` from the
messenger and mints. Each claim produces two mints
simultaneously: the majority share (75%) to the operator's
service multisig, and a fixed share (25%) to the DAO treasury.
Both mints happen in the same governance-chain redeem
transaction, subject to the same rules, with no shortcut. The DAO treasury grows
organically with network activity and is spendable only via
Governor vote.

**There are no admin keys.** Every admin action — changing the
minter, changing the ratio, upgrading to a new distributor — is
gated by an on-chain Governor vote. The Governor is controlled
one-token-one-vote by JINN holders, and the only way to get JINN
is to mine it. So governance is held by the people who
contribute to the network, in proportion to how much they
contribute. There is no team-as-entity at the protocol level —
no team wallets, no team treasury, no team allocation. Founding
members and contributors mine the same way anyone else does.

**This is not a stepping stone toward the "real" Jinn protocol —
it is the protocol, in its simplest valid form.** Jinn is
defined as a system where JINN incentivizes the creation and
satisfaction of intents. The contracts in this proposal do
exactly that, in a way that is auditable, fair, and upgradeable
through a credibly decentralized path from day one.

## Why this shape

The hard parts of running a measurement substrate are already
done by OLAS and already deployed on Base mainnet: service
registration, bond escrow, activity tracking, anti-farming,
eviction, checkpoint accounting. We use them as-is. That is
what makes the launch contract surface so small.

Four benefits:

1. **It's a legitimate launch.** Every JINN comes from measured
   work. There is no pre-allocation, no insider tranche, no
   special category of holder. Every JINN in existence has the
   same provenance: mined by running the daemon and doing intent
   work. The rules are the same for everyone, including the
   founding members and contributors who built the protocol —
   their only path to JINN is mining it on the same rails as any
   other operator.

2. **It's decentralized from day one.** No admin keys exist.
   There is no multisig in the critical path. The Governor
   contract controls the Timelock, the Timelock owns every
   mutable parameter, and the Governor is controlled by JINN
   holders. Anyone's governance weight is exactly proportional
   to how much they've mined.

3. **It ships the actual protocol, fast.** ~3 days of contract
   work plus operator UX in parallel. The bottleneck becomes
   the *uncertain* part of Jinn — whether the daemon, intent
   layer, and operator experience are actually any good — not
   the tokenomics machinery.


4. **Nothing is locked in.** OLAS is a substrate choice, not an
   architectural commitment. If OLAS ever becomes a constraint
   we can stand up our own copies of any piece (still unmodified
   OLAS bytecode; still not a fork) and migrate. The distributor
   itself is replaceable via a Governor vote — any future
   distribution mechanism can ship as a v1+ distributor without
   unwinding v0.

## What gets shipped

### Six bespoke contracts (across two chains)

Four on the governance chain (`JINN.sol`, `JinnDistributor`,
`TimelockController`, `JinnGovernor`) plus two on the
measurement chain / cross-chain layer (`JinnClaimEmitter` on
Base, `CanonicalOpStackMessenger` on the governance chain).

**1. `JINN.sol`** — new, ~60 lines. Inherits from OpenZeppelin
`ERC20`, `ERC20Permit`, `ERC20Votes`, and `Ownable`. **No
inflation cap.** Supply is exactly `total_work × ratio` with no
upper bound, in line with the locked Option B inflation model
(see Locked Decisions §2). `mint()` reverts only on access
control (caller != minter); no silent no-op, no
`inflationRemainder()` accounting. Deployed with:
- `minter = JinnDistributor`
- `owner = TimelockController`
- Total supply at launch: **zero**

**Testnet vs mainnet naming.** The constructor is parameterized
on `name` and `symbol` (`constructor(string name_, string symbol_, address initialOwner)`)
to disambiguate the v0 token from the Phase 1a JINN tokens
(`0xc3ae831f...` L1 / `0xAB9a01cd...` L2) that play the OLAS-
equivalent role in our testnet. Testnet deploys with `name =
"JINN (testnet)"`, `symbol = "tJINN"`. Mainnet deploys with
`name = "JINN"`, `symbol = "JINN"`. Driven by env vars
`JINN_TOKEN_NAME` / `JINN_TOKEN_SYMBOL` in
`scripts/deploy-jinn-mvi-l1.ts` with sensible defaults per
chain.

The switch from the solmate-based vendored JINN to an OZ-based
version is the cost of getting standard Governor compatibility
via `ERC20Votes` checkpoints. With Option B locked, we also drop
the vendored 1B-cap-then-2%/yr inflation logic — every JINN is
minted from measured work, full stop, with no cap regime to
calibrate against.

**Why this is reversible.** No supply schedule is encoded in
`JINN.sol` itself. The "schedule" is whatever the active
distributor implements; mint authority transfers via Governor →
Timelock → `JINN.setMinter(newDistributor)` under the standard
18-day flow. So a future Governor vote can swap in a v1
distributor that imposes a max-supply curve (Option C-style), a
halvings schedule, or any other shape — without touching the
token contract. The OLAS dependency is similarly localized: it
lives only in the v0 distributor's immutable `stakingContract`
parameter, and a v1 distributor can read any other measurement
source (Jinn-native staking, JinnRouter counters, off-chain
attestations, ZK proofs, multiple inputs combined).

**2. `JinnDistributor.sol`** — new, ~100–140 lines on the
governance chain (Ethereum). Core function (production shape):

```solidity
function claim(bytes calldata proof) external {
    (uint256 serviceId, uint256 olasEarned, address multisig)
        = messenger.verifyClaim(proof);

    uint256 entitledOperator = (olasEarned * operatorRatio) / 1e18;
    uint256 entitledDao      = (olasEarned * daoRatio)      / 1e18;
    uint256 owedOperator = entitledOperator - totalClaimedOperator[serviceId];
    uint256 owedDao      = entitledDao      - totalClaimedDao[serviceId];
    if (owedOperator == 0 && owedDao == 0) return;

    totalClaimedOperator[serviceId] = entitledOperator;
    totalClaimedDao[serviceId]      = entitledDao;

    if (owedOperator > 0) jinn.mint(multisig,    owedOperator);
    if (owedDao      > 0) jinn.mint(daoTreasury, owedDao);
}
```

The `messenger.verifyClaim(proof)` call is what bridges the
chain gap: it validates the proof against the canonical
OP-Stack output root for the measurement chain and recovers
`(serviceId, olasEarned, multisig)` from the `ClaimTicket` event
emitted by `JinnClaimEmitter` on Base. The rest of the function
is identical to a single-chain implementation: each claim mints
two parallel streams (operator + DAO) from the same measurement,
both accumulators independent per service, no double-claim path.

Note the `mint` (not `transfer`) — the distributor creates JINN
on demand on the governance chain. Operator UX is a two-tx flow:
emit ticket on Base, submit proof on Ethereum to mint. Any party
can submit the proof; it doesn't have to be the operator
themselves.

**Deploy-time immutable parameters:** `jinn`, `stakingContract`,
`serviceRegistry`, `daoTreasury` (set to the Timelock address).
Changing any of these means deploying a new distributor.

**Mutable parameters (Governor-controlled only):** `operatorRatio`
and `daoRatio`. Either can be voted up, down, or to zero at any
time via Governor proposal. No owner, no multisig admin, no
`withdrawDust`, no `pause`.

**Ratios at launch (Locked Decisions §1):**
- `operatorRatio = 0.75e18`, `daoRatio = 0.25e18`.
- **Total emission rate** = `operatorRatio + daoRatio = 1.0e18`
  → 1 JINN minted per 1 OLAS earned by a Jinn service. Clean
  unit relationship; easy to communicate.
- **Internal split** = 3:1 → for every 4 units of JINN minted in
  response to measured work, 3 go to the operator and 1 goes to
  the DAO treasury.

These are two independent knobs (total emission and internal
split). Both are Governor-mutable on the v0 distributor without
redeploying — the community can raise the total emission, change
the split, or zero out either side via standard 18-day proposal.

**Cross-chain components (§9 locked).** The snippet above is
the production claim function on the governance chain. The full
two-step flow involves three contracts across two chains:

- **`JinnClaimEmitter`** (measurement chain — Base mainnet
  eventually, Base Sepolia for the testnet deploy). Permissionless;
  anyone can call `emitClaim(serviceId)`. It reads the OLAS
  staking contract for the service's accumulated reward, looks
  up the service multisig from `ServiceRegistry`, and emits a
  `ClaimTicket(serviceId, snapshot, multisig, claimer)` event.
  No state, no storage — pure event emission.
- **`IClaimMessenger`** (governance chain — Ethereum mainnet
  eventually, Sepolia for the testnet deploy). Single function
  `verifyClaim(bytes proof) returns (uint256 serviceId, uint256 snapshot, address multisig)`.
  At launch, the concrete implementation is
  `CanonicalOpStackMessenger`, which validates proofs against
  the OptimismPortal output root (~7-day finality on mainnet,
  potentially seconds-to-hours on Sepolia testnet — to be
  measured during the cross-chain spec). No trust delta on top
  of L1 settlement.
- **`JinnDistributor`** (governance chain). Calls
  `messenger.verifyClaim(proof)` (see snippet above), then runs
  the per-service two-mint accounting and mints to the
  recovered multisig + DAO Timelock.

The messenger address is set behind a Governor-controlled
setter. Future proposals can swap the implementation to OP
Succinct (β2, ~tens of minutes, ZK prover trust) or a
third-party bridge (β3, minutes, validator-set trust) without
redeploying the distributor. See Locked Decisions §9 for the
full topology and constraints any future messenger must satisfy.

**Operator claim latency at launch is ~7 days** on mainnet —
the canonical OP-Stack proof window. The two transactions are:
(1) emit the ticket on Base, (2) submit the proof on Ethereum
to mint. Any party can submit the proof; it doesn't have to be
the operator. On testnet (Sepolia + Base Sepolia) the canonical
challenge period is much shorter; the cross-chain spec measures
the exact value and adds a `MockMessenger` fallback if testnet
finality is still impractical for CI.

**3. `TimelockController`** — OpenZeppelin, standard. Deployed
with `minDelay = 2 days`. Proposer and executor roles are held
by the Governor contract. The Timelock holds the `owner` slot
on `JINN.sol` and the admin role on `JinnDistributor`. Nothing
the Timelock does happens without a Governor proposal passing
first.

**4. `JinnGovernor`** — OpenZeppelin Governor, ~50 lines of
module composition. Inherits from `Governor`, `GovernorSettings`,
`GovernorCountingSimple`, `GovernorVotes`, `GovernorVotesQuorumFraction`,
`GovernorTimelockControl`. Deployed with the Locked Decisions §3
defaults.

**Mainnet:**
- Voting delay: 2 days (172,800 s) — public visibility window
- Voting period: 14 days (1,209,600 s)
- Proposal threshold: 0 JINN — anyone with any JINN can propose
- Quorum: 4% of `totalSupply` at the proposal block
- Timelock minDelay: 2 days
- Total observation window: 18 days

**Testnet (Sepolia / Base Sepolia) — compressed for iteration:**
- Voting delay: 60 s
- Voting period: 600 s (10 minutes)
- Proposal threshold: 0
- Quorum: 4% (same; structurally important to test)
- Timelock minDelay: 60 s
- Total observation window: ~12 minutes

These are the same defaults Doppler (and most OZ-Governor-based
protocols) use on mainnet. The compressed testnet values let a
full proposal cycle complete in a single CI run while still
exercising the same code path. All five values are
Governor-mutable post-deploy via self-governance.

**Total bespoke Solidity: ~330–370 lines.** Breakdown:
- `JINN.sol` ~60 lines.
- `JinnDistributor.sol` ~100–140 lines.
- `JinnGovernor` ~50 lines (OZ module composition).
- `JinnClaimEmitter` ~30 lines (event-emit only, no state).
- `CanonicalOpStackMessenger` ~80–120 lines (OptimismPortal
  proof validation, with reusable scaffolding for future
  messenger swaps).
- `IClaimMessenger` interface and shared types ~10–20 lines.

The `TimelockController` is unmodified OZ. Each bespoke contract
does one thing and has clear invariants — bounded audit scope.

### Already on Base mainnet, reused as-is

| Contract | Address | Role |
|---|---|---|
| Jinn staking instance | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` | Source of per-service OLAS reward measurement |
| Activity checker proxy | `0x477C41Cccc8bd08027e40CEF80c25918C595a24d` | Anti-farming gate (currently V1; Base Sepolia equivalent is upgraded to V2 in v0 critical path per Locked Decisions §6; Base mainnet upgrade deferred until mainnet decision) |
| JinnRouter | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` | Activity counter source |
| OLAS ServiceRegistry | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` | Service registration + multisig lookup |
| OLAS ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` | Token-agnostic bond accounting |
| OLAS ServiceManager | `0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6` | Service create/activate/register flow |
| OLAS MechMarketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` | Request/delivery substrate |
| OLAS token | `0x54330d28ca3357F294334BDC454a032e7f353416` | Service bond token |

### Pre-launch hardening

- **Activity checker proxy V1 → V2** for Hamming-distance
  anti-farming. **In the v0 critical path on Base Sepolia** per
  Locked Decisions §6 (`jinn-mono-pwg`); the equivalent Base
  mainnet upgrade ships when mainnet decision is back on the
  table. The V2 implementation lives behind the existing
  staking-proxy address on each chain, so no address changes
  elsewhere.
- **Upgrade JinnRouter to V2** if any V2 functionality is
  required (still optional; not in the critical path).

## Governance — no team keys, decentralized from day one

**The Governor contract is the only admin in the system.** Every
mutable parameter is gated by a Governor proposal, which goes
through the full flow: voting delay → voting period → timelock →
execution. On the eventual mainnet deploy the parameters resolve
to a **18-day total observation window** from proposal creation
(2d delay + 14d vote + 2d timelock). On the testnet deploy the
same flow runs with compressed parameters (~12-minute total)
exercising the same code path so CI can fit a full proposal
cycle in a single run. During the observation window — long or
short — anyone can see the change coming and react: vote against
it, socially coordinate, stop running the daemon, claim
outstanding rewards, etc.

**Parameters and governance:**

| Parameter | Mutable? | Who decides | Delay |
|---|---|---|---|
| `jinn`, `stakingContract`, `serviceRegistry`, `daoTreasury` in the distributor | No | — | Immutable at deploy |
| `minter` on `JINN.sol` (upgrade path to new distributor) | Yes | Governor proposal | 18 days total |
| `operatorRatio` in `JinnDistributor` | Yes | Governor proposal | 18 days total |
| `daoRatio` in `JinnDistributor` | Yes | Governor proposal | 18 days total |
| `owner` of `JINN.sol` / `JinnDistributor` | Yes | Governor proposal | 18 days total |
| Governor parameters (quorum, delay, period, threshold) | Yes | Governor proposal (self-governance) | 18 days total |
| Use of JINN accumulated in the DAO treasury | Yes | Governor proposal | 18 days total |
| Discretionary admin (`withdrawDust`, `pause`, etc.) | — | — | **Does not exist** |

(The `tenYearSupplyCap`/`maxMintCapFraction` row from earlier
drafts is removed — no inflation cap exists in the Option B
locked design.)

**Voting power:** one JINN, one vote. Vote weight is tracked by
OZ's `ERC20Votes` checkpoint system — your voting power at any
given block is equal to your JINN balance at that block. No
locking required. Operators automatically gain governance weight
as they mine JINN, and automatically lose it if they sell or
transfer.

**Who governs at launch?** At deploy, total JINN supply is zero
and nobody has voting power. The Governor exists but can do
nothing until the first operator mines some JINN and the
proposal threshold (0) is passable. Early in the network,
governance is dominated by whoever has mined the most — which
is the honest reflection of who's contributed the most. As the
operator set grows, governance naturally decentralizes.

**Worst-case behavior under key compromise:** there are no keys
to compromise. No participant has admin power that other
operators don't also have, proportionally to their mined JINN.
A hostile actor would need to acquire enough JINN (by mining it,
or buying it from operators who chose to sell) to pass a
proposal and hold it for the full 18-day observation window.
That is the same threshold any other attacker would face. There
is no shortcut through an admin multisig.

**No team-as-entity (Locked Decisions §4).** Jinn is a
decentralized protocol with founding members and contributors,
not a company-with-a-team. There is no team treasury, no team
wallets, no "team mining policy" — the question is moot because
the protocol mints JINN identically regardless of who's mining.
Founding members run operators on the same rails as anyone else
and accumulate governance weight in proportion to their measured
work, like any other participant.

**The DAO treasury.** Every claim mints JINN to two destinations
at the same time: the operator's service multisig (at
`operatorRatio`) and the Timelock (at `daoRatio`). At launch
the split is **3:1** — for every 4 units of JINN minted, 3 go
to the operator and 1 goes to the DAO treasury. The treasury
JINN is held in the Timelock, which is controlled by the
Governor. Governor votes decide what to do with it. Plausible
uses:

- **Contributor grants, audits, infrastructure, bug bounties.**
  Operational funding that doesn't require a pre-allocation.
- **Retroactive rewards for Phase 0 operators** or other early
  contributors, if the community votes to distribute part of
  the treasury that way.
- **Ongoing protocol development.** Paying for v1+ distributors,
  client improvements, security reviews.
- **Liquidity bootstrapping** under the constraints in Locked
  Decisions §5 (see below) — once the DAO has accumulated enough
  JINN AND a path exists for the DAO to acquire pairing assets,
  the Governor can authorize a dump-resistant liquidity event.

This preserves the mining principle — no shortcut, no pre-mine,
no allocation — while giving the DAO a credible path to
organic funding. The DAO's JINN has the same provenance as
every operator's: minted in response to measured work, at a
ratio set by Governor vote.

**Liquidity-event posture (Locked Decisions §5).** No on-chain
JINN market exists at v0 launch. Any future liquidity event must
satisfy the dump-resistance constraint: the DAO is not the
primary exit liquidity for operator selling. Mechanisms with a
"DAO supplies pairing asset + market opens at high price" shape
— LBPs, fixed-price buybacks, one-sided liquidity provision —
are rejected because operators (holding ~3× DAO holdings at the
3:1 split) would rationally dump into them and drain DAO
reserves at a peak price. Acceptable shapes (to be selected in a
follow-up spec): Protocol-Owned Liquidity, vested bond
mechanisms, concentrated liquidity with tight bands, off-chain
OTC desks for early operator exits. Operators are free to OTC
their mined JINN bilaterally at any time; the protocol just
doesn't subsidize that path with treasury-funded liquidity.

**Framing check:** the DAO's share is not a tax on operator
earnings. Operators receive exactly `operatorRatio` JINN per
unit of OLAS measured — that number is what operators earn. The
DAO's share is a separate, parallel mint at its own `daoRatio`,
minted in the same transaction but tracked independently. If
the community ever decides they don't want DAO accumulation,
they can vote `daoRatio` to zero and the DAO stream stops —
without affecting what operators earn.

## How operators experience it

The design target is **standard mode (stOLAS-backed, JINN-only
operator UX)** — already implemented in
`client/src/earning/bootstrap.ts` (commits `ad067cdf` onward),
waiting on stOLAS mainnet deployment. In standard mode an
operator never bonds OLAS, never holds OLAS, never thinks about
OLAS — they just run the daemon and earn JINN.

**Standard mode (design target):**

1. Operator funds their EOA with ETH for gas. No OLAS required.
2. Operator runs the daemon. stOLAS handles the bonding side
   transparently — the operator's service is bonded with OLAS
   provided by stOLAS, with no manual step on the operator's
   part.
3. Service accumulates OLAS rewards (operators don't see or
   touch them; what ultimately happens to those rewards is an
   open decision — see Locked Decisions §10).
4. **On the measurement chain (Base):** anyone — operator,
   relayer, or another participant — calls
   `JinnClaimEmitter.emitClaim(serviceId)`, which emits a
   `ClaimTicket` event recording the service's accumulated
   OLAS-earned snapshot.
5. **On the governance chain (Ethereum):** anyone submits the
   ticket plus a canonical OP-Stack proof to
   `JinnDistributor.claim(proof)`. The messenger validates the
   proof, the distributor performs the two-mint accounting, and
   JINN flows to the operator's service multisig (75%) and the
   DAO Timelock (25%) in the same governance-chain transaction.

The mainnet operator latency from "ticket emitted" to "JINN in
wallet" is bounded by the canonical OP-Stack challenge period
(~7 days at v0 launch). On testnet that window is much shorter.
The daemon's `reward-claim-loop.ts` adds two new claim targets
(emit on Base, redeem on Ethereum); operators don't need to
manually orchestrate either step.

**v0 testnet path: standard mode is the default.** The
JINN-deployed stOLAS clone on Base Sepolia
(`0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81`) is live and
operational; the daemon's earning bootstrap defaults to
`stakingMode = 'standard'` (`client/src/earning/bootstrap.ts:138`).
Self-bond mode (Phase-0/1a-style, where the operator bonds OLAS
themselves via the 11-step earning bootstrap) remains supported
as a permissionless fallback for operators who don't want to go
through stOLAS, but is not the default. The cross-chain claim
flow is identical in either case; only the bonding side differs.

**v0 testnet messenger: mock-mode for fast iteration.** v0
testnet currently runs `JINN_MESSENGER_MODE=mock`: the daemon
plants fixtures directly in `MockMessenger` on Sepolia rather
than waiting for canonical OP-Stack finality (~7 days). This is
strictly a test-iteration shortcut — `MockMessenger` is not
deployed on mainnet. Mainnet uses `CanonicalOpStackMessenger`
exclusively, with full storage-proof + dispute-game finality
(see "Cross-chain" under Locked Decisions §9). The daemon
flips to canonical mode via env config; no contract change
required at the daemon level.

**OLAS disposition in standard mode (Locked Decisions §10).**
**Closed 2026-04-29** — see
[`log/decisions/2026-04-29-olas-disposition-25-burn-self-bond.md`](../../log/decisions/2026-04-29-olas-disposition-25-burn-self-bond.md).

- **Standard mode (stOLAS-backed):** 25% stOLAS depositor yield,
  75% burn, 0% operator. Operator-paid-in-JINN-not-OLAS
  invariant holds.
- **Self-bond mode (operator-bonded):** 100% to operator-as-
  curating-agent. They put up their own collateral; they earn
  the yield.
- **Selection rule:** curating-agent identity. stOLAS-as-
  curating-agent → standard split applies; any other curating-
  agent → self-bond rule applies.
- **Burn target:** TBD at implementation; default per DR is a
  dedicated `IrrevocableBurnVault` calling `OLAS.burn`. Testnet
  uses `0x000000000000000000000000000000000000dEaD` as a
  shortcut.

The v0 distributor's per-service accounting is independent of
where the OLAS ends up; this decision affects the operator/
depositor economics around Jinn services, not the JINN minting
flow. Implementation tracked in `jinn-mono-1yn`.

**Governance participation.** Any operator holding JINN
automatically has voting power on mainnet. No lockup required.
If they want to propose a change, they propose; if they want to
vote, they vote. The daemon can eventually add a `jinn vote`
command that reads pending proposals and helps operators
participate.

## Tradeoffs

**What the mining-only + Governor model gives up:**

- **No pre-allocation to anyone.** Total supply at launch is
  zero, and the only path to JINN — for founding members,
  contributors, or anyone else — is mining it through operator
  services. Operational expenses (contributors, audits,
  infrastructure) can be funded from the DAO treasury via
  Governor vote, but only once the treasury has accumulated
  meaningful balance.
- **No fixed supply ceiling.** Per Locked Decisions §2 (Option
  B), there is no inflation cap. Supply is bounded only by
  network activity × ratio. Token-holder dilution narrative
  must be argued from "ratio governance" rather than from a
  hardcoded ceiling. Escape hatch: a v1 distributor with a
  schedule (Option C-style) can ship via Governor proposal if
  the community ever decides a ceiling is desirable.
- **No immediate launch liquidity.** JINN exists but isn't
  immediately tradeable. The first liquidity event must satisfy
  the §5 dump-resistance constraint — the DAO is not the
  primary exit liquidity for operator selling, which rules out
  LBPs, fixed-price buybacks, and one-sided DAO-funded liquidity.
  Liquidity emerges via operator OTC trades (always available),
  or eventually via a Governor-authorized mechanism like
  Protocol-Owned Liquidity once the DAO has accumulated enough
  JINN AND a path exists for the DAO to acquire pairing assets.
  For the first period after launch, JINN has no on-chain market
  price; its value is implicit in "what operators believe it's
  worth."
- **Early governance is concentrated.** In the first weeks,
  very few operators have mined JINN, so a small number of
  addresses effectively control the Governor. This is honest
  — governance weight reflects real contribution — but it
  means early decisions happen under a small voter base.
  Decentralizes naturally as mining grows.
- **Counterparty exposure to OLAS.** We reuse OLAS's
  registries, manager, marketplace, and staking instance. If
  OLAS ever pauses or removes access, Jinn is affected.
  Mitigation: deploy our own copies later if needed (still
  unmodified bytecode; the daemon already supports arbitrary
  addresses via config).
- **Cross-chain operational complexity.** Token + governance on
  the governance chain and measurement on Base mean the
  production claim path crosses chains. Operator latency from
  ticket-emit to mint is bounded by the messenger's proof
  window — ~7 days at v0 launch under canonical OP-Stack
  messaging, Governor-swappable to ~minutes (β2/β3) later via
  standard 18-day flow. See §9 in the DR for the locked
  topology and constraints.

**What we don't give up:**

- **Legitimacy.** No pre-mine, no allocation, no sale. Every
  JINN has the same provenance: measured operator work.
- **Decentralization from day one.** No admin keys. No multisig
  in the critical path. All admin actions require Governor
  proposals held by JINN holders.
- **Anti-farming / anti-replay / anti-grief.** All inherited
  from the staking contract or guaranteed by the distributor's
  minting accounting.
- **Audit-ability.** ~330–370 lines of bespoke code across six
  small contracts, plus standard OZ `Governor` +
  `TimelockController` (audited upstream). Each bespoke contract
  does one thing; bounded scope.
- **Forward compatibility.** Every v1+ governance shape ships
  as a new distributor contract, proposed and activated via
  Governor vote. No v0 commitment forecloses any v1+ evolution.
- **Optionality on the substrate.** OLAS is a v0 convenience,
  not a permanent architectural commitment.

## What comes after v0

Each thing that's *not* in v0 has a clean v1+ path that ships
as a Governor proposal — deploy a new contract, propose its
activation, JINN-holding operators vote, if approved it goes
through the 18-day flow and activates.

- **Operator-weighted voting with time decay / ve-JINN.** A
  v1 distributor that uses a ve-JINN lock contract for vote
  weighting instead of raw balance. Proposed via Governor.
- **Multi-channel emission.** A v1 distributor that reads
  per-channel activity counters from JinnRouter (creation,
  delivery, evaluation) and emits at different rates per
  channel. Proposed via Governor.
- **Jinn-native staking, marketplace, registries.** Deploy
  fresh copies of the vendored OLAS bytecode under
  Jinn-controlled ownership. Operators migrate by re-registering.
- **Liquidity bootstrapping via Doppler or similar.** If the
  network eventually decides JINN should be tradeable with
  bootstrapped liquidity, the Governor can authorize minting
  a tranche into a Doppler launch, or pairing an existing
  holder's JINN into a Uniswap pool. Not in v0.
- **Time-scheduled inflation cap (Option C reversal).** If
  Option B's uncapped supply becomes a blocker for adoption,
  a v1 distributor with a max-supply curve can ship via
  Governor proposal under standard 18-day flow.

The principle: **prove the system first, accumulate
architectural commitments only as we learn what we actually
need.** v0 commits to mining-only distribution and OZ Governor
over a JINN-holding voter base. Everything else is a future
Governor proposal.

## Locked decisions

The nine load-bearing calls flagged in the original draft are
captured in detail in
`log/decisions/2026-04-27-jinn-mvi-on-olas-decisions.md`.
Summary table:

| #  | Decision                          | Answer                                                          | Status    |
|----|-----------------------------------|-----------------------------------------------------------------|-----------|
| 9  | Cross-chain coordination          | Topology β + β1 (canonical OP-Stack) at launch; messenger Governor-pluggable for β2/β3 | Locked |
| 2  | Inflation model                   | Option B — uncapped, work-driven forever                        | Locked    |
| 1  | Initial ratio split               | 3:1 (75% operator / 25% DAO) as drafted                         | Locked    |
| 3  | Governor parameters               | Doppler defaults (2d delay / 14d vote / 0 thresh / 4% quorum / 2d timelock) | Locked |
| 4  | "Team mining policy"              | Moot — no team-as-entity exists at the protocol level           | Locked    |
| 5  | Initial liquidity plan            | No action at v0 + dump-resistance constraint; mechanism deferred to follow-up spec | Locked |
| 6  | Optional checker upgrade          | Upgrade proxy to V2 on Base Sepolia pre-testnet-deploy; mainnet upgrade deferred | Locked |
| 7  | Coexistence framing with OLAS     | "Jinn is the agentic-intent training protocol, launched on OLAS infrastructure" — eventual public framing; comms deferred until mainnet is back in scope | Locked |
| 8  | `JINN.sol` rewrite details        | Pure mining ERC20Votes (Option B-conditional)                   | Locked    |
| 10 | OLAS disposition + standard-mode UX | Standard-mode (stOLAS-backed, JINN-only operator UX) is the design target. **OLAS disposition closed 2026-04-29** — standard-mode: 25% stOLAS depositor yield / 75% burn / 0% operator; self-bond: 100% to operator-as-curating-agent. See `log/decisions/2026-04-29-olas-disposition-25-burn-self-bond.md` | Locked    |

§9 constraints (any future messenger swap must satisfy):
1. Canonical voting power lives on mainnet.
2. Measurement source of truth is Base.
3. Two-mint accounting (operator + DAO) preserved end-to-end.
4. DAO treasury holds canonical JINN on mainnet.
5. Prefer canonical OP-Stack messaging at launch; faster
   alternatives via Governor proposal once we have data.

§9 known follow-ups (not blocking launch):
- **Testnet iteration cycle.** A 7-day canonical L2→L1 window on
  Sepolia / Base Sepolia would gut iteration. OP Stack testnets
  typically compress the challenge period (Optimism Sepolia is
  reportedly "a few seconds"); Base Sepolia's exact value to be
  confirmed in the cross-chain spec. If the testnet window is
  still impractical, the spec adds a `MockMessenger` path so
  daemon e2e and CI don't depend on the canonical bridge at all.
- **Base/base architecture migration risk.** Base announced
  2026-02-18 it's leaving the OP Stack. The pluggable-messenger
  pattern absorbs this — we vote in a new messenger when Base
  finalizes its replacement bridge.

## Timeline (testnet-first scope)

The 2026-04-27 scope narrowing targets a working v0 stack on
**Sepolia + Base Sepolia**. Mainnet is a future decision and not
yet on this timeline.

- **Phase A — Contracts: ~1–2 weeks** (parallel work).
  - Write `JINN.sol` (OZ-based, Option B, uncapped) — task `89r`.
  - Spec the cross-chain layer (`l6b`) → implement `JinnClaimEmitter`
    + `CanonicalOpStackMessenger` (`6lq`).
  - Implement `JinnDistributor.sol` (`olx`, blocked on `l6b`).
  - Deploy module for OZ Governor + Timelock with §3 testnet/
    mainnet params (`e0d`, blocked on `89r`).
- **Phase B — V2 anti-farming on Base Sepolia: ~1 week**
  (`pwg`, parallel with Phase A). Audit V2 implementation, deploy,
  execute proxy upgrade on Base Sepolia.
- **Phase C — Contract review: ~1 week** (`sz0`, after Phase A).
  Slither + threat model + Foundry invariants gate. External audit
  scoping deferred until mainnet decision.
- **Phase D — v0 testnet deploy + exercise: 2–4 weeks** (`r5z`).
  Deploy full stack on Sepolia + Base Sepolia with compressed
  Governor params (1m/10m/1m). Run end-to-end claim flow,
  end-to-end Governor flow, V2 anti-farming under simulated
  adversarial patterns. Measure Base Sepolia canonical L2→L1
  challenge period; add `MockMessenger` if testnet finality is
  still impractical.

**Realistic outside window for testnet-first scope: ~5–7 weeks**
from "decisions locked" to "v0 stack running end-to-end on
Sepolia + Base Sepolia."

**Mainnet timeline (not scheduled).** Once captain decides to
re-open the mainnet path, the additional pre-mainnet work is:
external audit firm engagement, OLAS pre-deploy courtesy note +
launch comms (per §7), Activity checker V2 upgrade on Base
mainnet (mirrors `pwg` but on the production proxy), and the
mainnet deploy ceremony itself. None of that is in beads today.

## Appendix: Verified facts about OLAS on Base mainnet

Verified by reading deployed bytecode on Base mainnet (chain
8453) via Blockscout source inspection and `read_contract`
calls.

1. **`StakingFactory.createStakingInstance` is permissionless**
   (vendored source line 185).
2. **`StakingFactory` permits `verifier = address(0)`**
   (constructor line 103–106). Bypassing the verifier is a
   config change, not a fork.
3. **`StakingVerifier` hardcodes OLAS as the only allowed
   reward token** (line 288). Irrelevant when verifier is
   zero or skipped.
4. **`ServiceRegistryTokenUtility.createWithToken` accepts any
   ERC-20.** Verified at `0x34C8…3dd5`.
5. **`ServiceManager.create()` accepts arbitrary ERC-20 or
   ETH.** Verified at impl `0x1eAc…Cbc29` behind proxy
   `0x1262…F6A6`. `paused == false`.
6. **`StakingBase._checkRatioPass` delegates all activity math
   to the checker** (line 456). No unit mismatch possible.
7. **`RestorationActivityCheckerV2.isRatioPass` is internally
   self-consistent** (1e18 scale on both sides, line 240–252).
8. **`MechMarketplace.create()` is whitelist-gated, but Phase 0
   already passed the gate** — Phase 0 has been delivering
   through this marketplace for months.
9. **Doppler's standard `GovernanceFactory` deploys an OpenZeppelin
   `Governor` + `TimelockController`** with defaults
   2d voting delay, 14d voting period, 0 proposal threshold,
   4% quorum fraction. The same stack can be deployed directly
   without Doppler's launch mechanism.

---

**One-line summary:** **The minimum viable implementation of the
Jinn protocol, launched in a legitimate and decentralized way** —
six bespoke contracts across two chains (governance chain:
`JINN.sol` ERC20Votes uncapped + `JinnDistributor.sol` +
`CanonicalOpStackMessenger` + OZ `TimelockController` + OZ
`Governor`; measurement chain: `JinnClaimEmitter`), sourcing
measured work from the existing Jinn staking instance on Base via
unmodified OLAS registries. **v0 ships testnet-first** (Sepolia +
Base Sepolia) under the locked architectural decisions; mainnet
launch is a future decision and not yet in beads. Every JINN is
minted in response to measurable operator work, split 75% to the
operator and 25% to a Governor-controlled DAO treasury that
accumulates organically. There is no pre-allocation to anyone and
no admin keys — Jinn is a decentralized protocol with no
team-as-entity, and all governance is held by JINN holders via
standard OZ Governor voting (compressed cycle on testnet; 18-day
observation window on the eventual mainnet deploy).
