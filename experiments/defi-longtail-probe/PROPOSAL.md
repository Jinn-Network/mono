# Long-tail protocol probe — Step 1 proposal

Status: **awaiting approval. Nothing scored has been run.** The only model calls
made so far are the eight no-tools coverage quizzes in `coverage/` (part of the
Step 1 deliverable per the brief).

## 0. What this is

The prior probe (`skillsbench-jinn-eval-8f3268` worktree, `defi-write-probe/`)
scored claude-sonnet-5 at 46/48 on DeFi writes across
Aave/Compound/Uniswap/Aerodrome/Morpho — the majors. This probe tests whether
that result was "agents are good at DeFi" or "agents are good at protocols with
a thousand tutorials": same harness discipline, ~7 protocol families spread
deliberately across the pretraining-coverage axis, with a no-tools coverage
check positioning every family on that axis before any task is written. The
final report plots pass rate against coverage — that plot is the thesis test.

Model: **claude-opus-5** throughout, same CLI flags as the prior probe.
Rationale, fixed here so the report can repeat it: anyone delegating real money
runs the best model available, so a kill at Opus 5 is a real kill and a gap at
Opus 5 is a real gap.

Decision rules (carried over, restated so they bind): ≥90% on every family
kills the competence thread entirely at the buyer-representative model; any
family ≤70% is product territory, ranked by failure rate × severity; 70–90%
marginal. Stop at RESULTS.md — no skills, no product, no outreach.

## 1. Protocol selection

Seven families, two tiers. TVL figures are DefiLlama, queried 2026-08-03
(`api.llama.fi/protocols`); launch dates verified by web search the same day.

### Mid-tier (documented but mechanically gnarly, far less tutorialized than the majors)

| # | Family | Chain | TVL evidence | Why this shape |
|---|---|---|---|---|
| M1 | **Aerodrome Slipstream** — concentrated-liquidity LP: mint a range position, rebalance it | Base | Aerodrome ~$600M protocol TVL; Slipstream is Base's dominant CL venue | CL position management is the canonical "documented but gnarly" mechanic: tick math, tickSpacing-keyed pools (not fee-keyed like Uniswap v3), stake-in-gauge vs collect-fees exclusivity. Uniswap v3 tutorials actively mislead here. |
| M2 | **veAERO locking + gauge voting** | Base | same protocol | ve(3,3) epoch machinery: weekly epoch boundaries, vote-once-per-epoch, pool-address-not-gauge-address arguments, permanent-lock vs decaying-lock. Documented in docs, near-zero tutorials. |
| M3 | **Pendle PT/YT** — fixed-rate via PT purchase, early exit | Ethereum | Pendle $1.18B across 12 chains, Ethereum 58% | Yield-splitting mechanics: SY wrapping, per-maturity markets, ApproxParams on-chain binary search, PT/YT merge vs post-expiry redemption. Docs exist; the mechanics are genuinely fiddly. |

### Long-tail (post-cutoff launch/redesign or genuinely sparse docs; hard requirements: TVL ≥$5M, EVM anvil-forkable, deterministic verifier constructible)

| # | Family | Chain | Launched | TVL evidence | Why |
|---|---|---|---|---|---|
| L1 | **Aave V4** — hub-and-spoke supply/borrow, V3→V4 migration | Ethereum | **30 Mar 2026** mainnet (post-cutoff) | ~$200M (DefiLlama, listed 2026-03-30) | The cleanest negative-transfer test available: the model knows Aave V3 to the byte (see control quiz) and knows V4 only as a 2024 design paper. Same brand, redesigned architecture, live V3 still running alongside as a decoy. |
| L2 | **Olympus Cooler V2 (MonoCooler)** — borrow USDS against gOHM, repay/withdraw | Ethereum | ~mid-2025 activation; DefiLlama listing 2026-02-21 | $215M | Treasury-as-lender, ratcheting origination LTV, delegation-preserving collateral, min-debt floor. Sits mid-axis: the model knows the design vocabulary but no addresses or parameters. Near-zero tutorials. |
| L3 | **Twyne** — credit-delegation borrow above underlying-market LTV, unwind | Ethereum | Feb 2026 listing (post-cutoff) | $14M | Genuinely novel primitive (rent unused borrowing capacity; intermediate vaults on Euler's EVC/EVK stack). Model has trace concept-knowledge only. |
| L4 | **Fira** — fixed-rate term lending | Ethereum | Jan–Mar 2026 mainnet (fully post-cutoff) | $15M DefiLlama; press reports $450M deposits at launch (discrepancy to verify at build; either way ≥$5M) | Total coverage blank at quiz time — the purest post-cutoff test. Public docs, whitepaper, six audits, published addresses: runtime discovery is possible, pretraining knowledge is zero. |

### Considered and cut (with reasons, so the selection is auditable)

- **Perps on a smaller venue** (Avantis, Synthetix v3): execution depends on
  keeper/oracle price-push infrastructure that does not run on a pinned fork —
  a deterministic verifier can be built, but the *action itself* can't complete
  without live off-chain actors. Harness-incompatible, not uninteresting.
- **Royco V2** ($24M, Feb 2026, incl. Base): deposit-side is verifiable but
  market discovery and reward settlement route through off-chain state (Royco
  API, UMA oracle, LayerZero CCDM) that won't match a pinned fork.
- **AFI Protocol** ($225M, Feb 2026, Base): no discoverable docs or verified
  mechanics at all — can't construct a reference solver or vouch legitimacy.
- **Alchemix V3** ($29M, Apr 2026): solid candidate but duplicates the
  brand-familiar-redesign axis already covered by Aave V4 and Cooler V2.
  First-choice backup if a selected long-tail family fails QA.
- **Grove/Spark/Mellow-class allocators**: deposit-only surfaces, mostly
  curated/permissioned; too thin a write surface to probe execution skill.
- **Monad/HyperEVM natives** (Perpl, nest CL): chain-level anvil-fork risk
  stacked on protocol risk; Ethereum/Base candidates were sufficient.

## 2. Coverage-check results (run 2026-08-03, before any task was written)

Method: claude-opus-5 via `claude -p`, all tools disallowed, fixed quiz
template (`coverage/quiz-template.txt`): what is X / is it live, where, as-of
when / core contracts / mechanical walkthrough of the family's core action /
self-rated confidence. Full transcripts in `coverage/<slug>.answer.md`.
Scoring: **full** = mechanics + contract-level specifics able to guide
execution unaided; **partial** = correct identity and rough mechanics, missing
or wrong contract-level specifics; **none** = blank or concept-trace only.

| Protocol | Score | Evidence highlights |
|---|---|---|
| Aave v3 on Base (control) | **full** | Correct call sequence incl. internal logic; recalled the correct Base Pool address (matches prior probe's verified ADDRESSES.md). Anchors the top of the axis. |
| Aerodrome Slipstream | **full** (mechanics) | tickSpacing-keyed pools, MintParams incl. the Slipstream-specific `sqrtPriceX96` field, stake-vs-fees exclusivity, full mint→stake→exit sequence. Addresses low-confidence. |
| veAERO | **full** | createLock params, vote-takes-pool-addresses, epoch-flip window, claim paths. Unsure whether votes persist across epochs (real quirk we can trap on). |
| Pendle PT/YT | **full** | SY/PT/YT model, Router structs (TokenInput/ApproxParams), redeemPyToToken flow, vanity router addresses recalled at medium confidence. |
| Cooler V2 | **partial** (high end) | Knew the MonoCooler codename, design, approximate signatures incl. DelegationRequest arrays and min-debt floor; zero addresses, params low-confidence, launch date fuzzy. |
| Aave V4 | **partial** (concept only) | 2024 design-paper vocabulary (hub/spoke, liquidity premium); explicitly refused to give a V4 call sequence: "I don't know V4's function signatures… Guessing here would produce plausible-looking, wrong code." Zero deployed-contract knowledge. |
| Twyne | **none** (trace) | Concept inferred, hedged; "I know no addresses… that is the failure mode you are testing for." No mechanics. |
| Fira | **none** | Clean blank: "The name doesn't map to anything in my memory." Refused to fabricate. |

Two observations that sharpen the probe, recorded now so they inform prediction
honestly rather than post-hoc:

1. The axis has real spread — exactly what the pass-rate-vs-coverage plot
   needs. No selected family had to be discarded for surprise-full coverage.
2. Opus-5's no-tools behaviour is strikingly calibrated: at the empty end it
   refuses to fabricate rather than hallucinating. The live question is
   therefore not "does it hallucinate stale knowledge" but "does runtime
   discovery (docs, web, on-chain reads) fully compensate for zero pretraining
   coverage under agentic conditions" — and whether V3-shaped habits actively
   mislead it on V4 (negative transfer).

## 3. Harness — reuse with four deltas

Copy `defi-write-probe/harness/` (anvil lifecycle, viem chain helpers, trial
scaffold, resumable matrix runner, cost/gas instrumentation, severity mapping,
analyzer) into `defi-longtail-probe/harness/`. Per the brief: copy, don't
rebuild. Deltas:

1. **Model**: `claude-opus-5`, same flags (`--permission-mode bypassPermissions
   --setting-sources project --output-format stream-json --verbose`), full
   tooling incl. web, no skills mounted, workspace outside the repo tree.
   Token-cost parser updated with opus-5 published rates.
2. **Two fork profiles**: Base (M1, M2) and Ethereum mainnet (M3, L1–L4). Each
   pinned at a recent archive block at build time; both pins + every locked
   address recorded in ADDRESSES.md with cast-verification per row, prior-probe
   style.
3. **Time-warp support**: several instances need `evm_increaseTime`/`evm_mine`
   in setup (epoch positioning for M2, maturity scenarios for M3, interest
   accrual for L2). The prior harness never warped; small addition to the
   instance-setup context. Warping happens in *setup*, never mid-trial, so
   determinism holds.
4. **Ambiguity audit field**: `meta.ambiguity` per instance (see §5), carried
   into `result.json` so the analyzer can slice pass rates by ambiguity class.

Funding: same patterns (masterMinter mint for USDC, `anvil_setBalance` for
ETH, whale impersonation with storage-slot fallback for AERO/gOHM/USDe —
logged per asset in ADDRESSES.md).

## 4. Task matrix — 7 families × 2 instances × 3 trials = 42 scored cells

Tasks are phrased as a user would phrase them; traps never named. Instances
marked ⚠ have detail that can only be locked after reading the protocol's
docs/contracts at build time (L3, L4 are precisely the protocols nobody has
tutorials for — that applies to us too). All instances are locked verbatim in
PREREGISTRATION.md before any scored run, after QA both ways.

| # | Instance | Sketch | Trap under test |
|---|---|---|---|
| M1a | Slipstream mint + stake | "Put 2 WETH plus the matching USDC into the WETH/USDC concentrated pool on Aerodrome, in a range about ±10% around the current price, and set it up to earn AERO." | Pool selection among multiple WETH/USDC CL pools (tickSpacings); mint mechanics; must stake NFT in gauge to earn AERO (unstaked = fees only). |
| M1b | Slipstream rebalance | Setup: in-the-money position now fully out of range. "My LP position stopped earning; move it to a ±5% range around the current price." | Unstake→decrease→collect→re-mint sequencing; tokens-owed must actually be collected; funds-intact across the round trip. |
| M2a | veAERO lock + vote | "Lock 1,000 AERO for a year and use the position to vote all my weight for the WETH/USDC pool." | Duration rounding to weekly epochs; Voter takes pool addresses; which WETH/USDC pool (vAMM vs CL gauges); voting-window timing. |
| M2b | veAERO manage + re-vote | Setup: existing lock voted last epoch for pool A. "Add 500 AERO to my lock and switch my vote to [pool B]." | increaseAmount vs new lock; once-per-epoch vote constraint; reset/re-vote path. |
| M3a | Pendle buy PT | "Use 10,000 USDe to lock in a fixed rate on Ethena yield until [the maturity nearest ~90 days]; hold nothing else." | SY accepts USDe vs sUSDe; ApproxParams; maturity selection (phrase resolves uniquely); slippage floor. |
| M3b | Pendle early exit | Setup: wallet holds PT mid-maturity. "Rates moved; get me out of this fixed-rate position back into USDe, losing as little as possible." | Pre-expiry exit = swap (not redeem); PT+YT merge trap; router version; slippage. |
| L1a | Aave V4 supply+borrow | "Supply 5,000 USDC into Aave's new v4 market and borrow about 1 WETH against it, keeping things comfortably safe (HF ≥ 1.5)." | Hub/spoke discovery; spoke selection if several list USDC; V3 Pool live alongside as decoy; new position/account surface. |
| L1b | Aave V3→V4 migration | Setup: 5,000 USDC supplied in V3. "Move my Aave position over to the new version." | Withdraw-then-supply across architectures; leaves no V3 dust; no stranded approvals. |
| L2a | Cooler V2 borrow | Setup: wallet holds gOHM. "Borrow 5,000 USDS against my gOHM on Olympus." | MonoCooler addCollateral (delegation array param); min-debt floor; collateral sizing vs origination LTV. |
| L2b | Cooler V2 repay+withdraw | Setup: existing position with accrued interest (time-warped). "Pay my Olympus loan down to 2,000 USDS and pull out as much gOHM as is safe." | Interest-first repayment accounting; min-debt floor interaction; max-withdraw computation. |
| L3a ⚠ | Twyne levered deposit | "Use Twyne to run my WETH at higher leverage than Euler lets me — supply 5 WETH and borrow [asset] near the max Twyne allows." | Novel primitive: collateral-vault creation, credit reservation, Twyne-vs-Euler liquidation thresholds. |
| L3b ⚠ | Twyne unwind | Setup: live boosted position. "Wind my Twyne position down completely and get my WETH back." | Repay ordering across the delegation layer; releasing reserved credit; no stranded dust in intermediate vaults. |
| L4a ⚠ | Fira fixed-rate lend | "Lend 10,000 USDC on Fira at a fixed rate for the shortest term available." | Zero-coverage discovery: docs→contracts→term/market selection→position. |
| L4b ⚠ | Fira maturity/exit | Setup: position near or at maturity (time-warped as mechanics allow). "My Fira term is up; collect what I'm owed." | Post-maturity claim path; principal+interest accounting; no stranded balances. |

Calibration (non-scored, one per tier, before the scored matrix): a Slipstream
single-sided mint (mid-tier) and a Cooler V2 small borrow (long-tail),
exercising both fork profiles, the time-warp path, and the opus-5 cost parser.

## 5. Ambiguity audit (mandated by the T6 finding)

Every instance gets `meta.ambiguity` documented **before scoring**:
`unique` (task description resolves to exactly one venue/market/position
on-chain) or `ambiguous` (multiple plausible matches exist; the "right" answer
requires a canonicality judgment — TVL, listing status, curator usage).
Discovered-later ambiguity gets flagged in RESULTS.md, never silently absorbed.

Deliberately ambiguous (≥2 required; both are direct heirs of the prior
probe's sole failure):

- **M1a** — Base has multiple WETH/USDC Slipstream pools at different
  tickSpacings (plus the vAMM pool); "the WETH/USDC concentrated pool" has
  several parameter-matched candidates differing hugely in liquidity. To be
  enumerated on-chain at build time and recorded in PREREGISTRATION.md.
- **L1a** — if V4's deployed hub/spoke set offers USDC in more than one spoke
  (e.g. Core vs Prime-style configurations), spoke choice is a genuine
  canonicality call. If on-chain enumeration at build shows only one USDC
  spoke, the designation moves to **M2a** (vAMM vs multiple CL WETH/USDC
  gauges), which is verified ambiguous by the same enumeration. At least two
  scored instances will carry `ambiguous` designation, locked before scoring.

Likely-unique (to be verified, not assumed): M3a (nearest-90-day maturity),
L2a/L2b (MonoCooler is a singleton), M1b/M2b/M3b/L1b/L3b/L4b (setup pins the
position), L3a/L4a (subject to build-time enumeration of markets/terms).

## 6. Verifier design

Same discipline as the prior probe: `verify()` is deterministic chain reads
against the fork post-state, no LLM anywhere in scoring; reference solver must
pass all checks, null-op must fail core checks, both gated in QA-LOG.md before
preregistration. Shared check vocabulary carried over: position deltas,
funds-intact/value accounting (portfolio valued at pinned-block prices),
no-stranded-balances, approval hygiene, spend-policy adherence. Severity
taxonomy unchanged: clean-fail / incomplete / value-loss / unsafe-state /
sloppy-success, with the same mechanical check→severity mapping.

Per-family correctness checks (the protocol-specific part):

- **M1**: position NFT exists; `tickLower ≤ spotTick ≤ tickUpper` with the
  band width within tolerance of the asked ±%; position staked in the correct
  gauge (M1a); old position fully exited with tokens-owed collected (M1b);
  deposited value within tolerance of instructed amounts; **canonical-pool
  check** (the pool holding the position is the designated canonical one —
  scored as its own named check so the ambiguity slice is readable).
- **M2**: veNFT lock amount and unlock time (week-rounded) match; `Voter`
  vote-weight recorded 100% on the designated pool for the current epoch;
  (M2b) lock increased not duplicated, prior vote replaced.
- **M3**: PT balance of the designated maturity within slippage tolerance of
  reference; no residual USDe/SY/YT dust above tolerance; (M3b) exit proceeds
  ≥ floor vs pinned-block reference quote; correct-maturity check.
- **L1**: V4 supply/debt position read from the deployed hub/spoke accounting
  surface (exact read path locked at build from the live ABI); HF in band;
  **no position opened on the V3 Pool** (negative check — the decoy);
  (L1b) V3 aToken ≈ 0, V4 supply ≈ full amount.
- **L2**: MonoCooler collateral and debt balances at targets (debt exactly
  2,000 ± accrual tolerance for L2b); wallet USDS delta consistent;
  withdrawn-gOHM within tolerance of the computable safe max.
- **L3** ⚠: Twyne position reads (collateral vault balance, reserved credit,
  borrow) at targets; effective LTV above the underlying market's max
  (proving the boost actually happened, not a plain Euler borrow); (L3b) all
  Twyne-layer balances zero, WETH restored net of interest.
- **L4** ⚠: Fira position struct/token for the chosen term at target
  principal; term = shortest available (correctness check); (L4b) wallet
  credited principal+interest, position closed.

⚠ rows firm up during build from docs + verified contracts; locked in
PREREGISTRATION.md, QA'd both ways before any scored run.

## 7. Drafted preregistration content (becomes binding only as PREREGISTRATION.md after approval)

**Coverage-vs-pass-rate hypothesis, stated explicitly:** pass rate declines as
no-tools coverage declines — but weakly, because runtime discovery (web, docs,
on-chain reads) compensates; where it does *not* compensate, failures
concentrate in venue/instance selection and protocol-idiosyncratic state
machines (epochs, terms, floors), not in transaction encoding. Concretely:
full-coverage families ≥85%; partial ≥70%; none-coverage 55–85% with at least
one family ≤70%. The thesis (capability gaps concentrate where pretraining
coverage is thin) is *supported* if none-coverage families land materially
below full-coverage ones (≥15pt spread between tier means); *killed* if the
spread is ≤5pt with everything ≥90%.

**Per-family predictions** (honest, pre-run; informed by the prior probe's
lesson that runtime tooling beat my pessimism everywhere except venue
selection):

| Family | Coverage | Predicted pass | Predicted dominant failure mode |
|---|---|---|---|
| M1 Slipstream CL | full | 78% | M1a wrong-pool selection (the T6 heir); M1b uncollected tokens-owed |
| M2 veAERO | full | 83% | epoch-window timing; wrong-pool gauge on M2a |
| M3 Pendle | full | 83% | ApproxParams/slippage revert loops burning the attempt; wrong maturity |
| L1 Aave V4 | partial (concept) | 67% | negative transfer: V3-shaped calls at V4 surfaces; spoke mis-selection; falling back to the V3 decoy and reporting success |
| L2 Cooler V2 | partial | 78% | min-debt floor and interest-first accounting on L2b |
| L3 Twyne | none (trace) | 56% | discovery stall or wrong-layer interaction (plain Euler borrow instead of boosted) |
| L4 Fira | none | 72% | term mis-selection; docs-discovery gaps despite good public docs |

Predicted overall: ~74%, with the ambiguity-designated instances scoring
~20pt below their family's unambiguous sibling. Predicted top-3 failure modes
overall: (1) venue/instance mis-selection under ambiguity, (2)
wrong-architecture negative transfer (V3 habits at V4, Euler habits at Twyne),
(3) protocol-state-machine violations (epoch windows, min-debt floors,
maturity boundaries). Explicitly predicted *rare*, based on the prior probe:
encoding errors, approval-hygiene violations, spend-cap violations.

**Decision thresholds** restated: ≥90% every family → competence thread dead
at buyer-representative model; ≤70% any family → product territory ranked by
failure rate × severity; 70–90% marginal. Swap/amendment rule: any instance
swap after scoring starts is logged in RESULTS.md; deviations that don't
change design go to QA-LOG.md.

## 8. Budget and sequencing

Cost: prior probe averaged $0.65/trial on sonnet-5; opus-5 at ~3–5× → ~$2.60
mean. 42 scored cells ≈ $110; calibration, reference-solver QA and re-runs
≈ $30–50. Comfortably inside the $150–250 envelope. Wall-clock: ~3.5 min/trial
× 42 with the bounded-concurrency runner → an overnight run.

Sequence after approval: (1) copy harness, apply §3 deltas; (2) build-time
research pass on L3/L4 + on-chain enumeration for the ambiguity audit; lock
addresses + fork pins in ADDRESSES.md; (3) commit PREREGISTRATION.md verbatim
from §7 (never edited after); (4) reference solver + null-op QA on all 14
instances, log in QA-LOG.md; (5) two calibration trials; (6) 42-cell scored
matrix; (7) RESULTS.md with the coverage-vs-pass-rate table/plot, full failure
map from transcripts, prediction scorecard, plain-English verdict, honest
limits. Stop there.

---

**Approve as-is, or correct §1 (selection), §4 (matrix), §5 (ambiguity
designations), §6 (verifiers), or §7 (predictions) before I commit the
pre-registration and start building.** Known open risks flagged for the
approval decision: (a) L3/L4 instance detail is necessarily build-time-firmed
(⚠ rows) — the gate protecting against drift is that PREREGISTRATION.md locks
them before any scored run; (b) Fira's DefiLlama TVL ($15M) vs press-reported
deposits ($450M) needs on-chain reconciliation at build — if real TVL is under
$5M the family swaps to Alchemix V3 (the named backup), logged not silent;
(c) if Aave V4's Ethereum deployment proves too new for stable archive
forking or its spoke set is thinner than reported, L1 falls back to
supply/borrow-only without the migration instance, logged in QA-LOG.md.
