# Five genesis economic designs, attacked and ranked

- **Version:** 0.1
- **Date:** 2026-06-11
- **Author:** Oak (multi-agent workflow, synthesised by assistant), for the economic-design session with Ritsu
- **Status:** Working result. Five independent complete economic designs for the sovereign-chain genesis, each solving Problems 1–3 plus the standing critique, each adversarially attacked, ranked by a three-lens judge panel.
- **Related:** [`2026-06-10-outstanding-economic-problems.md`](2026-06-10-outstanding-economic-problems.md) (the three problems); [`2026-06-11-demand-gated-emissions-design.md`](2026-06-11-demand-gated-emissions-design.md) (**superseded by this result** — see Meta-findings); [`2026-06-09-simplified-launch-logic.md`](2026-06-09-simplified-launch-logic.md); full design texts in [`2026-06-11-genesis-economic-designs-full.md`](2026-06-11-genesis-economic-designs-full.md).

## Method

Five designer agents, each committed to a distinct philosophy spanning the design space (fee-anchored minimalist; right-to-work staking; strong amplifier + genesis-grade evaluation; JINN-native no-stablecoin; capacity-priced settlement). Each received the three problems, the full standing critique (the amplifier fork, degeneracies, reflexivity, market genesis, mechanism-over-magic-number), PRINCIPLES.md, and the hard constraints (no identity system, fair launch, sovereign Cosmos chain, Gall's Law). Each design was then attacked by a dedicated adversarial agent (sybils, wash-trading, founder capture incl. the Cosmos gov module, bootstrap death-spirals, consensus attacks, bribery, thin-float, dependencies, principles). A three-lens judge panel (economic security; principles/legitimacy; shippability) scored all five with attack reports in hand.

Caveat: the three judges are one model behind three lenses — diverse criteria, correlated judgement. The unanimity below is corroborated by the independently-produced attack reports, which is why it carries weight.

## Ranking

| Rank | Design | Philosophy | econ-security | principles | shippability | Total /180 | Survived attack? |
|---|---|---|---|---|---|---|---|
| 1 | **Watermill** | Fee-anchored minimalist | 42 | 43 | 43 | **128** | **Yes** (0 fatal flaws) |
| 2 | **Full Cover** | Capacity-priced settlement | 33 | 31 | 27 | **91** | No (3 serious cracks) |
| 3 | **The Forge** | JINN-native, no stablecoin | 20 | 22 | 21 | **63** | No (4 fatal) |
| 4 | **Born Bonded** | Right-to-work staking | 21 | 20 | 19 | **60** | No (4 fatal) |
| 5 | **Anvil** | Strong amplifier + genesis-grade evaluation | 16 | 18 | 14 | **48** | No (2 fatal) |

First, second, and last place were unanimous across all three lenses.

---

## 1. Watermill — the winner

**Tagline:** JINN mints only against settled demand; the same non-recoverable fee that mints it funds the validators who settle it — no flow, no flour.

**Core mechanism.** One supply curve, no epochs, no budget, no steering. `F` = cumulative settled non-recoverable fees (USDC, an on-chain counter). A task settling with fee `f` mints the integral of a declining ratio `r(F) = r0/(1+F/F0)²` to its solver; total supply `S(F) = S_max·F/(F+F0)` is hard-capped, approached only in the limit of infinite cumulative demand. Zero demand mints zero, forever. Early fee-funded work mints far more per fee-unit — Bitcoin's early-era incentive without the clock. 100% of the mint goes to solvers; validators receive **no mint ever** — their income is 100% of the fee stream, distributed in USDC pro-rata to bonded stake, so staked JINN is a DCF-able claim on real protocol demand. Bootstrap: a published permissionless testnet window converts oracle-verified work share into non-transferable, fee-earning, **expiring** "genesis bonds" (consensus weight, not tokens; founders ≈ zero); they sunset when `F` crosses `F0` — a demand milestone, not a clock or a decision. veJINN: killed. Economic constants compiled into the binary — changing them is a hard fork, not a gov vote.

**The structural insight that wins it:** *the mint prices fees, not work-claims.* A fully rigged oracle that "settles" mints exactly what its surrendered fee buys, never more — so evaluation failures cannot fool the issuance, and evaluation is honestly deferrable (it guards bounties, not the money printer). This is the only resolution of the amplifier fork among the five that holds rather than asserts: both branches become unnecessary.

**What the attack found (survives, with four corrections required):**
1. *Whale-staker mint discount compounds supply.* A staker with bonded share σ self-deals fees at effective price (1−σ)/r — a real plutocratic accumulation channel. The design's claim that "capital concentration in stake does not compound into supply concentration" is **false as written** and contradicted by its own residuals; strike and rewrite as "compounds more slowly, is not eliminated."
2. *The mint-arbitrage price ceiling is insider-only.* Minting requires being solver-of-record on an oracle-passing task; an ordinary holder cannot "surrender fees to mint at par." The corridor narrative must be weakened.
3. *Founder refereeing of the pre-genesis window.* Founders control the merge gate during the very window that fixes genesis-bond weights — discretion over the genesis validator distribution that the design understates. The hardest open dent; see Meta-findings.
4. *Multiple-collapse regime has a monitor, no brake.* A JINN price crash while volume holds drops cost-of-attack toward in-flight escrow with nothing mechanical in between. The docs must mandate, not merely warn, against settling large value in thin conditions.

**Why it wins on every lens:** non-reflexive issuance (mint is a function of cumulative exogenous fees only); emissions-direction capture deleted rather than defended; degeneracies closed by a path-independent integral (bundling-neutral, no 0/0, creators never need JINN); smallest launch surface of the five (stock Cosmos staking + x/distribution, one small custom module, a mint hook on one counter); failures are prose overclaims needing redrafting, not mechanism failures needing redesign.

## 2. Full Cover — strong skeleton, three cracks

**Tagline:** bonded stake underwrites settlement capacity; validators earn congestion-priced fees in hard currency; emissions are a value-capped rebate (k = ⅓) of fees actually paid.

**Core mechanism.** A coverage invariant — total exposure ≤ slash-fraction × ⅓ × stake value at the trailing-window **minimum** price — with an EIP-1559-style congestion fee `f0/(1−u)` on settlement, all premiums to bonded stake, and mint capped at one-third of the fee value behind it (converted at the window **maximum** price, so both manipulation directions hurt the manipulator). Equal ceremony dust genesis (1 JINN per genesis validator, founders identical to strangers). Dual settlement rails from genesis: USDC (demand-honest default) and native JINN (the permanent Circle-independent exit). veJINN: killed.

**What broke:** (1) the per-task evaluator is drawn by bond-weighted randomness, but the bond is **recoverable USDC** — capital, not locked stake, skims a network-wide cut of emissions, violating the design's own un-splittable-resource constraint; (2) the coverage anchor is reflexive — stake value runs through the endogenous token price, so "cost-of-attack ≥ value-at-risk by construction" is a *ratio* guarantee sold as a *level* guarantee; (3) exposure already in the 21-day window was admitted at stale prices — a crash leaves in-window USDC-denominated escrow backed by halved stake value. Plus a wholly unaddressed regulatory surface: the insurance/underwriter/premium framing is a near-textbook investment-contract description, made trivially provable by the design's own legibility.

**Worth salvaging:** the window-extremum fail-safe pricing, the k = ⅓ wash arithmetic (verified: single-cycle wash-minting is strictly negative-sum), the native-rail exit, and the equal-dust ceremony — the cleanest genesis artefact of the set. The attacker's fixes are concrete: evaluator bonds in slashable JINN, work-weighted assignment, stop claiming a level guarantee, drop the insurance metaphor.

## 3. The Forge — cleanest neutrality, the merge gate is the premine

**Tagline:** every funded task burns more JINN than it mints back (R < 1); usage is the only printer.

**Core mechanism.** JINN-only — no stablecoin, no bridge, no price oracle anywhere in the task path. Every task's non-recoverable slice part-burns, part-funds validators; on oracle-pass the protocol mints R × burn (R = 0.5) to the solver — wash-trading is negative-sum *by construction*, even at full creator-solver-validator collusion (net cost 0.25N at defaults; arithmetic verified by the attacker). Genesis ledger = the testnet verified-work record, 1:1, nothing else. A halving Genesis Work Stream covers the zero-volume window. veJINN: killed.

**What broke (four fatals):** (1) **the merge gate is the premine** — founders are sole creators *and* sole merge referees on the only genesis issuance stream, and halving front-loads exactly the window where their curation is total, minting the dominant permanent stake before the "decaying privilege" decays; (2) the JINN/JINN settlement governor is a tautology — cost-of-attack is stake × *market price*, and the repo's own ratified spec (2026-06-05 §6) already says so; (3) permissionless-from-block-1 validation discards the project's own cold-start finding (economic security and cold start are mutually exclusive); (4) demand genesis is unhedged — "mandatory working capital" is worth nothing for a network nobody uses.

**Worth salvaging:** the stablecoin refusal is the best answer to the neutrality cost in the set (genuinely eliminated, not mitigated), and R < 1 burn-coupled minting is the simplest wash-proof issuance rule found — one line, zero external dependencies.

## 4. Born Bonded — honest work-token, philosophy fails on its own terms

**Tagline:** every JINN arrives already at stake; capital buys the right to attempt work at risk; only verified work mints.

**Core mechanism.** Solvers bond to claim, evaluators bond to attest, validators stake to settle; emissions mint **bonded** (21-day unbond ≫ 24-hour challenge window, so fraudulent mint can never go liquid before it is provable); a zero-capital "race lane" mints a newcomer's first bond against their first verified work; long-run mint = recycled fee burn (supply-neutral). JINN-only. veJINN: killed.

**What broke (four fatals):** (1) the philosophy is internally false — validator fee-yield pro-rata to stake **is** the presence-yield the design claims to have excised, renamed; (2) the settlement governor defends the ⅓ *halt* threshold when theft lives at ⅔, where the captors control slashing itself; (3) the genesis tranche is a founder-farmable de-facto premine (real-but-worthless oracle-passing self-tasks harvest the subsidy); (4) a security-leg starvation spiral — every incentive routes capital to bonds, not validator stake, so the escrowed economy may never open.

**Worth salvaging:** mint-bonded emissions with unbonding ≫ challenge window (the cleanest anti-fraud-liquidity construction found); linear pro-rata allocation (proven sybil- and granularity-invariant); the race lane as a permissionless zero-capital on-ramp — with its spam surface priced in.

## 5. Anvil — the strong-amplifier branch, refuted

**Tagline:** locking time amplifies what cash alone cannot; fake work cannot collect.

**Core mechanism.** Two-tier mint: base pro-rata to non-recoverable fees; amplifier tier (2× base) pro-rata to veJINN pointed at the locker's own fee-cleared tasks, capped at 4× base per task. Genesis-grade evaluation: three protocol-assigned evaluators, commit-reveal, deterministic re-run, permissionless challenge, slashing. The only design that kept veJINN.

**What broke (two fatals, and they gut it):** (1) **the fee-recovery loop** — the "non-recoverable" fee routes 50% to validators and 50% to assigned evaluators, both sybil-occupiable by one party at genesis (the evaluator pool is bondless then), so the fee is non-recoverable only against a distinct counterparty the chain cannot guarantee exists; the value anchor is circular exactly when bootstrap depends on it; (2) **oracle-passing-but-worthless work** — the entire evaluation apparatus catches fake *fails*; it cannot catch real-but-worthless *passes*, and the protocol by design never judges quality. The majority issuance tier therefore reliably amplifies worthless self-dealt work. "Fake work cannot collect" is the wrong theorem.

**What this means:** Anvil was the steel-manned case for keeping veJINN — the strong branch of the amplifier fork, with every defence the session identified (genesis-grade evaluation, per-task caps, linear locks). It finished last, unanimously, with fatal flaws *that fire through all of the added complexity*. The fork is resolved by refutation: there is no safe strong amplifier.

---

## Meta-findings — what five independent designers converged on

These held across all five designs regardless of philosophy, which makes them results, not opinions:

1. **veJINN is dead.** 5/5 killed gauge voting; 4/5 killed veJINN entirely; the one design that kept it (with every safeguard) finished last with fatal flaws. **This supersedes [`2026-06-11-demand-gated-emissions-design.md`](2026-06-11-demand-gated-emissions-design.md)** — the amplifier model designed earlier the same day is dominated. The honest functions survive elsewhere: locked time lives in slashable bonds and validator stake; the sink is bonding; steering is deleted.
2. **Anchor token value on the non-recoverable fee.** 5/5 anchored on exogenous money entering the protocol (fee or burn). Token-denominated utility loops were attacked as reflexive everywhere they appeared.
3. **Validators take fees, never mint.** 5/5 adopted Problem 3's lead: security income from the non-recoverable fee, scaling with settled volume; workers take the mint. The three-mouths-on-one-pie problem dissolves in every design.
4. **Linear, per-task, fee-coupled issuance.** 5/5 deleted the shared budget `B` and the product rule. Mint proportional to a task's own fee is split-invariant, bundling-neutral, and defined at genesis — all three degeneracies die by construction.
5. **The hardest residual is the founder-controlled genesis oracle.** Founder merge-gate discretion dented the winner and was fatal twice. No design solved it; the best available (Watermill) bounds it with a published rule, a public log, and expiring weight. **This is the next problem to work with Ritsu.**
6. **The demand bet cannot be mechanised.** All five end at the same wall: if external creators never arrive, no mechanism conjures them. The honest move — unanimous — is making their absence legible (fee-source mix on a dashboard) rather than disguising it with subsidy.
7. **Evaluation is safely deferrable only if issuance does not depend on it.** Watermill's "mint prices fees, not work-claims" is the one construction where a rigged oracle cannot touch issuance. Designs that needed evaluation to protect issuance dragged it into the launch-critical set and broke there.

## Recommendation

Adopt **Watermill as the working base**, with the attacker's four corrections applied (rewrite the supply-compounding claim; weaken the price-corridor narrative; mandate-not-warn on thin-condition settlement; treat the pre-genesis referee window as an open problem, not a solved one). Pull in the salvage list: Full Cover's window-extremum pricing and equal-dust ceremony if a price reference is ever needed; Born Bonded's mint-bonded vesting against fraud liquidity; The Forge's R < 1 burn-coupling if the USDC leg is ever dropped.

## Open decisions before we adopt Watermill

Watermill is the base, not the finished design. One headline decision sits above four corrections.

### Decision 0 (headline) — what currency anchors the fee?

Watermill's fee — the thing the whole token rests on — is **USDC, bridged in from Noble over IBC**. This is the dependency we explicitly said we wanted to avoid, and the design partly *wins because of it*: a fee in real outside money is what stops the mint being reflexive (printing JINN against JINN) and what lets the chain skip a price oracle.

The dependency is contained, not fatal: a Circle/Noble freeze halts *settlement* (no new tasks clear) but not the chain, the ledger, or staking; the fee asset can be swapped by hard fork, carrying the cumulative-fee counter over 1:1; Noble-over-IBC is light-client transport, not a custodial bridge. And the design that refused stablecoins outright — The Forge — was praised by its attacker for exactly that refusal; it lost on other grounds.

The contest separated two questions we had been bundling:
1. **Is "mint only against settled demand" the right shape?** Decisively yes — five independent designers converged on it.
2. **Must the fee be USDC?** No — orthogonal, and genuinely open.

**The fork:**
- **Option A — USDC fee (as written).** Cleanest, directly-observed anchor; no price oracle; but Circle/Noble sits in the settlement path (named, contained).
- **Option B — JINN-denominated fee/burn (The Forge's anchor).** Exogenous value enters when creators buy JINN on the market to spend it; no Circle. Cost: the demand signal the supply curve rests on becomes softer and thin-float-manipulable, and creators must acquire JINN to create — a permissionless toll Watermill currently avoids, plus a mild reflexive loop.

Resolve this first; it shapes everything below.

### The four corrections (from Watermill's own attack report)

Three are honesty fixes to overclaims; one is a real gap.

1. **Strike the false non-compounding claim.** Watermill asserts "capital concentration in stake does not compound into supply concentration." Its own residual refutes it: a large staker can self-deal fees and mint at an effective discount of (1 − stake share), then re-stake. Rewrite as "compounds more slowly than mint-funded validators would, but is not eliminated." A canonical doc cannot state a property its footnotes contradict.

2. **Weaken the price-ceiling claim.** The "anyone can surrender fees to mint at par" ceiling is *insider-only* — minting requires being solver-of-record on an oracle-passing task, so only SolverNet operators can enforce it. State plainly: the fee-stream floor is real; the ceiling binds only for oracle-controllers, not the open market.

3. **The pre-genesis merge gate — the one capture surface no design closed (also Meta-finding 5).** Genesis voting weight derives from testnet verified-work share, but during that window founders are the only creators *and* run the merge gate, so by choosing what merges they shape who gets genesis weight; a quietly-failed rival PR leaves a clean-looking log. Watermill files this as a benign "knowledge head-start." Reframe it as the unsolved capture surface — published rules, public log, and expiring weight are mitigations, not a fix — and put it **first** on the Ritsu agenda.

4. **Make the thin-market warning a hard rule.** If JINN's price crashes while task volume stays high, the cost of attacking consensus drops toward the value sitting in escrow, with nothing mechanical in between (the design deliberately refuses a price oracle, leaving only a monitor). "Do not settle large value while the chain is thin or volatile" must be an enforced limit or an explicit launch constraint, not advice in prose.

### Then — size the irreducible numbers

Watermill owns two numbers as genuinely irreducible: **φ** (the fee fraction) and **F0** (the demand half-scale at which genesis weight sunsets). Size them deliberately in the same session, after Decision 0 and the merge-gate question are settled — both interact with the currency choice and the launch-security constraint above.
