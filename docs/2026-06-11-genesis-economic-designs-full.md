# Five genesis economic designs — full texts

- **Date:** 2026-06-11
- **Status:** Appendix to [`2026-06-11-genesis-economic-designs-ranked.md`](2026-06-11-genesis-economic-designs-ranked.md). The five designs verbatim as produced by the designer agents, in rank order. Attack reports and judge verdicts are summarised in the ranked doc; raw versions live in the workflow transcripts.

---

# 1. Watermill

**Tagline:** JINN mints only against settled demand; the same non-recoverable fee that mints it funds the validators who settle it — no flow, no flour.

## Philosophy

Fee-anchored minimalism taken to its terminus. The only exogenous value entering Jinn is the creator's non-recoverable fee, so everything denominates there: supply is a closed-form function of cumulative settled fees, security income is the fee itself, and every JINN ever minted was minted to someone who completed fee-funded verified work. Any component whose job is to manufacture token demand — the veJINN amplifier above all — is deleted rather than weakened, because a mechanism that exists to justify its own token is reflexive by construction. The token is a claim on the fee stream; the fee stream is the only thing that mints it.

## Mechanism

### Emission Policy

One supply curve, no epochs, no budget B, no steering. Let F = cumulative settled non-recoverable fees (USDC units, on-chain counter). Marginal mint ratio r(F) = r0/(1+F/F0)^2. When a task with non-recoverable fee f settles against its declared oracle, the protocol mints M(f) = integral of r over [F, F+f] JINN to the solver(s) of record, and advances F. Closed form: total supply S(F) = S_max * F/(F+F0), with S_max = r0*F0 — a hard cap approached only in the limit of infinite cumulative demand.

Properties, all load-bearing:
1. Zero demand mints zero, forever — no free-standing subsidy exists anywhere in the design.
2. The curve is demand-indexed, not time-indexed — early fee-funded work mints far more JINN per fee-unit, which is the entire early-solver incentive (Bitcoin's early-era logic without the clock).
3. The integral is path-independent, so splitting, batching, or bundling fees changes nothing.
4. Mint occurs at settlement, fee is forfeited at posting — a posted-but-failed task's fee still distributes to stakers but never mints (conservative leak).

100% of mint goes to solvers of fee-bearing settled tasks. Validators receive no mint, ever. Fees posted by anyone — including a self-dealer — drive the same mint: the design openly reframes wash-minting as a continuous primary auction (see solves.degeneracies).

### Token Value Anchor

Three legs, all measurable on chain:
1. **Staking claim on the fee stream:** 100% of every non-recoverable fee distributes in USDC, via x/distribution, pro-rata to bonded consensus power. Staked JINN is a perpetual claim on protocol demand denominated in real money — a cash-flow asset valued by DCF on public chain data, not a governance hope.
2. **Gas:** JINN is the sole native gas token.
3. **A structural price corridor:** the floor is the capitalised staking flow; the ceiling is the open mint-arbitrage channel at ~1/r(F) — if market price exceeds 1/r, anyone can surrender fees to mint at par, with proceeds flowing to stakers and F advancing. The ceiling rises quadratically in cumulative demand, so holding JINN is precisely a position on the network's lifetime settled demand and nothing else.

Exogenous value enters at exactly one gate: creators surrendering USDC fees.

Illustrative calibration (flagged as such, not asserted): F0 = $25M cumulative fees, r0 = 4 JINN/USDC gives S_max = 100M JINN and a genesis mint-parity price of $0.25.

### Security Budget

The entire non-recoverable fee funds security: 100% routes to bonded consensus power (validators + delegators) in USDC, plus gas. Security income is therefore proportional to settled volume in the same unit as value-at-risk — the Problem 3 lead adopted whole, with no competing claim from solvers (who take the mint) or a third pie-slice to size.

Cost-of-attack = acquiring one-third of bonded JINN, whose market value is the market's multiple on the fee stream; value-at-risk per attack = in-flight escrow, roughly days of volume. Any sane multiple keeps attack unprofitable; the dangerous regime is multiple-collapse (price crash while volume holds), which is met by a public on-chain monitor (bonded value vs in-flight escrow) rather than a price oracle — a deliberate refusal to put a manipulable price feed in consensus.

Pre-F0, fee distribution flows to the work-weighted genesis bonds (see bootstrap), so the people securing the thin-value chain are funded by exactly the volume they secure.

### Bootstrap

Genesis sequence, concretely:

**(0) Pre-genesis:** a published, permissionless final-testnet window; any operator landing oracle-verified merged work enters the genesis file with consensus weight proportional to verified-work share, instantiated as non-transferable, fee-earning, expiring "genesis bonds" (not JINN, no premine). Founders solve no tasks, hold zero tokens and ~zero weight; their record, like everyone's, is the public oracle log.

**(1) Block 1:** supply = 0 JINN; genesis-bond validators produce blocks; min-gas = 0 by genesis validator policy (standard new-chain practice), so the chain is usable before any JINN circulates.

**(2)** Founders, named openly as the only creators at genesis, post the first Jinn-repo coding tasks funded in Noble USDC over IBC: bounty + fee (fee = phi of funding, forfeited at posting).

**(3) First settlement:** bounty USDC settles to the external solver; fee USDC distributes to genesis-bond power; the first JINN in existence mints to that solver at the curve's richest ratio.

**(4)** Solvers bond minted JINN; economic stake begins accruing alongside genesis bonds.

**(5) Handoff** is demand-indexed, not scheduled: genesis bonds expire when F crosses F0 — i.e. when half the terminal supply has been work-minted — after which consensus power is bonded JINN only.

No founder discretion exists anywhere in the sequence; the single privileged artefact (genesis bonds) is work-earned, permissionlessly entered, fee-only, non-transferable, and demand-sunset.

Market genesis: no LBP, no liquidity mining (refused as free-standing subsidy); first float is solver-minted JINN, secondary liquidity via IBC DEXes, and the mint-arbitrage channel provides a protocol-native primary price that also caps thin-float pumps.

### Evaluation

Deferred, and safely — this is the design's central structural claim. The mint prices fees, not work-claims: a fake task with a rigged oracle that "settles" mints exactly what its surrendered fee buys, never more, so evaluation failures cannot fool the money printer. Evaluation protects buyers (the creator's bounty) and workers (against rigged refusal), not the issuance.

Therefore: v1 settlement is the task's declared oracle (at genesis, the Jinn repo's public CI/merge — founder-controlled, named honestly, and the founders are wagering their own USDC on it); protocol-assigned, bonded, slashable evaluators ship in Phase B.2 as an opt-in service when third-party creators with weaker oracles arrive, funded by a split of phi at that point.

Until then SolverNet quality is policed by the market boundary: solvers choose which nets' bounties to trust, exactly as the launch docs intend ("select good nets economically, not police oracles").

### Settlement Currency

USDC for bounty and fee; JINN for gas only.

Stance owned explicitly: Noble USDC over IBC — light-client transport, no multisig lock-and-mint bridge — is the least-bad real-money leg available to a sovereign Cosmos chain, and a real-money fee is non-negotiable for this design because the fee IS the value anchor.

Consequences accepted: Circle/Noble can freeze the escrow path and halt settlement (not the chain, not the token ledger, not staking); fee-asset substitution requires a hard fork by validator adoption — deliberate friction, not a governance toggle; F carries over 1:1 to any successor fee unit.

Deliberate corollary: creators never need JINN to use the network (no utility-demand theatre, no toll on new creators); token demand must be carried entirely by the fee-stream claim, and the design accepts that burden in the open.

### veJINN Role

**Killed, not kept and not deferred.** Honest audit of its candidate jobs:
- Steering emissions by gauge — already dead (Curve/Convex result).
- Amplifying funded demand — the weak-amplifier branch's own arithmetic caps the honest creator's benefit below simply raising the bounty, so the amplifier survives only as a machine for manufacturing token demand, which is the reflexivity this philosophy exists to refuse.
- "Sink" and "skin in the game" — not jobs.

The one lock with an honest job is Cosmos x/staking bonding with its unbonding window: it secures consensus and earns the fee stream. Locked time as the un-splittable anti-sybil resource survives there, and only there.

### Anti-Capture

**Founders:** zero tokens, zero genesis weight, no admin path — their only head-start is knowledge and control of the genesis SolverNet's oracle, which is per-net, public, and competed (anyone can launch a net from day 1).

**Emissions-direction capture:** the surface is deleted — mint follows fee mechanically; there is nothing to vote on, bribe, or sybil. Work-mint is sybil-neutral (oracle throughput gates it; five identities doing the work of one mint the same).

**Whales:** a large staker can wash-mint at an effective discount (named in residuals) but acquires only holdings, not direction; and capturing the chain captures a venue whose demand — the fee flow from creators who can exit to a fork or competitor — walks out on capture: the asset under contest is a flow that leaves, not a stock that can be seized.

**Cosmos gov module, explicitly:** all economic constants (phi, F0, r0, curve shape, fee asset, fee routing) are compiled into the binary, outside the gov-mutable parameter space — changing them is a hard fork requiring validator adoption, maximally visible; gov retains text/signalling, consensus housekeeping, and upgrade proposals only.

**Pre-F0 synergy:** while supply is thin and token-gov would be cheap to buy, consensus power is work-weighted genesis bonds, not stake — so an early token-gov capture cannot force an upgrade onto the validator set. Plus the standing defences: long unbonding holds attackers' stake hostage through any contentious change, and a public concentration monitor (validator share, stake share, work-vs-capital flow split) makes capture common knowledge fast.

## What This Solves

### P1: Non-Capture

Disaggregated per the problem doc:
- **(a) Earned work-rewards:** untouched and uncapped — all mint is work-mint, so the legitimate concentration is the only token concentration the protocol produces.
- **(b) Consensus power:** capital-proportional and admitted as such; bounded by visibility (monitor), unbonding friction, the exit-able fee flow (capture forfeits the customers being farmed), and the demand-sunset of the only genesis privilege.
- **(c) Emissions direction — the real surface — is resolved by deletion:** there is no direction mechanism. No gauge, no amplifier, no budget shares, no per-creator cap to game. The open residual the doc names (sybil-voted direction) is closed because there is no vote; what survives is plutocratic accumulation via the staker wash-discount, named honestly in residuals rather than papered over.

### P2: Bootstrap

The circularity is cut by removing its first link: nothing directs emissions, so no veJINN is needed for anything to flow. Epoch 1 with zero JINN works end-to-end: founders post USDC-funded tasks (honest, visible, named as the only genesis creators), an external solver settles against the CI oracle, and the first JINN in existence mints to that solver at the curve's richest ratio.

The privileged starting point is shrunk to one artefact — work-earned, permissionlessly entered, non-transferable, fee-only, demand-sunset genesis bonds — and every magic number the standard gauge-bootstrap introduces (bootstrap gauge weight, bondless window size, handoff schedule) is deleted or derived: the handoff is F crossing F0, an observable demand milestone, not a clock or a founder decision.

Market genesis: first float is work-minted, the mint-arbitrage channel is a protocol-native primary market at 1/r that both supplies tokens to later buyers and caps thin-float manipulation from above; the DCF floor bounds it from below; no liquidity subsidy exists to misprice it.

### P3: Security Budget

Adopts the doc's promising lead completely: validators are funded from the non-recoverable fee — all of it, plus gas, and nothing else. This dissolves the three-mouths-on-one-pie problem (solvers take the mint, validators take the fee, evaluator funding splits phi later — no shared budget to size) and ties security income to settled volume in the same real-money unit by construction.

The one capital-proportional stream Problem 1 cannot disperse is therefore fee-denominated, not mint-denominated: the rich-get-richer stream distributes USDC, never JINN, so capital concentration in stake does not compound into supply concentration. Residual (multiple-collapse regime) is monitored, not oracle-braked.

*(Attack note: the supply-compounding claim in the last sentence was refuted — see ranked doc, correction 1.)*

### Amplifier Fork

Weak branch, taken past its endpoint: the amplifier is not weakened but removed. The anti-wash calibration inequality — emission capturable < fee + lock cost — stops being a knob to tune and becomes an arbitrage identity: mint value cannot exceed the fee that indexes it for longer than it takes anyone to arb the gap, and the "attack" that closes it is an open primary purchase whose proceeds flow to stakers.

Consequence owned in full: token demand cannot come from creators needing the token (they never do); it must come from wanting the fee stream and gas. That is the burden the philosophy chooses, because demand for a cash-flow claim is the only demand that is not reflexive. Genesis-grade evaluation is NOT dragged into the launch set — the fork's second branch is unnecessary once the mint prices fees rather than work-claims.

### Degeneracies

- **Product rule 0/0 at genesis:** gone — no product rule exists; first settlement mints unconditionally.
- **Mega-task bundling:** the mint integral is additive in fees, so one task with fee F and n tasks summing to F mint identically — bundling-neutral by construction.
- **JINN-less creators:** zero toll — creators need USDC only (gas is zero at genesis and a sliver thereafter); the most permissionless creator path of any branch.
- **New degeneracy introduced and owned:** self-dealt fees mint real JINN — reframed as a continuous primary auction at 1/r with proceeds to stakers, self-limiting because every wash advances F and lowers the washer's own future ratio; the residual whale-discount variant is named under weaknesses.

### Stablecoin Dependency

Explicit stance: yes, Noble USDC over IBC at v1, because a real-money fee is the entire anchor and refusing it would re-denominate the fee in JINN and make the anchor circular at genesis (no JINN exists to fee with). Dependency minimised structurally: IBC light clients, no multisig bridge; USDC touches escrow and distribution only — the JINN ledger, staking, and consensus survive a freeze intact; substitution path is a hard fork with F carried 1:1. Circle is named as a censorship and depeg dependency on every task's settlement, full stop.

### Market Genesis

No premine means no founder float to list. Supply enters via work-mint; price discovery has a structural corridor: DCF-of-fee-flow floor under bonded stake, mint-parity ceiling at 1/r(F) that anyone can enforce by surrendering fees, rising quadratically with cumulative demand. Thin-float pumps are capped by the ceiling; thin-float dumps are cushioned by the floor only as far as real fee flow justifies — the design refuses to pretend otherwise. Secondary venues via IBC (e.g. Osmosis); no liquidity mining, ever, because rented liquidity is a free-standing subsidy wearing a different hat.

*(Attack note: the "anyone can enforce" ceiling was shown to be insider-only — see ranked doc, correction 2.)*

### Reflexivity

The critique is accepted and built on: the only JINN-denominated flow (the mint) is indexed to, and arbitrage-bounded by, the exogenous fee that triggers it — the contest over emissions cannot detach from outside money because emissions are a function of outside money. Token value rests on the USDC fee stream distributed to stake, a flow that exists independently of the token's price. There is no loop in which JINN's price feeds back into JINN's issuance allocation: r depends on cumulative F only.

## Principles Fit

- **Neutral:** No party is structurally favoured: founders hold zero allocation and zero weight, provably from the genesis file (cheap to signal, expensive to fake — the file is the signal); fee routing and mint are mechanical; creators, solvers, validators face identical rules from block 1. Minimal viable extraction: the protocol's whole take is phi, all of which funds security.
- **Learning Maximised:** The protocol encodes no taste about which work is valuable — mint is fee-blind and oracle-agnostic; net selection is pushed entirely to the market boundary (creators fund, solvers choose), the maximally Bitter-Lesson position: the mechanism searches over nets via demand rather than encoding quality judgements.
- **Governance Minimal:** There is nothing economic to govern: no gauge, no budget split, no per-creator cap, no emission vote; economic constants are compiled out of the gov parameter space, so the residual governance surface is signalling and visible hard forks. Decisions are pushed to mechanism to the limit of what a sovereign chain permits.
- **Permissionless:** Creator path: USDC and nothing else. Solver path: do verified work. Validator path: bond JINN (or, at genesis, the published open testnet-work window). No whitelist, no privileged shortcut; the founders' route to influence is the same route as everyone's.
- **Prestige:** Every JINN in existence is a receipt for fee-funded verified work — holdings are the competence record, not a purchase record, at least until secondary trading dilutes it (named). Genesis consensus weight is likewise earned deference: work-share, publicly logged, expiring rather than entrenching.
- **Legible:** Supply is a closed-form function of one on-chain counter (S = S_max * F/(F+F0)); the security budget is the visible fee flow; token valuation is a DCF on public data; the genesis allocation is auditable from the genesis file and the testnet oracle log; the bootstrap's trust steps (founder-run CI, pre-F0 social security) are named in the protocol docs rather than discovered by adversaries.

## Residual Weaknesses

1. **Naked demand risk:** if creators beyond the founders never arrive, JINN mints almost nothing and is worth almost nothing. The design refuses to disguise this with subsidy — but it means the token offers no consolation prize for a network that fails, and early participants carry that risk in full.
2. **Whale staker mint discount:** a staker holding share sigma of bonded power who self-deals recoups sigma of their own fee, buying new supply at effective price (1-sigma)/r versus 1/r for outsiders. Self-limiting (each wash advances F against their own future ratio, hands minorities USDC, and acquiring sigma required buying work-minted JINN first) but it is a real plutocratic accumulation channel with no identity-free fix.
3. **Circle/Noble freeze** halts task settlement chain-wide until a hard fork substitutes the fee asset; the chain, ledger, and staking survive, but the economy stalls.
4. **Pre-F0 security is social, not economic:** a named, work-verified validator set, not cost-of-attack. If demand stalls below F0 the genesis bonds persist indefinitely and the chain remains trusted-set secured. Settling large value early is explicitly unsafe and the docs must say so.
5. **No protocol selection pressure on SolverNet quality at v1:** a scam creator with a rigged oracle can take a solver's work and refuse settlement (the solver loses effort, not tokens). Policing is reputational/market until Phase B.2 bonded evaluation ships.
6. **Multiple-collapse regime:** a JINN price crash while volume holds high drops cost-of-attack toward value-at-risk; the response is a public monitor and rational creator withdrawal, not a mechanical brake — chosen deliberately over a price oracle, but it is a watch-item, not a solution.
7. **Muted speculative premium:** the mint-parity ceiling caps narrative-driven price runs, which also slows security capitalisation — bonded value grows roughly with demonstrated demand, never ahead of it.
8. **phi and F0 are guesses:** wrong phi mis-prices security against creator deterrence; wrong F0 sunsets genesis security onto thin stake too early or prolongs trusted-set rule too long. Both are irreducible and named as such.
9. **Endgame PoS plutocracy:** nothing here makes capital-majority capture of consensus impossible — only expensive, visible, and fork-recoverable. That is the honest limit of identity-free proof-of-stake.

## Parameters

| Name | Kind | Detail |
|------|------|--------|
| **phi** — non-recoverable fee fraction of task funding | irreducible-number | The protocol's entire take and the security budget's sole source (illustratively 10%). Cannot be market-set (creators would choose zero) or derived; owned as the design's first irreducible number. Forfeited at posting, distributed to bonded power at once. |
| **F0** — demand half-scale | irreducible-number | The cumulative settled fees at which half of terminal supply has been minted, and the milestone at which genesis bonds expire (illustratively $25M). One number doing two jobs, both demand-indexed. Irreducible: any attempt to derive it from epoch-1 observables hands founders a manipulable lever, which is worse. |
| **r0** — initial mint ratio (JINN per fee-unit) | derived-mechanism | Pure numeraire: cancels from every relative allocation and every holder's supply share; chosen only so S_max = r0*F0 is a round number (illustratively 4 JINN/USDC giving 100M cap). Explicitly not a price assertion — JINN floats from the first mint. |
| **Supply curve r(F) = r0/(1+F/F0)^2, S(F) = S_max*F/(F+F0)** | derived-mechanism | Bounded terminal supply reached only in the limit of infinite cumulative demand; path-independent integral, so batching/splitting fees is allocation-neutral; front-loads mint per fee-unit, which is the entire early-participation incentive without any clock subsidy. |
| **Mint timing** — at settlement, per task, no epochs | derived-mechanism | Each oracle-passed settlement mints its fee's integral slice immediately to the solver of record. Epochs deleted as a mechanism: the continuous curve makes them pure bookkeeping. |
| **Fee routing** — 100% to bonded consensus power | derived-mechanism | Standard Cosmos x/distribution; security income proportional to settled volume by construction; validators receive no mint ever, so the capital-proportional stream is USDC-denominated and cannot compound into supply concentration. *(Attack note: refuted as stated — see ranked doc.)* |
| **Genesis bonds** — consensus weight proportional to testnet oracle-verified work, expiring at F = F0 | derived-mechanism | Non-transferable, fee-earning, non-mint, demand-sunset. The single privileged genesis artefact, earned permissionlessly under a pre-published rule; founders' share is whatever the public oracle log says (approximately zero). The main custom module to build — small but consensus-critical, named in deferrals as the chief engineering risk. |
| **Unbonding period** | irreducible-number | Inherited Cosmos convention (21 days). Security-relevant (holds attacker stake hostage through contentious changes); adopted rather than derived, and admitted as such. |
| **Governance scope** — economic constants compiled into the binary | derived-mechanism | phi, F0, r0, curve shape, fee asset, and routing live outside the gov-mutable parameter space; changing any of them is a hard fork by validator adoption. Gov retains signalling, consensus housekeeping, and upgrade proposals. |
| **Gas** — JINN-only, min-gas zero at genesis by validator policy | derived-mechanism | Lets founders post the first task and solvers act before any JINN circulates; min-gas rises by ordinary validator mempool policy as float appears — no founder key, no gov vote. |

## Deferred

- **Protocol-assigned bonded slashable evaluators (Phase B.2)** — safe to defer because the mint prices fees, not work-claims; ships as an opt-in service funded from a split of phi when third-party creators with weaker oracles arrive.
- **Per-task solver bonds** — provided as an escrow primitive, mandated by nothing; each SolverNet chooses.
- **Multi-asset fee legs** — hard fork only; v1 is single-asset (Noble USDC) for legibility of the F counter.
- **Price-aware security brake** — replaced by the public monitor; revisit only if a manipulation-resistant price source ever exists on-chain.
- **Knowledge/corpus market machinery (x402, ERC-8004 indexing)** — unchanged from the existing roadmap, irrelevant to genesis economics.
- **Genesis-bond module hardening** — the one consensus-critical custom build; v1 keeps it minimal (static work-weights from the genesis file, one expiry condition), no dynamic re-weighting.
- **Not deferred but deleted, recorded for honesty:** veJINN in all roles; the per-epoch emission budget B; the per-creator share cap; gauge or amplifier mechanisms of any kind; liquidity mining and LBPs (refused permanently as free-standing subsidies).

---

# 2. Full Cover

**Tagline:** The chain sells exactly the security it has: bonded stake underwrites settlement capacity, validators earn insurance premiums in hard currency, and emissions are a value-capped rebate of those premiums — so security tracks adoption by construction, not assertion.

**Philosophy:** Settlement on a proof-of-stake chain is an insurance product, and a chain that accepts more value-at-risk than its slashable stake can indemnify is lying to its users. Full Cover makes the coverage invariant the load-bearing primitive — exposure may never exceed what an attacker would forfeit to break it — and derives the entire economy from it: fees are congestion-priced coverage premiums, validator income is the premium stream, and emissions exist only as a strictly-fractional rebate of fees actually paid. Everything that cannot be derived from the invariant is deleted, including veJINN.

## Mechanism

### Emission Policy

JINN comes into existence one way only: as a value-capped rebate of settlement fees. When a task completes oracle-verified, the protocol mints JINN whose market value equals k = 1/3 of the non-recoverable fees that task generated (coverage premium + evaluation fee), and distributes it to the solver and the assigned evaluator in the ratio of the creator's own posted bounty-to-eval-fee economics. Conversion uses the MAXIMUM JINN/USDC price over the trailing unbonding window (fail-safe: manipulating price in either direction cannot increase the mint). During the bootstrap window before a market exists, the mint rate is the genesis numeraire r0 = k JINN per fee-USDC.

Consequences: total supply growth is bounded by k × cumulative exogenous fees — emissions can never exceed demonstrated demand; there is no per-epoch budget B, no contest, no gauge, no emissions-direction lever of any kind. Validators receive zero emissions, ever. Mint is linear in fees, so it is split-invariant and sybil-neutral: five addresses doing the work of one mint exactly what one does.

### Token Value Anchor

Bonded JINN is a perpetual pro-rata claim on the coverage-premium stream, which is denominated in the settlement asset (USDC at v1) — exogenous money that left a creator's hands. That is precisely where the standing critique says to anchor (the non-recoverable fee), taken to its conclusion: instead of routing a sliver of the fee to security, the ENTIRE premium is staker cash-flow.

Demand to hold JINN is therefore:
1. underwriting yield in hard currency, scaling with settled volume;
2. capacity expansion — every JINN bonded raises the exposure ceiling E_max, lowering the congestion fee f(u) for all creators, so the network itself bids for bonded JINN exactly when demand presses the cap;
3. native gas.

Each JINN ever minted corresponds to three times its mint-time value in premiums already distributed to stakers (k = 1/3), so the float is never worth less than the fee history behind it on the protocol's own books. Creators never need JINN — the token is for owners of the security capacity, acquired by working or by buying from workers.

### Security Budget

Validators and delegators are underwriters. Their income is the coverage premium on every settlement escrow: f(u) = f0/(1-u) of the bounty, where u = E/E_max is coverage utilisation — EIP-1559-style congestion pricing of security capacity, distributed pro rata to bonded stake (standard Cosmos commission applies), plus gas.

The coverage invariant: total exposure E (all value in settlement escrow plus value settled within the trailing unbonding window) <= E_max = slash_fraction × 1/3 × S_value, where S_value = bonded JINN × MINIMUM pool price over the trailing unbonding window, and slash_fraction for double-sign is set to 100% (the boundary value — any lower fraction is a magic number and shrinks honest capacity).

So breaking settlement safety requires forfeiting more stake value than the total value at risk, at the worst-case price the attacker could have realised — cost-of-attack tracks value-at-risk by construction, at every block, visibly on the public coverage meter.

The growth flywheel closes itself: demand pushes u up, fees and staking yield rise, more JINN bonds, E_max expands, fees fall. No emissions subsidy means no third mouth on a shared pie: solvers/evaluators take the mint, underwriters take the premiums, and the two streams are mechanically coupled through the same fee event.

### Bootstrap

**T-30 days:** published genesis ceremony; anyone who submits a gentx in the window receives an identical dust allocation (1 JINN) for consensus liveness — founders get the same 1 unit as strangers. Total pre-genesis supply = N validators × 1 JINN, symbolic and equal; min gas price starts at 0 (validator-config, Cosmos-native) until JINN circulates.

**Block 1:** settlement module (JINN rail + USDC-via-Noble-IBC rail), public coverage meter (E, E_max, u, f(u)), emission module at r0, empty canonical JINN/USDC pool, evaluator bond registry (bonds in the task's settlement asset, so no JINN needed), concentration dashboard.

**Epoch 1:** founders — visibly the only creators, by address, on the dashboard — fund coding tasks on the Jinn repo in USDC. Premiums route to the dust-validator set (their first income, in USDC); solvers complete work; the test-suite oracle verifies; the protocol mints the k-rebate at r0 to solver and evaluator; bounty settles.

**Market genesis:** earned JINN bonds for yield, LPs the pool, or sells — no protocol action. Handoff is mechanical, not discretionary: after the pool has one full unbonding window (21 days) of trading history, mint pricing switches r0 → window-max and stake valuation switches r0 → window-min, automatically.

**Graduation signal:** the first premium funded by a distinct non-founder address — distinct is chain-provable; independence is a social claim and is named as the trust step, not asserted.

### Evaluation

v1 is deliberately thin, and the design makes that safe rather than hopeful. Anyone bonds (in the task's settlement asset) into the evaluator registry; the protocol assigns one evaluator per task by on-chain randomness weighted by bond (capital-proportional, therefore sybil-splitting-neutral); the evaluator attests the oracle outcome (test-suite pass / merge decision); the slashing condition is oracle-replay mismatch — near-objective for the launch application, per the thin-resolver argument in the simplified-launch doc.

Why deferring genesis-grade quorum evaluation is safe HERE: the standing critique forces evaluator economics into the launch-critical set only on the branch where emissions are capturable through fake work. With k = 1/3 value-capped mint, a wash-trader pays 1 unit of non-recoverable fee to mint at most 1/3 of a unit — fake work is strictly negative-sum against emissions for any actor controlling less than 2/3 of bonded stake, regardless of evaluation quality. Evaluation therefore only guards bounties — the creator's own money, posted at the creator's own chosen oracle quality — and the protocol's job is to let demand starve bad-oracle nets, not to police them.

Collusion economics: creator+evaluator collusion on a self-dealt task recovers the creator's own bounty (zero-sum) and an emission worth less than the fee paid; against honest creators, the evaluator's full bond stands behind a replayable, slashable condition.

### Settlement Currency

Both rails from genesis, with an explicit stance.

**(1) USDC rail (IBC from Noble)** is the demand-honest default: creator demand must be exogenous money, and forcing creators to buy JINN first is both a toll on every new creator and a reflexive demand signal. Consequence accepted and named: Circle blacklisting and the IBC path sit in the critical path of this rail; the escrow module account is blacklistable; this is a neutrality cost paid deliberately at v1, single-denom to stay shippable.

**(2) JINN rail from day one:** tasks may escrow and settle natively in JINN — exposure and stake are then same-denominated, so the coverage invariant needs no price input at all; this rail is Circle-independent and oracle-free, and is the permanent exit path if the stablecoin dependency turns hostile.

Multi-asset rails (other IBC denoms, each priced via its own pool against the same window-extremum rule) are deferred. Validator premium income arrives in whichever asset the task settled — underwriters hold a diversified claim, not a circular one.

### veJINN Role

Killed. Honest justification: gauge-steering selects vote accumulation (the Curve/Convex result, already conceded in the demand-gated doc); the amplifier variant fails the fork (too weak to beat raising the cash bounty, or it drags genesis-grade evaluation into the launch set); and every job veJINN was hired for has a better home in this design.

- Emissions direction → deleted entirely (mint follows fees mechanically; there is nothing to point).
- Token sink and skin-in-the-game → the underwriting bond, which actually pays (premiums in hard currency) instead of asking holders to illiquify for a vague claim.
- Locked time as the un-splittable anti-sybil resource → survives as bonded stake under a 21-day unbonding window with 100% double-sign slash — a harder lock than vote-escrow ever was, because it is slashable, not just illiquid.

Keeping veJINN after removing its steering role would be a sink that pays nothing, and the demand-gated doc itself concedes nobody locks for that.

### Anti-Capture

Three concentrations, three answers.

**(a) Earned work rewards:** uncapped, by design — Prestige-legitimate, and any cap is sybil-defeated anyway.

**(b) Consensus/validator power:** no premine beyond equal ceremony dust; founders reach gov power only through earned or bought bonded stake, the identical path open to anyone; the coverage invariant guarantees a safety attack forfeits more than it extracts; what remains is the irreducible PoS residual — a buyer of >1/3 can halt, >2/3 can rewrite — whose cost the invariant keeps above the settlement value at risk, and whose remedy is social fork, named not hidden.

**(c) Emissions direction — the real capture surface — is dissolved rather than defended:** there is no lever; mint is a linear function of fees, and directing emissions at yourself means paying 3 units of non-recoverable fee per 1 unit minted, profitable only above the 2/3 stake threshold where consensus is already lost (k = 1/3 is chosen to align the economic-capture and consensus-capture thresholds).

Cosmos gov module handled explicitly: it cannot be renounced, so its surface is minimised — k, the fee-curve shape, slash fractions, and pricing rules are code constants requiring a software-upgrade proposal (the highest bar), not gov-tweakable params; no expedited proposals; voting period set long; voting power is bonded (slashable) stake, so governance attackers stand behind their vote with capital at risk.

Monitoring is shipped, not promised: a block-1 dashboard publishing validator concentration, premium share by creator address, and work share by solver — capture becomes common knowledge fast, which is both deterrent and abort trigger.

## How it Solves the Three Problems

### Problem 1 — Non-Capture

Resolved by deletion plus alignment. The named open residual — emissions-direction capture via sybil or bribed votes — cannot occur because no emissions-direction mechanism exists: mint is linear in fees, split-invariant, sybil-neutral. Wash-directing emissions at yourself costs 3× what it mints (k = 1/3) for anyone below 2/3 of bonded stake, so the economic-capture threshold coincides with the consensus-capture threshold and adds no new surface.

Founder capture collapses into the general problem: equal ceremony dust, no premine, no privileged module, gov power purchasable by anyone on identical terms; the founders' real head-start (knowledge, and being the first creators) is made visible on the dashboard rather than laundered through a mechanism.

Whale-creator budget domination — the surviving capture form in the demand-gated design — is structurally absent: there is no shared budget B to dominate; one creator's fees mint that creator's tasks' rebate without diluting anyone else's rate.

### Problem 2 — Bootstrap Circularity

The circularity is broken by removing JINN from every dependency in the loop, not by seeding a privileged starting point. Tasks fund in USDC; evaluator bonds post in the settlement asset; validators run on equal ceremony dust; emissions mint against fees at a published numeraire. Nothing requires pre-existing JINN, so there is no designated bootstrap net, no bondless window, no genesis gauge weight, and no discretionary handoff schedule — the four magic numbers the problem doc says the session would otherwise own.

The honest part is made structural: founders being the only epoch-1 creators is visible per-address on the coverage dashboard from block 1, and the graduation signal is the first distinct external premium. The only handoff that exists (numeraire → market pricing) triggers mechanically after one unbonding window of pool history.

### Problem 3 — Consensus Security Budget

Mechanised directly — this is the design's core. The promising lead (fund validators from the non-recoverable fee) is taken whole: the entire coverage premium is underwriter income, denominated in the settlement asset, scaling with settled volume by definition.

The growth invariant holds by construction: exposure E <= slash_fraction × 1/3 × S at worst-case window price, enforced per block, so settled value can never outgrow cost-of-attack — if demand outruns stake, the fee curve f0/(1-u) prices the marginal settlement up until new bonding restores headroom.

The three-mouths problem dissolves: validators eat premiums, workers eat the mint, and both streams derive from the same fee event rather than competing for one pie. The capital-proportional stream Problem 1 cannot disperse is bounded by being denominated in fees (no inflation subsidy to compound) and slashable at 100%.

## Amplifier Fork Resolution

The weak-amplifier branch, taken to its honest limit: the amplifier is deleted, and the branch's killer question — where does token demand come from? — is answered outside the emission loop entirely. Token demand is underwriting yield (hard-currency premiums scaling with adoption), capacity expansion (bonding JINN raises E_max and cuts everyone's fees, so the network bids for bonded JINN precisely when demand presses the cap), and gas.

As a free consequence the design also banks the other branch's prize without its cost: emissions are structurally wash-proof (k = 1/3 makes fake work negative-sum below the 2/3 stake threshold), so evaluation does NOT have to be genesis-grade — it only guards bounties, which the launch oracle makes near-objective.

Owned consequence: solvers' upside per task is the cash bounty plus a modest rebate, not an amplified prize — supply-side recruitment leans on real fee flow, not emission firepower.

## Standing Critique Responses

**Degeneracies:** All three die with the product rule. The 0/0 at genesis is gone — no veJINN term exists; epoch-1 mint is a linear function of epoch-1 fees. Bundling is neutral — mint is linear in fees, so one mega-task and n split tasks mint identically; there is no normalised pie to game. The JINN-less-creator toll is gone — creators never need JINN for anything; the token sits on the supply/security side, where holding it pays rather than gatekeeps.

**Stablecoin dependency:** Explicit stance: accepted at v1 on the demand rail, never exclusive, with a permanent native exit. USDC over IBC from Noble is the default because demand must be exogenous money and a buy-JINN-first toll is both anti-permissionless and reflexive. The costs are named: Circle blacklist risk against the escrow module account, the IBC path as critical infrastructure, single-denom v1. The JINN settlement rail runs from genesis, needs no price oracle (same-denomination invariant), and is Circle-independent — if the stablecoin turns hostile, the chain degrades to native settlement rather than halting. Multi-denom rails are the named widening path.

**Market genesis:** Primary supply enters solely through verified work, so the first sellers are workers and the first buyers are underwriters seeking premium yield — a real cash-flow buyer, not a greater-fool buyer. The canonical JINN/USDC pool is deployed empty at genesis and seeded permissionlessly; the protocol takes no position. Thin-float manipulation is fail-safe by construction: the protocol reads only window extrema, each in the direction that hurts the manipulator — stake is valued at window-min (suppressing price only shrinks capacity, an attack on growth not safety) and mint converts at window-max (pumping price only shrinks the mint). Holding a manipulated extreme for a full 21-day window against arbitrage is the cost floor. Creators need no JINN at all, so a thin early market never tolls adoption.

**Reflexivity:** Anchored exactly where the critique demands: the exogenous value inflow is the non-recoverable fee, and bonded JINN is the perpetual claim on it. Emissions cannot be a contest over themselves — they are a per-task linear rebate, value-capped at one-third of the exogenous fee behind them, so the token's mint history is always backed three-to-one by hard-currency fees already distributed. The one reflexive loop deliberately retained is the safe-direction one: token price up → stake value up → settlement capacity up → more fee throughput; price down → capacity contracts but coverage never breaks. Reflexivity is harnessed to expansion and firewalled from solvency.

*(Attack note: the security-LEVEL was shown to remain reflexive, and in-window exposure admitted at stale prices breaks the per-block claim — see ranked doc.)*

## Principles Fit

**Neutral:** No premine beyond equal, permissionless-window ceremony dust; founders create, solve, bond, and vote through the identical rails as strangers; fees are uniform and congestion-priced by formula; mint is linear and split-invariant, so no structure favours any address shape. The expensive-to-fake signal is the coverage meter itself: the chain publishes, per block, exactly how much value it can protect.

**Learning Maximised:** The protocol encodes no taste about work: demand (fees paid) selects nets, the oracle settles tasks, and bad-oracle nets starve because creators stop funding them — not because anyone policed them. No gauge, committee, or judge sits between search and reward.

**Governance Minimal:** The largest governance surface in the predecessor design — emissions direction — is deleted outright. Economic constants (k, curve shape, slash fraction, pricing rules) are code, alterable only by full upgrade proposal; the residual gov surface is the irreducible Cosmos upgrade path, run slow, unexpedited, and stake-at-risk-weighted, and named as the one surface that cannot be renounced.

**Permissionless:** From block 1 anyone may create (no JINN required), solve, bond as evaluator (settlement-asset bond), validate (ceremony was open; post-genesis entry is ordinary delegation/validation), or LP the canonical pool. There is no whitelist, no bootstrap cohort, no privileged net.

**Prestige:** Work earnings are uncapped, and the only path to owning the premium stream runs through verified work or buying from those who did it. The on-chain record of oracle-verified completions is the reputation substrate — deference accrues to demonstrated throughput, never to allocation.

**Legible:** Every claim is a chain read: the coverage meter (E, E_max, u, f(u)) per block; every mint traceable to a specific fee event at a published conversion rule; concentration dashboards for validators, creators, and solvers from block 1; the founder-only-creator phase visible by address rather than asserted. Where a claim is social (independence of the first external creator), the trust step is named instead of papered over.

## Parameters

| Parameter | Kind | Detail |
|---|---|---|
| Coverage invariant E_max = slash_fraction × 1/3 × S_value | derived-mechanism | Derived from the CometBFT fault model: breaking settlement safety requires >1/3 of voting power to double-sign and forfeit slash_fraction of its stake, so capping exposure at that forfeiture keeps cost-of-attack >= value-at-risk identically. No number is chosen; the bound is the consensus model's own arithmetic. |
| Double-sign slash fraction = 100% | derived-mechanism | Set at the boundary value: any fraction below 1 is a magic number and linearly shrinks honest capacity per unit of stake. 100% maximises E_max per bonded JINN and is the unique non-arbitrary point on the interval. The operational cost (fatal key accidents) is named in residual weaknesses. |
| Mint ratio k = 1/3 | derived-mechanism | Chosen so the economic-capture threshold coincides with the consensus-capture threshold: wash-trading emissions turns profitable only for an actor recovering >2/3 of their own fees through stake share — i.e. only past the point where PoS consensus is already lost. k is pinned to the 2/3 fault bound, not picked from the air. |
| Stake valuation = window-minimum price; mint conversion = window-maximum price | derived-mechanism | Each invariant reads the price extreme that fails safe for it over the trailing unbonding window: worst-case liquidation value for coverage, worst-case dilution for mint. Both manipulation directions hurt the manipulator; no haircut or oracle-confidence parameter exists to choose. |
| Coverage fee curve f(u) = f0/(1-u) | derived-mechanism | The shape is forced by finite capacity: any curve that stays bounded as u → 1 permits the invariant to be breached by willingness-to-pay; the hyperbolic family is the minimal curve that soft-prices to infinity at the boundary, EIP-1559-style. Only the floor f0 is free. |
| Floor premium rate f0 (proposed 1%) | irreducible-number | The price of coverage at zero utilisation has no structural derivation — it is the one genuinely chosen economic number. Named as such; set low, since congestion pricing does the real work. |
| Evaluation fee rate f_e (proposed 1%, v1) | irreducible-number | Flat at v1 because evaluation capacity is not the scarce resource being priced. Irreducible until an evaluator fee market (deferred) prices it endogenously. |
| Bootstrap numeraire r0 = k JINN per fee-USDC | irreducible-number | A units choice, like satoshis per block: arbitrary as a number, neutral as a rule, because everyone earns at the same published rate and only relative shares matter. Retires automatically after one unbonding window of pool trading. |
| Unbonding window = 21 days | irreducible-number | Inherited Cosmos convention, reused as the coverage window, the price-extremum window, and the mint-conversion window so one irreducible number serves four roles instead of four numbers serving one each. |
| Genesis ceremony dust = 1 JINN per genesis validator | irreducible-number | The minimum allocation that lets a PoS chain produce block 1. Equal for founders and strangers, open submission window, symbolic in size; the closest a sovereign PoS genesis can get to zero premine, named rather than hidden. |
| Emission split solver:evaluator = bounty:eval-fee | derived-mechanism | The rebate divides in the proportions of the creator's own posted economics — no protocol-chosen split exists. |

## Residual Weaknesses

1. **Honest smallness at genesis:** capacity starts near zero because stake value starts near zero, and the invariant refuses to pretend otherwise. Early settlement throughput is genuinely strangled relative to chains that over-promise; an impatient creator with a large task may be priced out or queued until bonding catches up. This is the philosophy's bill, paid openly.
2. **Window-extremum pricing is harsh under volatility:** a price crash freezes USDC-rail capacity at the crash floor for a full 21-day window even after recovery — fail-safe for solvency, bad UX for growth; the JINN rail is the pressure valve but shifts price risk to creators.
3. **100% double-sign slash makes an honest validator's key-management accident (misconfigured failover) fatal.** The tooling that makes this survivable is deferred, so early validators carry real operational risk.
4. **The >2/3 stake buyer captures consensus and governance;** the invariant keeps the attack unprofitable against settlement exposure but cannot stop a buyer whose motive is the chain itself. Defence is acquisition cost plus social fork — the unsolved PoS residual, inherited not created.
5. **The anti-wash bound is exact in bonded stake but only approximate against evaluator-pool concentration:** an actor with mid-range stake plus a dominant evaluator-bond share thins the 3:1 wash margin at the edges. The dashboard makes this visible; it does not prevent it.
6. **Validator income at genesis is premiums on founder tasks plus near-zero gas** — the early validator set is partly speculative/altruistic. No inflation cushion exists by design; a quiet first quarter means a thin honest set.
7. **Circle/Noble/IBC sit in the critical path of the demand rail at v1;** the escrow module account is blacklistable. The JINN rail is the exit, but a blacklist event mid-flight would strand in-escrow USDC.
8. **The demand bet is unchanged and cannot be mechanised:** whether creators beyond the founders arrive is the one thing no design conjures. Full Cover makes their absence visible early (the dashboard shows one creator address) rather than survivable indefinitely.
9. **Solver-side recruitment leans on real bounty flow plus a one-third rebate, not amplified emissions** — weaker headline APY than emission-heavy rivals during the land-grab phase.
10. **No protocol treasury or public-goods funding exists;** ecosystem development relies on participants' own earned or bought stake.

## Deferred

- Multi-asset settlement rails beyond USDC and native JINN (per-denom pools under the same window-extremum rule).
- Evaluator quorum, challenge mechanism, and evaluator fee market — safe to defer because emissions are structurally wash-proof; re-homed per the existing Phase B.2 plan.
- Support for non-replayable / subjective oracles (v1 launch application is test-suite-objective by design).
- Validator key-management and failover tooling that makes the 100% double-sign slash survivable for honest operators.
- Fee-curve refinement (auction-based coverage pricing, reinsurance/secondary coverage markets).
- IBC outbound composability and any interchain-security posture.
- Public-goods / protocol-development funding mechanism — v1 deliberately has no treasury.
- Any learning/capability-compounding claim — tracked, not gated, per the simplified-launch doc.

---

# 3. The Forge

**Tagline:** Every funded task burns more JINN than it mints back; usage is the only printer, and it runs at a structural loss to anyone who tries to game it.

## Philosophy

JINN is the only asset the protocol ever touches: task funding, escrow, bonds, fees, gas and stake are all JINN, with no stablecoin, no bridge and no price oracle in the critical path of any task. The exogenous demand signal is the act of acquiring JINN on the open market to burn it funding work — the protocol never needs to see the outside money, only its on-chain footprint, the burn. Emissions are coupled to that burn at a re-mint ratio R < 1, which makes wash-trading and self-dealing negative-sum by construction rather than by calibrated inequality. Sovereignty and neutrality are bought with volatility, and the design owns that price openly instead of importing Circle to hide it.

## Mechanism

### Emission Policy

Exactly two mint streams; nothing else ever mints.

**STREAM 1 — Genesis Work Stream:** a fixed, halving schedule G_t (Bitcoin-style, hard-coded in the binary, total Σ-G capped) mints each epoch to oracle-verified merged work on the one designated genesis SolverNet (coding tasks on the Jinn repo, oracle = test suite + maintainer merge). A fixed fraction v of G_t distributes to bonded validators as the genesis security subsidy.

**STREAM 2 — Burn-Coupled Stream:** every funded task commits F JINN, split into escrow E = (1−s)F (settles to the solver on oracle-pass, refunds the creator on expiry/failure) and a non-recoverable slice N = sF, of which β·N burns and (1−β)·N routes to the validator fee pool. On oracle-pass the protocol mints R × (β·N) to that task's solver, R < 1, per-task, no epoch pooling, no shared budget. Failed tasks burn with no mint — pure deflation.

Net supply change per epoch = G_t − (1−R) × total burn: supply is hard-capped at (genesis ledger + Σ-G) and turns deflationary once usage outgrows the decaying subsidy. There is no discretionary budget B to size and no allocation contest to capture.

### Token Value Anchor

Exogenous value enters when creators purchase JINN on the market with outside assets in order to fund tasks — the market does the conversion; the protocol only ever sees the burn. The anchor is the capitalised burn flow (Helium/EIP-1559 logic: equilibrium price is where burn-rate × price equals real external task demand), reinforced by structural float demand: escrows in flight, solver bonds, and validator stake all lock supply. JINN is worth holding because it is the mandatory working capital of the network — you cannot commission work, claim work, or secure the chain without it — and because every unit of usage permanently destroys (1−R) of its burn slice. Burned-JINN-per-epoch is the single, independently verifiable, on-chain usage metric.

### Security Budget

Validators are funded by three flows, all JINN: (i) gas fees; (ii) the (1−β) share of every task's non-recoverable slice, distributed pro-rata to bonded stake via standard x/distribution — so security income scales linearly with settled volume, which is Problem 3's promising lead ported to JINN; (iii) the decaying fraction v of the Genesis Work Stream, which covers the window when task volume is near zero.

Cost-of-attack tracks value-at-risk by a settlement governor: total open escrow may not exceed κ × (1/3 of bonded stake) — the 1/3 is the BFT fault bound (derived), κ is a safety margin. Because escrows and stake are the same asset, the ratio is JINN/JINN: a price crash cannot open the foreign-denominated gap where settled volume outruns the security collateral. When the governor binds, new postings revert; rising fee yield on a binding cap attracts stake, which raises the cap — security tracks adoption by construction, not by invariant-naming.

*(Attack note: refuted — cost-of-attack is stake × market price; the JINN/JINN framing cancels price on both sides and proves nothing. See ranked doc.)*

### Bootstrap

**EPOCH 0 (pre-genesis):** the live testnet runs this exact mechanism with tJINN; the verified-work ledger (the existing Claimed-mint record) accumulates publicly. A snapshot block is announced 30+ days ahead.

**GENESIS FILE:** balances = the testnet verified-work ledger, 1:1, nothing else — no premine, no founder line, no investor line; founders' addresses appear only with what their operators earned under the public rules, and the full ledger is published for audit. The genesis validator set is whoever stakes from those earned balances at the ceremony — permissionless from block 1.

**EPOCH 1:** founders post tasks on the genesis SolverNet (the Jinn repo); G_1 mints to whoever ships merge-worthy work — this is the honest, named, decaying founder privilege: "we are the only creators so far, here is the schedule under which that privilege dies". The burn-funded task lane is open from block 1 to anyone holding JINN.

**FIRST DISTRIBUTION:** solvers, who needed no capital to enter, become the market's natural first sellers; incoming creators buy from them on a permissionless DEX deployed at genesis (no protocol-owned liquidity — there is nothing to own).

**HANDOFF:** G_t halves on the hard-coded schedule; graduation is the legible on-chain moment burn-coupled minting exceeds the genesis stream. No vote, no discretionary handoff decision exists.

### Evaluation

Deferred, and safely: (i) the Burn-Coupled Stream is wash-proof structurally — a creator-solver-evaluator sybil spends N non-recoverable and recovers at most R·β·N plus a stake-share σ of (1−β)·N; with R=0.5, β=0.5 the net cost is N(0.75 − 0.5σ), positive even for a 100%-stake validator-creator-solver colluder — so fake work cannot extract net emissions no matter who colludes; (ii) the Genesis Work Stream is gated by a real oracle (test suite + merge) whose throughput is the unsplittable bottleneck; (iii) v1 ships the thin attestation + bond + slash core: a solver bonds JINN to claim a task, the oracle outcome is attested on-chain, and a provably false attestation slashes the bond. Per-net oracle quality stays a creator-borne risk priced by the market — a net with a weak oracle costs only the creators who fund it, and starves. Protocol-assigned, bonded, randomly-selected evaluator networks arrive in Phase B.2, funded by carving a share of the R-mint and the fee slice — an addition, not a redesign, because nothing in v1's safety depends on them.

### Settlement Currency

JINN only, totally. No USDC, no stablecoin leg, no bridge, no price oracle anywhere in the task path. Consequences owned: full sovereignty and credible neutrality (no Circle blacklist, no depeg, no bridge custodian as systemic risk); the cost is that creators price tasks and solvers carry exposure in a volatile asset, and fiat-denominated creators must touch an exchange before participating. Mitigations stay off-protocol by design: short escrow windows bound exposure, creators reprice by cancel-and-repost, hedging is the participant's business. The protocol refuses to import a dependency to soften a volatility it can instead simply survive.

### veJINN Role

Killed. Honest justification: gauge voting selects for vote accumulation, not net quality (the Curve/Convex result); an amplifier capped by the anti-wash inequality is too weak to beat simply raising the bounty (the fork's own finding); and in a JINN-native design the "sink" and "token demand" rationales are unnecessary because demand is structural — you cannot use the network without acquiring the token. Locked time survives where it actually bites on the critical path: slashable solver bonds at v1, evaluator and validator bonds later. Locks as collateral, never as votes or amplifiers. Deleting veJINN also deletes its entire capture surface, its calibration burden, and its degeneracies in one move.

### Anti-Capture

**Founders:** no premine (genesis = the public testnet work ledger), no admin keys or privileged module accounts, no treasury (community tax = 0 — nothing discretionary to capture), and their one real privilege — curating the genesis net and its merge gate — is named in public and decays on a hard-coded halving schedule.

**Whales:** the emissions-direction surface is structurally gone — no gauge, no amplifier, no shared budget; the only way to "direct" emissions is to burn JINN funding real work, and each task's mint is R × its own burn, independent of every other task, so a whale cannot starve anyone and recovers strictly less than they destroy. Work earnings stay uncapped (legitimate, Prestige).

**Cosmos gov module:** emission and fee parameters (R, s, β, G-schedule, κ, v) are compiled as immutable constants with no ParamChange path — changing them requires a chain upgrade, i.e. a public, signed, validator-supermajority act subject to the standard 33.4% NoWithVeto; gov's surface is reduced to software upgrades and a minimal residual param set. The residual — a validator supermajority can always fork the rules — is not eliminable on any sovereign chain; the defence is legibility (a public concentration monitor from block 1: validator HHI, top-earner share, burn provenance) making capture common knowledge fast, plus an acquisition cost inflated by the fact that most float is locked in escrow, bonds and stake.

## How It Solves the Three Problems

### Problem 1 — Non-Capture

The three concentrations are answered separately. Earned work rewards: uncapped, by design. Emissions direction — the real capture surface — is structurally deleted: no vote, no amplifier, no shared per-epoch pie; each task's mint is R × its own burn, so "directing" emissions means destroying your own money funding real work, which is the legitimate act the network exists for. Sybils gain nothing anywhere: the Genesis Stream bottlenecks on oracle throughput (unsplittable work), the Burn Stream is linear in burn (split-invariant), and even full creator-solver-validator collusion loses 0.25N per wash at the default parameters. Founder capture collapses into the general case via the earned-only genesis ledger, zero privileged keys, immutable-in-binary emission constants, and the named-and-decaying genesis-net privilege. Residual validator-stake concentration is bounded only by acquisition cost and the public monitor — named, not solved.

*(Attack note: the genesis-stream founder self-mint was judged fatal — the merge gate is the premine. See ranked doc.)*

### Problem 2 — Bootstrap Circularity

The circularity is cut by removing its cause: nothing at genesis waits on veJINN, because veJINN is gone. The entry point is the Genesis Work Stream — a fixed schedule minting to verified work on one named net, requiring no prior JINN, no bond, no vote. The seeded starting point is made honest rather than hidden: founders are the only creators at epoch 1, the privilege is published as a halving schedule, the genesis ledger is the audited testnet work record, and graduation (burn-mint exceeding genesis-mint) is an on-chain observable, not a decision. The bondless window is not a window at all — it is a decaying stream that anyone can earn from on day one and that no one can extend.

### Problem 3 — Consensus Security Budget

Validators are funded from the non-recoverable fee slice of every task plus gas, so security income scales with settled volume — the doc's promising lead, with JINN replacing USDC. The genesis security subsidy (fraction v of G_t) covers the zero-volume window and decays away. The three-mouths-one-pie problem dissolves because there is no shared pie: solvers draw escrow plus per-task burn-coupled mints, validators draw the fee slice, and neither claims the other's stream. Cost-of-attack stays above value-at-risk via the settlement governor (open escrow ≤ κ × 1/3 bonded stake) — and because both sides of that inequality are denominated in JINN, no exchange-rate move can silently break it.

## Amplifier Fork

**Branch one, taken to its limit: not a weak amplifier but no amplifier.** The fork's sting — "then where does token demand come from?" — is answered structurally rather than by incentive engineering: JINN is the mandatory working capital of every task (funding, escrow, bond, gas, stake), and a slice of every task burns. Demand is usage, not a contest prize. Consequence owned: the design forfeits any mechanism for creators to amplify their tasks beyond raising the bounty — raising the bounty IS the mechanism, which is exactly what the fork showed the amplifier could never beat. Genesis-grade evaluation is therefore not dragged into the launch-critical set; it stays in Phase B.2 because R < 1 makes fake work negative-sum without it.

## Answers to the Standing Critique

### (a) Degeneracies

All three named degeneracies die with the product rule. No 0/0 at genesis: the Genesis Stream is schedule-driven and the Burn Stream is linear in burn, defined from the first task. No mega-task bundling: per-task mint is linear and independent, so bundling and splitting are exactly equivalent. No toll on JINN-less creators relative to JINN-rich ones: every creator faces the same R and the same s, with no amplification tier — the only "toll" is acquiring JINN at all, which is the design's load-bearing demand signal, and the capital-free path (solve first, earn, then create) keeps entry permissionless.

### (b) Stablecoin Dependency

Eliminated, not mitigated. No Circle, no blacklist surface, no depeg risk, no bridge custodian, no foreign price oracle in any task path — maximal neutrality and sovereignty for a sovereign chain. The honestly-owned costs: participants carry JINN volatility across escrow windows; early task pricing is noisy on a thin float; fiat-anchored creators face an exchange step before their first task. The design holds that a fair-launch network whose settlement asset can be confiscated by a third party was never sovereign, and takes volatility as the fair price of removing that veto.

### (c) Market Genesis (Chicken-and-Egg)

Need JINN to create tasks, need tasks to distribute JINN — broken by making the first distribution not require funding: the Genesis Work Stream mints to verified work, so solvers enter with zero capital and become the market's first natural sellers. Creators acquire from them on a permissionless DEX live at genesis (no protocol-owned liquidity, nothing to own). The burn slice makes creator demand recurring rather than one-shot, and locked float (escrow, bonds, stake) keeps circulating supply tight. Thin-float manipulation early is real and named: it distorts the demand signal and price, but cannot break internal mechanics, because every protocol flow is JINN-against-JINN with no external price reference to manipulate.

### (d) Reflexivity

The internal contest is negative-sum by construction: the Burn Stream mints strictly less than it destroys (R < 1), so emissions cannot be the prize of a self-referential game — any party "competing for emissions" with their own money loses (1−R) of every unit they commit. Net token-denominated gain for the system requires JINN bought on the market with outside assets and burned funding work somebody actually wants done. The exogenous value inflow is the market purchase behind the burn; the burn is its legible on-chain receipt; token value anchors there, exactly as critique (d) demands — with the burn replacing the USDC fee as the anchor.

## Principles Fit

**Neutral:** One asset, no third-party veto (no Circle, no bridge), no participant structurally favoured: the burn is the cheapest honest signal that is expensive to fake (it destroys real purchasing power), founders hold only earned balances plus a named decaying privilege, and minimal viable extraction is literal — the protocol extracts s of each task, splits it between permanent burn and the security budget, and keeps nothing discretionary.

**Learning Maximised:** The protocol encodes no taste: it never polices oracles, never ranks nets, never tunes an allocation contest. Selection is paid demand and starvation — the market searches over SolverNets and methods while the protocol only enforces escrow, attestation and slash. Solvers are free to discover whatever wins the oracle.

**Governance Minimal:** Gauge votes, budget-setting, handoff decisions, per-creator caps and amplifier curves are all deleted; emission and fee constants are immutable in the binary; community tax is zero so there is no treasury to politick over. The whole live governance surface is the Cosmos upgrade path — public, rule-bound, supermajority, veto-able.

**Permissionless:** The zero-capital path is first-class: outsider → solver on the genesis net → earn JINN → creator, staker or net-launcher, with no privileged shortcut and no gatekeeper beyond the oracle itself. Launching a SolverNet, funding tasks, staking and building on the primitives need nobody's permission from block 1.

**Prestige:** Work earnings are uncapped and oracle-gated, so the largest holders are by construction the most productive contributors; the genesis ledger itself is a prestige record — every genesis balance traces to verified testnet work. Deference flows to demonstrated throughput, never to allocation.

**Legible:** Every load-bearing claim is on-chain checkable: the genesis ledger against the testnet record, burned-JINN-per-epoch as the usage metric, the halving schedule, the supply hard-cap, the settlement governor, the concentration monitor. The one authority step — the founder merge-gate on the genesis net — is named in public rather than laundered through a vote.

## Parameters

| Parameter | Kind | Detail |
|---|---|---|
| R — re-mint ratio (default 0.5) | irreducible number | The constraint R < 1 is derived (it is the structural anti-wash condition: any self-dealt burn returns strictly less than it destroys, even under full creator-solver-validator collusion). The exact value inside (0,1) is irreducible; 0.5 is the Schelling-simple choice trading creator rebate against deflation rate. |
| s — non-recoverable slice of task funding (default 10%) | irreducible number | Sets the floor cost of expressing demand and the gross security-plus-burn take per task. Irreducible: it trades creator friction against security income and sink depth. Consequences (effective creator cost, validator revenue per settled unit) are derived from it, not asserted. |
| β — burn vs validator-fee split of the slice (default 50/50) | irreducible number | Divides the non-recoverable slice between the permanent sink and the security budget. Irreducible; the wash-proofness result holds for any β in (0,1] given R < 1. |
| Genesis Work Stream schedule — G_0 and halving period | irreducible number | Bitcoin-precedent declining subsidy; total Σ-G is the second component of the hard supply cap. The shape (halving, hard-coded, no extension path) is mechanism; the initial rate and period are irreducible numbers, published before genesis. |
| v — validator share of the Genesis Work Stream | irreducible number | The genesis security subsidy covering the near-zero-volume window; decays with G_t by construction so the long-run security budget is purely fee-funded. The decay is derived; the fraction is irreducible. |
| Settlement governor — open escrow ≤ κ × (1/3 × bonded stake) | derived mechanism | The 1/3 is the BFT consensus fault bound — derived, not chosen. κ is the one irreducible safety margin inside it. The governor enforces cost-of-attack > value-at-risk in same-asset terms and creates the fee-yield feedback that grows stake with demand. *(Attack note: refuted as a tautology — see ranked doc.)* |
| Genesis allocation rule — balances = testnet verified-work ledger, 1:1 | derived mechanism | No number to pick beyond the snapshot block (announced 30+ days ahead — that date is the irreducible residue). The rule itself is structural: only oracle-verified work mints genesis balance, founders included on identical terms, full ledger auditable. |
| Per-task burn-coupled mint = R × own burn, no pooling | derived mechanism | Replaces the capped budget B, the product allocation rule, the multiplier curve and the per-creator cap in one move: linear, split-invariant, independent across tasks, wash-proof. The entire calibration burden of the demand-gated draft collapses into the single constraint R < 1. |
| Emission and fee constants immutable in the binary | derived mechanism | R, s, β, G-schedule, κ, v have no ParamChange path; alteration requires a chain upgrade — a public validator-supermajority act under standard veto rules. Governance surface is converted from parameter discretion into fork-level social consensus. |
| Community tax = 0 (no treasury) | derived mechanism | Removes the discretionary pool that gov capture would target; the protocol holds nothing, so there is nothing to redirect. |
| Unbonding period — Cosmos-conventional 21 days | irreducible number | Inherited convention; interacts with the settlement governor (the slashing window over which open escrow is bounded). Flagged rather than re-derived. |

## Residual Weaknesses

1. Volatility is borne raw: creators price tasks and solvers carry exposure in JINN across escrow windows, with no protocol hedge; early pricing will be noisy and some fiat-anchored creators will be deterred.
2. Thin float at launch: price is manipulable early, which distorts the exogenous-demand signal (burn flow) even though it cannot break internal JINN-against-JINN mechanics.
3. The genesis net is honest authority, but authority: founders gate merges on the Jinn repo, so the Genesis Work Stream is founder-curated until the schedule decays it and repo maintainership broadens — a hostile reader can call this "founders direct the subsidy" and be partially right.
4. Genesis-ledger fairness inherits testnet integrity: pre-snapshot work-farming is bounded by the same merge-gate, which concentrates pre-genesis trust in founder curation of the testnet.
5. Validator yield remains capital-proportional and rich-get-richer; the design bounds value-at-risk and makes concentration common knowledge, but does not disperse stake.
6. A validator supermajority can still fork the rules via the upgrade path; immutable-in-binary constants raise the bar to a public supermajority act but cannot abolish it on a sovereign chain.
7. No protocol evaluator network at v1: creators funding nets with weak oracles bear the fraud risk themselves, and selection-by-starvation teaches slowly, with tuition settled by creators.
8. The demand bet is unhedged: if no external creators ever buy JINN to burn, the Burn Stream tends to zero and the network lives and dies on the decaying genesis schedule — the same bet the launch doc names, made maximally explicit here.
9. Deflation can overshoot: if burn massively outruns the genesis stream, a shrinking supply could make task pricing feel expensive in JINN terms and reward holding over using; R and s bound but do not eliminate this.

## Deferred

- Protocol-assigned, bonded, randomly-selected evaluator networks (Phase B.2) — safe to defer because R < 1 makes fake work negative-sum without them; they arrive by carving a share of the R-mint and fee slice, an addition not a redesign.
- veJINN — deleted, not deferred; recorded here so nobody reintroduces it casually.
- Dynamic fee markets on s (congestion-priced non-recoverable slice when the settlement governor binds) — v1 uses a hard cap with reverting postings.
- Multiple genesis SolverNets and any broadening of the genesis-stream surface — v1 has exactly one, named, decaying.
- IBC asset flows, cross-chain anything — IBC may exist on the chain, but nothing in the task loop uses it and no design work is spent on it at v1.
- Fiat-quoting conveniences (UI-level price display for creators) — explicitly off-protocol, client-side only, never an on-chain oracle.
- Evaluator/validator bond markets beyond the thin v1 solver bond + attestation + slash core.
- Protocol-owned liquidity — never, recorded as a refusal rather than a deferral: there is no premine to seed it with and no treasury to hold it.
- Decentralising genesis-net maintainership (broadening the merge gate beyond founders) — a social process tracked in public, not pre-engineered.
- On-chain governance constitution module (formally enumerating the residual gov surface) — v1 relies on immutable constants plus standard Cosmos gov; a constitution is hardening, not foundation.

---

# 4. Born Bonded

**Tagline:** Every JINN in existence was minted to oracle-verified work and arrives already at stake — the token is working capital for doing work, never a steering wheel.

## Philosophy

JINN is a work token: demand for it is demand for throughput capacity on the network, nothing else. Solvers bond JINN to claim tasks, evaluators bond JINN to attest results, validators stake JINN to secure settlement — and not one of those positions yields anything for mere presence; only oracle-verified work mints. The Livepeer/Keep/POKT failure mode (yield-for-presence) is excised structurally: there is no staking inflation, no delegation yield, no lock-and-collect anywhere in the design. Capital buys you the right to attempt work at risk; only verified work pays.

*(Attack note: the philosophy was judged internally false — the validator fee-yield leg is presence-yield renamed. See ranked doc.)*

## Mechanism

### Emission Policy

Per epoch t the protocol mints M_t = G_t + B_{t-1}. G_t is the genesis tranche: a fixed per-epoch mint that halves every 182 epochs (~6 months), Bitcoin-shaped, asymptoting to a finite genesis supply. B_{t-1} is the JINN burned in task fees last epoch, recycled 1:1 (k=1, supply-neutral steady state — once G_t decays to dust, mint equals burn and total supply is constant). M_t distributes pro-rata to tasks ORACLE-VERIFIED in epoch t, weighted linearly by each task's fee burn; within a task, 90% mints to the solver, 10% to the verifying evaluator/attestors. Linear pro-rata is granularity-invariant (one 100-fee task = ten 10-fee tasks) and sybil-invariant (splitting addresses changes nothing). Critically, ALL emissions mint directly into the recipient's bond account — born bonded, subject to the 21-day unbonding delay and retroactive slashing. No emission ever flows to stake, presence, locking, or delegation. With no premine, the emission schedule IS the entire genesis distribution: the supply ledger is, line by line, a ledger of verified work.

### Token Value Anchor

Three demand legs, all working-capital, none reflexive. (1) Bond demand: a solver's open claims are capped by bonded JINN (bond = escrow, 1:1), so capacity demanded scales with task volume x average task duration — value-at-risk in flight must be collateralised in JINN. (2) Creator demand: tasks are escrowed and fee'd in JINN only, so every unit of outside money that wants work done must buy JINN first; the non-recoverable fee slice (one-third burned, one-third to the evaluator, one-third to the security pool) is the permanent exogenous value inflow. (3) Validator stake demand: security income is the fee slice, so staking yield capitalises settled volume. Long-run supply is constant (mint = burn), while all three demand legs grow with throughput. The token is worth holding because holding it idle is the only unproductive position: every productive position on the network requires it.

### Security Budget

Validators receive NO emissions — emission-funded validation is presence-yield, the exact failure mode this design exists to kill. Validator income = chain gas fees + one-third of every task fee, distributed per epoch pro-rata to bonded stake. Security income therefore scales mechanically with settled volume. The binding link runs the other way too, via the SETTLEMENT GOVERNOR: the chain refuses to open new task escrows whenever total open escrow value would exceed one-third of bonded validator stake (both denominated in JINN — no price oracle needed; one-third is the Tendermint fault threshold, derived not chosen). Cost-of-attack is thereby held above value-at-risk by construction: you cannot put more value in flight than the stake securing it can answer for. When demand outruns security, escrows queue, fee yield per staked JINN rises, stake flows in, the ceiling lifts — the growth invariant ('the economy cannot safely outrun the work flowing through it') enforced as mechanism, not slogan.

*(Attack note: the governor defends the 1/3 halt threshold; theft lives at 2/3 where the captors control slashing. See ranked doc.)*

### Bootstrap

Genesis block: supply = 0, so PoS stake cannot exist. The chain starts with a founder-recruited dust-power PoA validator set (each genesis validator holds fiat power 1, set in the genesis file, no token allocation) — a named, visible, privileged surface whose power is dust the moment any real JINN is staked. The settlement governor reads stake ~= 0 and so permits ZERO escrowed tasks — consistent, because there is nothing to steal. Proving window (epoch 1 onward): founders post zero-escrow tasks on the Jinn repo whose only reward is the genesis emission G_t — the honest statement 'founders' task list is the only demand so far' is on-chain, not hidden behind a vote. Anyone may solve, permissionlessly, via the RACE LANE: open tasks, no bond required, first oracle-verified delivery collects; gas covered by creator-funded x/feegrant allowances. Verification in the bondless window: the task commits a pinned test-container hash; deliveries are attested by re-execution; because the oracle is deterministic, any false attestation is fraud-provable forever by anyone who re-runs the container. Emissions mint BONDED with a 21-day unbonding delay far exceeding the 24-hour challenge window, so a lie can never go liquid before it is provable and slashed — retroactive slashing substitutes for upfront bonds, which is what makes a bondless-yet-not-privileged first window possible. Handoff is fully mechanical, no dates, no votes: workers accumulate bonded JINN -> some stake it (real stake instantly swamps PoA dust power) -> the governor ceiling lifts off zero -> the first escrowed, fee-bearing tasks become possible (founders fund them with work-earned or worker-bought JINN, like anyone) -> fees flow -> B_t grows as G_t halves away -> emission becomes demand-gated 1:1. Market genesis: the first float is unbonded work earnings; the first buyers are creators needing escrow, solvers needing bonds, validators needing stake — price discovery between real users, no LBP, no liquidity mining (liquidity mining is presence yield: banned).

### Evaluation

Genesis-grade from day one — this is the fork branch taken, and the work-token philosophy is what makes it affordable. v1 restricts to DETERMINISTIC oracles (pinned test-suite container; pass/fail is machine-decidable), which collapses evaluation to cheap re-execution and makes every dispute objectively resolvable by replay. Bonded lane: evaluators register by bonding JINN; assignment per task is bond-weighted uniform random (sybil-neutral: splitting a bond across N addresses leaves expected assignment share unchanged) and sits entirely outside the creator's control. The assigned evaluator re-runs the container, attests, and collects the evaluator fee slice plus the 10% emission share. Open challenge backstop: for 24 hours any bonded party may challenge by submitting a contradicting re-execution; determinism names the liar; the liar's full bond (solver and/or evaluator) is slashed, half burned, half to the challenger. Collusion cost: a solver-evaluator ring must survive a public, permanently-replayable fraud window with both bonds (each = escrow) at stake against a bounty-hunting market — collusion price = 2x escrow x P(any third party ever re-runs), and re-running is cheap forever. Deferring subjective-oracle evaluator economics is safe precisely because v1 admits only oracles where disagreement is machine-resolvable; SolverNets wanting softer oracles wait for Phase B.2 rather than launching with a hole.

### Settlement Currency

JINN only. USDC appears nowhere in the protocol: escrows, fees, bonds, burns, security income — all native JINN. Stance: putting Circle's blacklist and a bridge in the critical path of every task on a sovereign chain is a neutrality cost the design refuses, and it would force a JINN/USD price oracle into the emission mechanism (a manipulation surface on thin float). With everything in one denomination, no price feed exists anywhere in the protocol. Consequences owned: creators bear JINN volatility over the task lifetime (mitigated by short launch-task durations) and new creators pay a one-hop acquisition toll (mitigated at the edge — front-ends may quote USD and swap via IBC venues, out of protocol). That toll is also the value anchor: creator demand is where outside money enters.

### veJINN Role

Killed. Honest justification: veJINN was a sink in search of a function. Its steering role selects for vote accumulation (Curve/Convex, observed); its amplifier role fails the wash-trade inequality into weakness (the fork's branch one); and 'lock for vague support' is dead on arrival, as the demand-gated doc itself concedes. The work token gives every locked JINN an actual job instead: solver bonds, evaluator bonds, validator stake — three productive, slashable, throughput-coupled locks replacing one decorative one. Emissions direction needs no steering wheel because allocation is mechanical (pro-rata to fee burn); deleting the wheel deletes the capture surface that Problem 1 names as the real one.

### Anti-Capture

(a) Earned work rewards: uncapped, by design — Prestige-legitimate, and any cap is sybil-defeated anyway. (b) Emissions direction: the discretionary surface is DELETED — allocation is linear pro-rata to fee burn, so 'capturing direction' means paying full fees for real, externally-evaluated, challengeable work, which is just being a customer (the branch-two near-benign result). (c) Consensus and chain governance, the surface that cannot be deleted on a sovereign chain: the settlement governor bounds what a captured validator set can steal (open escrows <= 1/3 stake, so theft < stake destroyed); gov voting power is bonded stake under the stock Cosmos gov module with supermajority thresholds for parameter changes and upgrades; and the key derived mechanism is EXIT-BEFORE-EXPROPRIATION — every passed upgrade carries an execution timelock >= the 21-day unbonding period, so any staker can fully exit between a hostile proposal passing and it taking effect, which converts capture into buying a chain whose value left before you took delivery. Founders specifically: no premine, no allocation, no admin keys, dust-power PoA that real stake swamps, and a proving-window task list that is public and halves away on schedule — their only durable edge is knowledge, which is the Prestige-legitimate kind. Final backstop: a fair-launch chain is maximally forkable — since all state is work-earned and nobody holds privileged allocation, a community fork that erases a captor's stake carries full legitimacy, and the captor knows it. Everything is monitored in public from block one: mint provenance, bond concentration, validator concentration, governor headroom.

## How It Solves the Outstanding Problems

### P1 — Non-Capture

The three concentrations are answered separately, as the problem doc demands. Earned-work concentration: untouched, uncapped, legitimate. Emissions-direction concentration: the surface is removed rather than defended — no gauge, no amplifier, no vote; emissions follow fee burn linearly, and fee-paying is self-limiting capture because genesis-grade evaluation forces the fee-payer's work to be real, externally assigned for evaluation, and challengeable. Sybils gain nothing anywhere: every rule bites only on the two un-splittable resources (oracle-verified throughput and bonded time), and every allocation rule is linear, so splitting is everywhere a no-op. Consensus concentration: bounded in damage by the settlement governor, slowed by unbonding, defanged by the exit-before-expropriation timelock, and backstopped by credible forkability. Founder capture collapses into the general case because founders hold no allocation, no keys, and no mechanism reads identity.

### P2 — Bootstrap

The circularity is broken without a privileged allocation by three interlocking moves: (1) zero-escrow proving tasks need zero security, so the governor's stake-gate does not block them; (2) the race lane needs zero prior JINN, so solvers acquire working capital by working — the cold-start answer is 'your first bond is minted to you for your first verified work'; (3) mint-bonded emissions plus permanent deterministic fraud-provability substitute retroactive slashing for the upfront bonds nobody can yet post, so the bondless window is not a free-rider window. The founder-chosen surfaces that remain (the proving task list, the PoA dust validators) are named, on-chain-visible, and decay mechanically — by halving schedule and by being swamped the moment real stake exists — rather than by promise. Market genesis: first float is unbonded earnings, first buyers are users who need the token to act; the protocol reads no price anywhere, so thin-float manipulation has no protocol lever, only an entrant tax (named residual).

### P3 — Security Budget

Takes the doc's promising lead and completes it in both directions. Funding direction: validators are funded from the fee slice (plus gas), never emissions, so security income scales with settled volume and the three-mouths-one-pie conflict dissolves — solvers/evaluators claim the emission pool, validators claim the fee stream, and the streams cannot cannibalise each other. Enforcement direction: the settlement governor holds open escrow value <= 1/3 of bonded stake, in the same denomination, so cost-of-attack tracks value-at-risk by construction rather than by hope. The one capital-proportional stream Problem 1 cannot disperse is thereby kept off the mint entirely and bounded in what it can betray. Genesis corner owned honestly: security ~= 0 in the proving window, but the governor also holds value-at-risk at 0 there, so the equilibrium is matched at every point of the growth curve.

### Amplifier Fork

Branch two, taken whole: evaluation is genesis-grade — protocol-assigned, bonded, slashable, with an open challenge market — and the amplifier is not weakened but deleted along with veJINN. The consequence the branch warns about (evaluator economics drags into launch scope) is paid deliberately and made affordable by restricting v1 to deterministic oracles, where evaluation is cheap re-execution and every dispute is machine-resolvable by replay. With fake work unable to collect, self-dealing degenerates to purchasing real verified work at full freight — near-benign — and token demand comes not from an amplifier but from working capital: bonds, escrows, and stake.

### Degeneracies

The 0/0 genesis degeneracy is gone because there is no product rule — the proving window allocates equally across verified founder tasks (explicit, visible) and fee-weighted allocation takes over the moment any fee exists. Mega-task bundling is gone because linear pro-rata over fee burn is granularity-invariant: splitting or merging tasks moves no emission. The JINN-less-creator toll survives in reduced form (a one-hop swap, owned as the price of the no-USDC stance), and the JINN-less SOLVER — the harder permissionless case — gets a structural answer: the race lane mints a newcomer's first working capital against their first verified work, with creator-sponsored gas.

### Stablecoin Dependency

Resolved by refusal: JINN-native settlement everywhere, USDC nowhere in protocol. This removes Circle and a bridge from the critical path (Neutral), removes every price oracle from the mechanism (Legible, Governance Minimal), and converts the stablecoin's one genuine service — the exogenous-value anchor — into direct creator demand for JINN with a burned fee slice. Costs owned: creator-side volatility exposure during task lifetime and an acquisition toll on entry, both mitigated at the edge (short tasks, front-end USD quoting and IBC swaps) rather than in protocol.

### Market Genesis

No premine means the float itself is work-minted: supply enters bonded, leaks to liquidity only through the 21-day unbonding choice of workers who prefer cash to capacity. First sellers are provably workers; first buyers are creators, entrant solvers, and validators — every early trade is between parties who need the token to act, not to speculate. No LBP, no liquidity mining (presence yield, banned). Thin-float manipulation is acknowledged as an entrant tax with no protocol lever to pull, since the mechanism never reads a price.

### Reflexivity

Long-run emissions are recycled burn — funded unit-for-unit by creator-side outside money exiting circulation as fees — so the contest over emissions is a contest over exogenous inflow, not over a self-referential prize pool. The genesis tranche G_t is the one reflexive component (minting against founder-task work before fees exist); it is bounded, halving, and named as the bootstrap subsidy rather than disguised as demand. Token value rests on the three working-capital legs plus supply-neutrality, not on a story that the token directs the token.

## Principles Fit

**Neutral:** No allocation, no admin keys, no price oracle, no discretionary direction, no rule that reads identity. Every allocation rule is linear, so the network structurally favours nobody: founders, whales, and newcomers face identical mechanism surfaces. The expensive-to-fake signal is the supply ledger itself — every JINN traceable to a verified task.

**Learning Maximised:** The protocol never judges what work is worth doing — fee-paying creators select, the oracle verifies, and bad nets starve because nobody funds them, not because anyone policed them. No taste is encoded in the production process; the deterministic-oracle restriction constrains verifiability, not content.

**Governance Minimal:** The economic loop contains zero votes: no gauges, no amplifier elections, no parameter committees. Constants are fixed at genesis; the only governance is the stock Cosmos module, scoped to upgrades, throttled by supermajority and the exit-before-expropriation timelock. Decisions are pushed to mechanism everywhere a mechanism exists.

**Permissionless:** The race lane is a zero-capital, zero-permission on-ramp — anyone with spare inference can mint their first bond by winning their first verified task, with gas sponsored by the task creator. Evaluator and validator roles open by bonding alone. Access-plutocracy in the bonded lane is mitigated, not solved: capital buys parallel capacity but never exclusive access, and track-record credit lets sustained verified throughput substitute for capital over time.

**Prestige:** Earnings are uncapped and capacity compounds with demonstrated work: the throughput-credit mechanism (last epoch's verified volume extends this epoch's claim capacity) is literally deference conferred by the mechanism for demonstrated competence, wiped on slash. Nothing confers standing except verified work and honoured bonds.

**Legible:** Total supply equals the sum of per-task verified-work mints — auditable line by line, forever. Disputes resolve by deterministic replay anyone can run. The public monitor (mint provenance, bond and validator concentration, governor headroom) makes the equilibrium's health common knowledge from block one, and the proving window's founder privilege is stated on-chain rather than laundered through a vote.

## Residual Weaknesses

1. The demand bet is not solved, only made legible: if no external creators ever buy JINN to fund work, the economy is founders settling with themselves, G_t halves away, and the chain quiesces visibly. The design makes failure honest, not impossible.
2. Genesis-subsidy farming: while G_t > 0, effective mint-per-fee exceeds 1, so a party can burn fees on low-value-but-oracle-passing self-tasks to harvest the subsidy. The work is real, externally evaluated, and funds the security pool, but the emission share is misallocated toward work whose value only the payer asserts. Bounded by fee burn and compute cost, decaying with G_t — but real.
3. Security in the proving window is ~zero (dust-power PoA). Value-at-risk is also ~zero by the governor, but a costless halt attack on a young chain is reputationally cheap for an adversary and the design cannot price it.
4. Thin-float price manipulation taxes entrants (creators overpaying for escrow JINN, solvers for bonds). No protocol lever exists for the manipulator, but the tax is real and the design only waits it out.
5. The race lane wastes redundant compute by construction and exposes creators' feegrant budgets to spam up to their chosen cap. This is the price of a capital-free on-ramp, paid in the one abundant resource (idle inference), but a griefing surface nonetheless.
6. Bonded-lane access remains capital-weighted: a whale can bond enough to claim most exclusive tasks in parallel. Slashable, non-exclusive (race lane always exists), and throughput-credit erodes the advantage over time — but plutocracy is mitigated, not eliminated.
7. Evaluator collusion on low-value tasks: the challenge bounty scales with the bonds at stake, so micro-fraud on micro-tasks may not attract challengers. Determinism keeps it provable forever, which deters but does not prevent.
8. Retroactive slashing reaches only still-bonded funds: a patient adversary can run honest for 21 days, queue unbonding, and defect at the boundary. Rate-limited to one bond's worth per identity per cycle, not impossible.
9. Chain-level governance capture is slowed (supermajority, timelock >= unbonding) and bounded (governor, forkability), never eliminated — a sovereign chain's gov module is an irreducible attack surface and this design says so.
10. Creators bear JINN volatility across the task lifetime; for long tasks this is a real hedging burden pushed out of protocol.
11. v1 is deterministic-oracle-only: SolverNets needing consensus- or market-graded oracles cannot launch until Phase B.2 evaluator economics ship. A real restriction on day-one breadth, accepted under Gall's Law.
12. No identity system means nothing prevents one party from BEING most of the early network across roles; the only standing claim is the structural one — whoever they are, they did the verified work and posted the slashable bonds.

## Parameters

### Derived Mechanisms

- **Solver bond ratio (bond = 1.0 x escrow):** Value-at-risk matching: the bond covers exactly what a false settlement could misdirect (the escrow). Not a chosen multiplier — the damage defines the collateral.
- **Settlement governor ceiling (open escrows <= 1/3 bonded stake):** 1/3 is the Tendermint fault threshold — the minimum stake fraction whose corruption threatens settlement. Cost-of-attack >= value-at-risk follows by construction; same denomination, so no price feed. *(Attack note: refuted — wrong threshold. See ranked doc.)*
- **Emission recycle factor (k = 1: mint_t includes burn_{t-1}):** Supply neutrality at steady state — every fee-burned JINN re-minted to the verified work the fee funded. k > 1 reopens lock-to-print; k < 1 taxes growth; 1 is the unique neutral point.
- **Allocation rule (linear pro-rata to per-task fee burn):** Linearity is the unique rule invariant to both task granularity (no mega-task bundling) and address splitting (sybil-neutral). Any convexity rewards consolidation games; any concavity rewards splitting.
- **Throughput credit (capacity = bond + last epoch's verified volume):** rho = 1: your verified throughput is itself the credit you carry forward. Slash wipes it. Sybil-neutral (splitting splits both terms linearly) and the structural fix for yield-for-presence — presence earns nothing, verified work earns both mint and capacity.
- **Evaluator assignment (bond-weighted uniform random, protocol-side):** Sybil-neutral by linearity of expectation; creator excluded from selection.
- **Upgrade timelock (execution delay >= unbonding period):** Exit-before-expropriation: the inequality, not the duration, is the mechanism — any staker can fully exit between a hostile proposal passing and executing.

### Irreducible Numbers

- **Fee rate phi = 10% of escrow:** A take rate has no derivation; every marketplace asserts one. Fixed at genesis, changeable only by gov supermajority through the timelock. Named as a legitimacy tax and paid openly.
- **Fee split 1/3 evaluator / 1/3 security / 1/3 burn:** Symmetry as Schelling point — equal thirds is the least-arbitrary assertion available when no derivation exists.
- **Genesis per-epoch mint E_0:** Pure numeraire scale, economically arbitrary in the same sense as Bitcoin's 50 — it sets unit size, not relative allocation, since all distribution is pro-rata to work regardless.
- **Halving period H = 182 daily epochs (~6 months):** Genuinely irreducible. Shorter starves the bootstrap before external demand can arrive; longer extends the reflexive subsidy. Owned, not derived.
- **Challenge window = 24 hours; unbonding = 21 days:** The binding constraint IS derived (unbonding >> challenge window, so nothing fraudulent goes liquid before it is provable); the durations are conventions — 21 days is the Cosmos ecosystem Schelling default, 24h is asserted.
- **Proving-window emission split 90% solver / 10% attestors:** Evaluation by re-execution costs roughly an order of magnitude less compute than solving; 90/10 encodes that estimate and is owned as an estimate.

## Deferred

- Non-deterministic and subjective oracles, and the full evaluator-economics stack they require (consensus grading, escalation games) — Phase B.2; v1 admits deterministic oracles only.
- Bond delegation markets (Livepeer-style): explicitly refused for v1, not merely deferred — delegation reintroduces presence yield, the philosophy's named enemy; any future version must prove it does not.
- Throughput-credit refinements: multi-epoch decay curves, cross-SolverNet portability, recovery-after-slash schedules. v1 ships one-epoch memory.
- Cross-repo and multi-tenant SolverNets with data-privacy machinery. v1 is the Jinn repo plus any creator willing to expose a public deterministic oracle.
- Stable-denominated quoting and hedging layers for creators — edge tooling, out of protocol.
- Watchtower/challenge-market tooling so third-party re-execution is one command.
- Fee-rate and split recalibration mechanism beyond raw gov supermajority — if phi needs to move often, a derived controller should replace the vote; v1 assumes it does not move.
- Race-lane anti-spam refinement beyond creator-capped feegrants (e.g. micro-deposits payable from pending race winnings).
- Public monitor v2: automated concentration alerts and governor-headroom forecasting; v1 ships read-only dashboards.

---

# 5. Anvil — fee-forged issuance with genesis-grade evaluation

**Tagline:** Every JINN is minted pro-rata to non-recoverable fees on triple-verified, re-runnable work; locking time amplifies what cash alone cannot, and fake work cannot collect because any one honest re-runner can slash it.

**Philosophy:** Take the strong-evaluation branch all the way: make evaluation genesis-grade (protocol-assigned, bonded, slashable, commit-reveal, deterministically challengeable), which converts self-dealing from theft into fee-priced primary issuance — then a strong veJINN amplifier is safe to want. The amplifier must clearly beat the null option of raising the cash bounty: locking retains principal while a raised bounty spends it, and the amplifier tier carries the majority of issuance. The honest price of strength: we deliberately let the classical anti-wash inequality break in value terms, and re-characterise bounded self-funded farming as a transparent on-chain sale of JINN at a legible implied price, with proceeds funding security.

*(Attack note: both load-bearing claims were judged fatally flawed — the fee-recovery loop and oracle-passing-worthless work. See ranked doc.)*

## Mechanism

### Emission Policy

Fixed, Bitcoin-style disinflationary supply schedule S(t); each epoch's mint splits into two tiers.

**TIER 1 (base, B_base):** distributed pro-rata to each settled, oracle-passed task's non-recoverable fee — task share = task fee / Σ fees that epoch. No JINN needed to qualify; this is how JINN-less creators attract solvers and how supply enters existence.

**TIER 2 (amplifier, B_amp = 2 × B_base):** distributed pro-rata to veJINN pointed at fee-cleared tasks; ve pointed at a zero-fee task counts zero (the product gate survives as a gate, not a multiplication, so units never need a price oracle). Per-task cap: amp emission ≤ (μ_max − 1) × that task's base emission (μ_max = 4), making the wash bound explicit and per-task. Unallocated B_amp (no locks, or caps binding) is simply not minted.

Each task's emission splits 85% solver / 15% assigned evaluators, all of it vesting linearly over 4 epochs.

Mechanism over magic number: there is no free-standing budget B — work issuance is an every-epoch pro-rata auction of a fixed schedule against real burned fees, so the implied issuance price F_epoch/B_epoch is an emergent, on-chain quantity, not a chosen one.

### Token Value Anchor

Exogenous value enters exactly once: the non-recoverable fee (10% of every escrowed bounty), routed 50% to bonded validators and 50% to that task's assigned evaluators. Every JINN minted is therefore matched by pro-rata burned-fee revenue — issuance is fee-collateralised, and the implied price F/B is on-chain and legible.

JINN is worth holding for three protocol-native reasons:
1. Locking it as veJINN captures the majority issuance tier and makes a creator's recurring task flow command more solver/evaluator firepower per dollar — at the cost of time, not principal;
2. Bonding it is the only ticket to evaluator income (USDC fee share + JINN emissions);
3. Staking it collects the validator half of all fee flow.

All three are claims on the exogenous fee stream or on amplification productivity, not on narrative.

### Security Budget

Validators receive zero inflation. Their income is gas plus a 50% share of every non-recoverable fee, distributed pro-rata to bonded stake — so security income scales with settled volume by construction, which is exactly the invariant Problem 3 demands, and the three-mouths problem dissolves: workers get the mint, security gets the exogenous stream. Validators are volume-aligned (censoring settlement starves their own income).

Cost-of-attack tracking is structural rather than hard-enforced at v1: evaluator bonds scale with emission at stake, creator locks scale with amplifier appetite, and validator stake competes for a fee stream that grows with volume — all three pull JINN off the market as activity grows. A hard cost-of-attack ≥ value-at-risk throttle needs a price oracle and is deferred; v1 ships a block-1 public monitor (settled volume vs bonded-stake value, validator concentration) so the ratio is common knowledge, not a private worry.

### Bootstrap

**Genesis block:** zero JINN supply — truly no premine. Consensus bootstraps with a publicly named PoA seat set (founders plus anyone who signed up pre-genesis, open list), each seat holding one fixed power unit and zero tokens; real power is bonded JINN, so PoA seats dilute automatically and continuously as stake bonds — no handoff date, no threshold, the trust step decays by arithmetic.

**Epoch 1:** founders escrow USDC bounties on Jinn-repo coding tasks, visibly and on-chain — the design makes "we are the only buyer so far" a fact on a dashboard, not a hidden subsidy. Fees route to the (near-empty) validator and evaluator pools. Solvers submit; three protocol-assigned evaluators re-run the pinned test-suite container under commit-reveal; settlement releases the bounty and mints Tier-1 emissions, vesting over 4 epochs.

Epoch-1 evaluators bond nothing (nothing exists to bond) — slashing teeth come from vesting clawback: provable misattestation forfeits all unvested JINN. From then on the bond requirement ramps as min(3 × emission at stake, cumulative vested earnings) — continuous, no cliff, no founder-chosen window size.

The amplifier tier activates automatically the moment anyone locks the first vested JINN; until then B_amp goes unminted. Handoff from founder-funded to external demand is therefore not a schedule but an observable: the fee-source mix on chain.

### Evaluation

Genesis-grade, and launch-feasible precisely because the launch oracle is deterministic. v1 admits only re-runnable oracles: a task's SolverNet manifest pins a container image, seed, and test command.

**Assignment:** r = 3 evaluators drawn stake-weighted-random from the bonded pool (selection weight linear in bond, so splitting a bond across sybils changes nothing).

**Commit-reveal:** each evaluator re-runs the container, commits H(resultHash ∥ salt), then reveals — laziness-by-copying is impossible, and guessing "pass" is caught whenever the truth is fail.

**Slashing:** provable misattestation (your reveal contradicts the deterministic re-run) slashes the full bond plus all unvested emissions; non-reveal slashes 10% plus a cooldown.

**Challenge:** permissionless — anyone with the container can bond a challenge during the settlement window; the re-run adjudicates mechanically; the challenger takes a share of the slash. Collusion cost is therefore not merely expensive but futile for deterministic oracles: corrupting all three assigned evaluators (which you cannot choose) still loses to a single honest re-runner anywhere in the world. Founders run a watchtower at genesis and say so; the role is permissionless.

This is what licenses the strong amplifier: fake work cannot collect, so amplified self-dealing must contain real oracle-passing work.

### Settlement Currency

Both, with sharply separated roles. Bounties and fees settle in USDC (IBC from Noble) — the exogenous demand signal must be outside money, and pretending otherwise re-imports reflexivity. The protocol's own books — bonds, locks, stakes, emissions — are JINN-native and never touch Circle.

Consequences owned: a Circle blacklist or bridge failure can freeze in-flight escrows but cannot touch consensus, bonds, or issuance; the escrow interface is asset-agnostic so USDC is a default convention rather than a protocol constant, but v1 restricts base-emission fee-weighting to the single canonical asset to avoid price oracles — bounties in other IBC assets settle but earn no emission, a named limitation.

### veJINN Role

Keep, strengthened and narrowed. veJINN never votes — gauge steering is dead (Curve/Convex result) and chain governance is a separate surface. Its sole function is amplification of the holder's own funded demand: ve = amount × (remaining lock / max lock), linear (convexity rewards either whales or splitting; linearity is the sybil-neutral point), pointed at the locker's own fee-cleared tasks, drawing from B_amp = 2 × B_base subject to the per-task μ_max cap.

The honest justification for keeping it: with weak evaluation the anti-wash inequality forces the amplifier below the null option of raising the cash bounty, and a token nobody rationally locks is dead weight; with genesis-grade evaluation the amplifier can be genuinely strong — locking retains principal where a raised bounty spends it, and the amp tier is the majority of issuance, so for any repeat creator locking strictly dominates once expected amp yield exceeds illiquidity cost. Early lockers face little competition for B_amp: a permissionless time-priority advantage, not an allocation.

### Anti-Capture

Founders hold no premine, no allocation, no admin path; their genesis privileges are exactly two, both named: curating their own repo's oracle (the same privilege every net launcher has over their own net) and the decaying PoA seats.

Emissions track verified work pro-rata to burned fees, so sybils gain nothing — five addresses must burn five fees and pass five oracles. Whale amplifier domination is bounded per task by μ_max × base, and base requires recurring real fee burn routed to validators and evaluators — domination is a purchase, visible and priced, not a vote.

Cosmos gov module handled by shrinking its blast radius: all economic constants (supply schedule, μ_max, φ, r, k, splits) are consensus-level constants changeable only by chain upgrade — a social-fork event requiring validator supermajority adoption — not by gov param vote; the gov module retains only operational parameters. veJINN carries no governance weight, so locked capital cannot buy direction.

Block-1 public capture monitor: validator concentration, amp-share concentration, fee-source mix, work-vs-capital flow split — capture becomes common knowledge fast, which is both deterrent and fork trigger.

## Solves the Three Problems

### Problem 1 — Non-Capture

The three concentrations get three different treatments.

**Earned-work concentration:** untouched and uncapped — emissions are pro-rata to fee-cleared verified work, so it is Prestige-legitimate by construction.

**Consensus power:** validators earn fees not inflation, so stake accumulation requires buying JINN from workers at market; PoA seats dilute automatically; concentration is monitored publicly.

**Emissions direction — the real surface:** there is no direction to capture. Gauge votes are deleted; the only steering instruments are burned fees (real money, routed to security) and self-pointed locks (capped at μ_max × your own fee-derived base). Sybils are everywhere-neutral because every rule is linear in an un-splittable resource: fees burned, work verified, time locked, stake bonded.

### Problem 2 — Bootstrap

The 0/0 dies because Tier 1 needs no veJINN: epoch 1 mints against fees alone, and fees exist the moment founders escrow the first bounty — which the design forces into the open as the on-chain fee-source mix rather than hiding behind a seeded gauge. No designated bootstrap net, no founder-chosen gauge weight, no handoff schedule: any net that burns fees earns base emission from block 1, and the amplifier self-activates on the first lock.

The bondless window is not a window — vesting clawback gives slashing teeth before bonds exist, and the bond requirement ramps continuously with each evaluator's own vested earnings.

**Market genesis:** the per-epoch pro-rata mint against fees IS the acquisition venue — a continuous, permissionless, fair auction at the legible implied price F/B; later creators acquire JINN by funding real tasks, solving, or evaluating, with no liquidity event, no sale, and no DEX dependency at genesis.

### Problem 3 — Security Budget

Validators are funded entirely from the non-recoverable fee (50% of it, pro-rata to stake) plus gas — the unexplored lead, taken whole. Security income scales with settled volume by construction; the three-claims-on-one-pie problem disappears because validators never touch the mint; and the one stream that must reward capital is fed exogenous USDC rather than dilution, so it cannot silently tax workers. The residual — no hard invariant forcing cost-of-attack above value-at-risk — is named, monitored on-chain from block 1, and structurally leaned against by three JINN sinks (bonds, locks, stake) that all grow with activity.

## Amplifier Fork

**STRONG branch, committed.** Genesis-grade evaluation is pulled into the launch-critical set, and the consequence is owned: because fake work cannot collect (deterministic re-run + commit-reveal + any-single-honest-challenger slashing), a self-dealt task must contain real oracle-passing work, so the amplifier can be made genuinely attractive — majority of issuance, principal-retaining versus the principal-spending null option of raising the bounty.

The Gall's Law objection is answered by the launch oracle itself: genesis-grade evaluation over a deterministic test-suite oracle is re-run + hash-compare + clawback — simple machinery over an objectively re-checkable claim, no juries, no subjective adjudication. Subjective oracles, where genesis-grade evaluation would actually be heavy, are excluded from v1.

## Standing Critique Answers

**Degeneracies:**
- *Genesis 0/0:* gone — Tier 1 is fee-only, Tier 2 self-activates, unallocated amp goes unminted.
- *Bundling:* gone — both tiers are linear (base ∝ fee, amp ∝ ve, cap ∝ base), so splitting a task n ways with fees and locks split proportionally leaves every share identical; there is no normalised product to game.
- *JINN-less creators:* never tolled — the base tier gives full fee-pro-rata emission attraction with zero JINN; the amplifier is a bonus for repeat creators, not a gate on entry.
- *New degeneracy introduced and named:* tiny-task spam taxes the three-evaluator panel, patched with a dust-floor minimum fee that is honestly a magic number.

**Stablecoin dependency:** Explicit stance: accept it at v1, contain it, and say so. USDC (via Noble/IBC) is the bounty and fee rail because the demand signal must be outside money; the containment is that JINN-native books (consensus, bonds, locks, issuance) are unreachable by Circle, the escrow interface is asset-agnostic by design, and the single-canonical-fee-asset restriction exists only to avoid a price oracle, with multi-asset weighting deferred. The neutrality cost is real and is listed as a residual weakness, not papered over.

**Market genesis:** Issuance is the market: every epoch the fixed mint is auctioned pro-rata against burned fees, so anyone can acquire JINN permissionlessly from the protocol at the on-chain implied price F/B by funding, solving, or evaluating real work. Thin-float manipulation is damped by vesting (4 epochs on all emissions) and by the implied price acting as a public anchor; the arbitrage loop is self-correcting — if market price exceeds implied price, fee-burning inflows rise, which raises F against fixed B and closes the gap, with the proceeds funding validators and evaluators the whole way.

**Reflexivity:** Named and engineered around rather than denied. The amplifier's prize is JINN — reflexive — but it is capped per task against base emission, and base emission is collateralised one-for-one in pro-rata burned fees, so the amplifier redistributes fee-anchored issuance rather than printing against its own narrative. The genuinely exogenous inflow — the non-recoverable fee — is where token value anchors: staking and evaluating are claims on that flow, and the implied issuance price makes the anchor a number anyone can check, not a story.

## Principles Fit

**Neutral:** No premine, no allocation, no admin keys to renounce because none exist; issuance pro-rata to burned fees is a signal that is cheap to emit and expensive to fake (it costs real money that you never get back). Founder privilege reduces to curating their own repo's oracle — structurally identical to any net launcher's privilege — plus PoA seats that dilute by arithmetic.

**Learning Maximised:** The protocol never judges work quality and encodes no taste: evaluation is mechanical re-execution of the net's own pinned oracle, selection between nets is purely economic (fees burned), and oracle design is left to net launchers — search over oracle designs is funded, not policed.

**Governance Minimal:** Gauge votes deleted; veJINN carries zero governance weight; economic constants are upgrade-only consensus constants, shrinking the gov module's blast radius to operational parameters; every steering decision is pushed to mechanism (fees, locks, bonds) rather than ballots.

**Permissionless:** Zero JINN required to create (base tier), solve, or launch a net from block 1; evaluator entry is bondless at first via vesting-clawback and ramps with the entrant's own earnings; the challenge role is open to anyone with a container; acquisition needs no sale, listing, or permission — fund or do work.

**Prestige:** The largest holders are necessarily the largest verified workers or the largest fee burners; earned concentration is explicitly uncapped; evaluator standing is bonded, slashable history; nothing confers deference except demonstrated, re-checkable performance.

**Legible:** Every load-bearing quantity is on-chain and independently checkable: the implied issuance price F/B, fee-source mix (exposing founder-funded genesis honestly), amp shares and the μ_max cap, validator concentration, and every attestation — which anyone can falsify by re-running a pinned container. The block-1 monitor turns capture risk into common knowledge.

## Residual Weaknesses

1. Weak-oracle farming is openly profitable whenever market price exceeds the implied issuance price F/B: a farmer can mass-produce oracle-passing-but-worthless work, burn fees, and mint at a discount, diluting honest earners until the arbitrage loop closes. The design prices and bounds this (μ_max × own fee share, proceeds to security) rather than preventing it, and the negative feedback converging is an assumption, not a theorem.
2. The PoA genesis validator window is a real trust step. Dilution is automatic but its early duration depends on how fast outsiders bond — founders effectively hold consensus during the lowest-stakes period, which is honest but is still founder consensus.
3. No hard mechanism enforces cost-of-attack above value-at-risk; v1 has only structural sinks plus a public monitor. If settled USDC volume outruns JINN market cap faster than the sinks bite, attacking settlement turns profitable and the protocol can only make that visible, not impossible.
4. Circle blacklist or Noble/IBC bridge failure can freeze every in-flight bounty escrow. Consensus and issuance survive, but the task economy halts — a single-counterparty neutrality cost at the heart of a sovereign chain.
5. Evaluator-assignment randomness drawn from block entropy is weakly grindable by a colluding proposer; the deterministic challenge bounds the damage to delay and assignment bias rather than false settlement, but the bias is real until a proper VRF or randomness beacon ships.
6. Flaky test suites blur the slashing condition. The "deterministic-or-fail" manifest rule pushes that cost onto net designers, which will generate disputes at the oracle boundary and could chill legitimate nets whose domains resist pinning.
7. The strong amplifier deliberately violates the classical anti-wash inequality in value terms; if genesis-grade evaluation has any gap (randomness grinding plus zero honest challengers in a window), that violation converts directly into uncollateralised extraction.
8. Three-fold re-execution taxes small tasks; the dust-floor minimum fee is an irreducible founder-chosen number and a standing legitimacy tax.
9. Early float is thin and vesting makes it thinner; lock decisions under high volatility may deter exactly the locking the amplifier tier needs, leaving B_amp unminted and the strong-amplifier thesis untested for longer than expected.
10. Constitution-by-upgrade narrows but does not delete the Cosmos gov capture surface: a validator supermajority can still adopt a hostile upgrade, and the only remedy is the social fork the monitor is meant to trigger.

## Parameters

| Name | Kind | Detail |
|---|---|---|
| Supply schedule S(t) | irreducible-number | Fixed disinflationary mint per epoch (Bitcoin-style halvings, e.g. 4-yearly). Irreducible — but fixity itself is the legitimacy device: the most fork-tested commitment in the industry, chosen once, never voted. |
| Implied issuance price F/B | derived-mechanism | Total non-recoverable fees per epoch divided by that epoch's mint. Emergent, on-chain, and the anchor for the wash-arbitrage negative feedback — never set by anyone. |
| Tier split B_amp : B_base = 2 : 1 | irreducible-number | The strong-amplifier commitment in one number: the lock tier carries the majority of issuance so locking clearly beats raising the bounty. Irreducible; consequences (early-locker pull, wash bound) derive from it. |
| Per-task amplification cap μ_max = 4 | irreducible-number | Amp emission ≤ (μ_max − 1) × base emission per task. This is the explicit, per-task anti-wash dial: maximum self-capture = μ_max × own fee-derived base. The number is chosen; the bound it produces is derived and auditable. |
| Non-recoverable fee φ = 10% of escrow | irreducible-number | The exogenous revenue and anti-wash floor. Split 50/50 between bonded validators (pro-rata stake) and the task's assigned evaluators — the split is a second irreducible number inside this one. |
| Evaluator panel r = 3 | irreducible-number | Smallest odd panel with a majority. Quasi-derived (minimality argument) but still a chosen integer. |
| Bond ramp = min(3 × emission at stake, cumulative vested earnings) | derived-mechanism | Evaluator bond requirement grows continuously with the entrant's own earned history — no bootstrap cliff, no founder-chosen window, bondless entry at genesis with teeth supplied by vesting clawback. The multiple 3 inside it is irreducible. |
| Emission vesting v = 4 epochs | irreducible-number | All emissions vest linearly; unvested balances are the genesis-era slash collateral and the thin-float damper. |
| PoA seat dilution | derived-mechanism | Genesis seats hold one fixed power unit each; real validator power is bonded JINN. The trust step decays by arithmetic as stake bonds — no transition date, no threshold. |
| veJINN curve: ve = amount × remaining/max lock, max 104 weeks, linear | derived-mechanism | Linearity is derived from sybil-neutrality (convexity rewards splitting or whales); the 104-week cap is the irreducible number inside it. |
| Unallocated B_amp unminted | derived-mechanism | If no ve is pointed (genesis) or caps bind, the amp tier simply does not mint — solves 0/0 with no seeded gauge and makes early under-locking deflationary rather than founder-directed. |
| Dust-floor minimum fee | irreducible-number | Anti-spam floor protecting the three-evaluator panel from micro-task griefing. Honestly a magic number; flagged as a standing legitimacy tax in residual weaknesses. |

## Deferred

- Subjective and non-re-runnable oracles (LLM judges, human juries, market resolution) — v1 admits only deterministic pinned-container oracles, which is precisely what makes genesis-grade evaluation simple enough to ship.
- Hard cost-of-attack ≥ value-at-risk settlement throttle — requires a price oracle; v1 ships the public monitor only.
- Multi-asset fee weighting — bounties in non-USDC IBC assets settle but earn no emission until a DEX/TWAP exists to compare them.
- On-chain DEX and any liquidity infrastructure — issuance-as-acquisition covers market genesis; secondary markets emerge or do not, off the critical path.
- Proper VRF / randomness beacon for evaluator assignment — v1 uses block entropy with the grinding risk named.
- veJINN delegation, transferable locks, or any lock secondary market.
- Reputation or prestige scoring beyond raw on-chain earned/slashed history.
- Evaluator specialisation markets and differentiated panels per oracle type.
- Slashing insurance and bond underwriting.
- Any learning/capability-compounding claim — tracked as cost-per-merged-edit, never a launch gate, per the simplified launch logic.
