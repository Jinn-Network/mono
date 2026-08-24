Answering from memory only. No lookups. Where I'm unsure I say so.

## 1. What Pendle is

Pendle is a yield-tokenisation protocol. You deposit a yield-bearing asset (stETH, sUSDe, GLP, aUSDC, an LRT, etc.), it is wrapped into a standardised yield token **SY** (ERC-5115), and SY is then split into two tokens with a fixed maturity date: **PT** (principal token), redeemable 1:1 for the underlying accounting unit at maturity, and **YT** (yield token), which accrues all the yield the underlying generates between now and maturity and is worth nothing after. Because PT trades at a discount to par, buying PT is a fixed-rate trade (buy at 0.94, redeem at 1.00 → a locked-in APY); buying YT is a leveraged long on the yield rate. Pendle also runs its own AMM, purpose-built for PT/SY pairs, whose invariant knows about time-to-maturity so PT price converges towards par as expiry approaches and impermanent loss is bounded. Governance is vePENDLE (vote-escrowed, gauge-weighted emissions to LP pools, plus a share of protocol fees).

## 2. Live? Chains? Knowledge cutoff

Pendle has been live since 2021 (V2, the version described here, since late 2022/early 2023). Chains I am confident about: **Ethereum mainnet, Arbitrum, BNB Chain, Optimism, Base, Mantle**. I have weaker recollection of later deployments (Sonic, Berachain, an HyperEVM deployment) — treat those as unverified.

**My knowledge is reliable to roughly early-to-mid 2025.** You have told me today is 3 August 2026. That is more than a year of gap, and Pendle is a fast-moving protocol with expiring markets. I cannot tell you what is live *today*, which markets exist, or whether a V3 router/AMM has since shipped. Everything below should be checked against the current deployment before you touch a wallet.

## 3. Core contracts

Names and roles I'm confident about:

| Contract | Role |
|---|---|
| `PendleSY*` / `SY` (ERC-5115) | Wraps the yield-bearing asset. `deposit` / `redeem`, `exchangeRate`, reward accounting. One per asset. |
| `PendlePrincipalToken` (PT) | ERC-20 principal claim. Redeems for SY at maturity. |
| `PendleYieldToken` (YT) | ERC-20 yield claim. Holds the interest/reward accounting (`redeemDueInterestAndRewards`), and is the contract that actually executes `redeemPY`. |
| `PendleYieldContractFactory` | `createYieldContract(SY, expiry, ...)` — deploys a PT/YT pair for one SY at one maturity. |
| `PendleMarketV3` | The AMM pool itself, PT ↔ SY. Also *is* the LP ERC-20. `swapExactPtForSy`, `swapSyForExactPt`, `mint`, `burn`. |
| `PendleMarketFactoryV3` | Deploys markets; holds `scalarRoot`, `initialAnchor`, `lnFeeRateRoot`. |
| `PendleRouter` (V3/V4) | Diamond-pattern entry point users actually call. Facets: `ActionAddRemoveLiq`, `ActionSwapPT`, `ActionSwapYT`, `ActionMintRedeem`, `ActionMisc`. |
| `PendleLimitRouter` | Off-chain-signed limit orders, filled inside router swaps. |
| `PendlePYLpOracle` | TWAP oracle for PT/YT/LP pricing; must be `increaseObservationsCardinalityNext`-primed before use. |
| `PENDLE` token, `vePENDLE`, `PendleVotingControllerUpg`, `PendleGaugeController`, `PendleFeeDistributor` | Tokenomics/governance. |

Addresses — I only half-remember these and you should **not** use them without verifying:

- PENDLE token (Ethereum): `0x808507121B80c02388fAd14726482e061B8da827` — reasonably confident.
- Router V3 (Ethereum): `0x00000000005BBB0EF59571E58418F9a4357b68A0` — I recall the vanity leading zeros, medium confidence.
- Router V4 (Ethereum): `0x888888888889758F76e7103c6CbF23ABbF58F946` — I recall the vanity 8s, medium confidence.

I do **not** know any market, SY, PT or YT addresses for USDe/sUSDe, and I would be guessing if I produced one. Those are per-maturity and rotate.

## 4. Mechanical walkthrough: 10,000 USDe → PT, hold, redeem

Assume an Ethereum-mainnet market on SY-sUSDe with some maturity, and that the SY accepts USDe as a mint token (Ethena's SY typically accepts both USDe and sUSDe).

**Step 0 — approve.**
`USDe.approve(router, 10_000e18)`.

**Step 1 — buy PT in one router call.**

```solidity
router.swapExactTokenForPt(
    receiver,        // you
    market,          // the PendleMarketV3 for that maturity
    minPtOut,        // slippage floor, e.g. 99.5% of quoted
    guessPtOut,      // ApproxParams
    input,           // TokenInput
    limit            // LimitOrderData, empty struct if unused
) returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm);
```

- `TokenInput = { tokenIn: USDe, netTokenIn: 10_000e18, tokenMintSy: USDe, pendleSwap: address(0), swapData: empty }`. If the SY does not accept USDe directly you set `tokenMintSy: sUSDe` and supply an aggregator route in `pendleSwap`/`swapData` (KyberSwap, historically) so the router converts USDe→sUSDe first.
- `ApproxParams = { guessMin, guessMax, guessOffchain, maxIteration, eps }`. This exists because the AMM primitive is `swapSyForExactPt` — the pool can only take an *exact PT out*. So the router binary-searches on-chain for the PT amount that consumes exactly your SY. `guessOffchain` is the SDK's quote used as the search seed; `eps` is typically `1e14` (0.01%). Getting these wrong is the usual cause of a revert.

What happens internally, in order:
1. Router pulls 10,000 USDe from you.
2. Router calls `SY.deposit(router, USDe, 10_000e18, minSharesOut)` → receives SY.
3. Router calls `market.swapSyForExactPt(receiver, ptOut, data)`; the market's callback pulls the required SY from the router. Fee accrues in SY (`lnFeeRateRoot`, decaying with time to maturity); part goes to the treasury.
4. You end up holding `netPtOut` PT. Because PT trades below par, `netPtOut > 10,000` — the excess is your fixed yield.

**Step 2 — hold.** Nothing to do. PT does not accrue anything; its value accretes purely by price convergence to par. You are not entitled to the underlying's yield — the YT holder is. You can exit early at any time via `swapExactPtForToken`, at the prevailing market rate.

**Step 3 — redeem after maturity.**

`PT.approve(router, netPtOut)`, then:

```solidity
router.redeemPyToToken(
    receiver,
    YT,              // the YT address identifies the PT/YT pair
    netPyIn,         // your PT balance
    output           // TokenOutput
) returns (uint256 netTokenOut, uint256 netSyInterm);
```

- `TokenOutput = { tokenOut: USDe, minTokenOut, tokenRedeemSy: sUSDe (or USDe), pendleSwap, swapData }`.
- Internally: router transfers PT into the YT contract and calls `YT.redeemPY(receiver)`. Post-expiry only PT is required — YT is not needed and is worthless. `redeemPY` mints SY to the router at the maturity-frozen `pyIndex`, then `SY.redeem(receiver, amountShares, tokenOut, minTokenOut, false)` unwraps to sUSDe/USDe, with an aggregator hop if `tokenOut != tokenRedeemSy`.

**Before maturity** the same call requires *equal amounts of PT and YT* — that's the merge path. After maturity, PT alone.

Router-free path, if you want no router dependency: `SY.deposit` → `market.swapSyForExactPt` yourself (you must compute the exact PT out and handle the callback), and at maturity transfer PT to the YT contract and call `YT.redeemPY(receiver)` then `SY.redeem`. Nobody does this by hand; the approximation is the reason the router exists.

## 5. Confidence and known gaps

| Answer | Confidence | Notes |
|---|---|---|
| 1. What Pendle is | **High** | Core SY/PT/YT design and the maturity-aware AMM are stable and I'm confident in the description. |
| 2. Live + chains | **Medium** | High that it was live and multi-chain as of my cutoff; I cannot confirm current status, and the later chain deployments are low confidence. Cutoff ≈ early-to-mid 2025, i.e. over a year stale relative to today's date. |
| 3. Contracts | **High on names/roles, low on addresses** | The three addresses I gave are recalled vanity strings; verify all three. I have no market/SY/PT/YT addresses. |
| 4. Mechanics | **Medium-high** | Function names, ordering, and the ApproxParams/TokenInput/TokenOutput struct fields I'm fairly confident about for Router V3/V4. Exact field ordering and any V4 signature changes should be checked against the ABI. |

What I explicitly do **not** know:

- Any current live Pendle market on Ethereum, its address, or its maturity date. Everything in §4 is a template, not a live trade.
- Whether USDe/sUSDe markets still exist, and whether the SY for them accepts USDe directly or requires an sUSDe hop.
- The current router version and address, and whether the diamond facets have been re-cut.
- Current fee parameters, `scalarRoot`/`initialAnchor` for any specific market, or current PT implied APYs.
- Post-cutoff protocol changes: Boros (the perp-funding-rate product I have vague recall of being announced), any V3 AMM, any changes to vePENDLE.
- Whether any of the addresses I listed have been deprecated or, worse, reused.

If you need this operationally rather than conceptually, the addresses and market list have to come from Pendle's live deployment JSON or their SDK — not from me.
