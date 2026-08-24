Answering from memory only. No lookups, so treat every address below as unverified.

## 1. What Slipstream is

Slipstream is Aerodrome's concentrated-liquidity AMM on Base — effectively a Uniswap v3 fork (core + periphery) welded onto Aerodrome's ve(3,3) incentive machinery. Liquidity providers pick a price range, receive an ERC-721 position NFT, and earn swap fees only while price trades inside that range. The Aerodrome-specific modification is that each CL pool has a gauge: you can stake the position NFT into the pool's gauge, at which point you stop receiving swap fees (those redirect to veAERO voters) and instead accrue AERO emissions proportional to your in-range staked liquidity. Emissions to each pool are set weekly by veAERO gauge voting, same epoch machinery as Aerodrome's v2 volatile/stable pools. Second structural difference from Uniswap v3: pools are keyed by `(token0, token1, tickSpacing)` rather than `(token0, token1, fee)`, and the swap fee is a mutable per-pool parameter set by a fee module, decoupled from tick spacing. There is also an "unstaked fee" — an extra cut taken from positions that are *not* staked in the gauge, which pushes LPs toward staking.

## 2. Live? Chains? Knowledge date?

Live on **Base** (Aerodrome is Base-only). The same codebase runs as **Velodrome Slipstream on Optimism**, and Velodrome's later "Superchain" expansion put deployments on further OP-stack chains — I don't trust my memory of that list.

Launch was H1 2024 (I believe around April–May 2024 for both Velodrome and Aerodrome; I'd not defend the exact date).

My knowledge is reliable to roughly **early 2025**. Today's date in this session is August 2026. I have no information about the last ~18 months, so I cannot actually confirm it is live *today*, only that it was live and was Base's dominant CL venue as of my cutoff. Nothing I know suggests a shutdown.

## 3. Core contracts

Roles I'm reasonably confident about:

- **CLFactory** — deploys/registers pools by `(tokenA, tokenB, tickSpacing)`; holds the enabled tick-spacing set, the pool implementation, and the fee-module pointers. Pools are deployed as minimal-proxy clones of a pool implementation rather than raw bytecode CREATE2 (this is a Slipstream deviation from Uniswap v3).
- **CLPool** — the AMM core. Fork of `UniswapV3Pool` plus staked-liquidity accounting: it tracks `stakedLiquidity` and a `rewardGrowthGlobalX128` alongside the usual fee growth accumulators, so emissions can be settled per-tick like fees.
- **NonfungiblePositionManager (NPM)** — ERC-721 wrapper over positions; `mint`, `increaseLiquidity`, `decreaseLiquidity`, `collect`, `burn`. Interface matches Uniswap v3 except `fee` → `tickSpacing` in `MintParams`, plus a `sqrtPriceX96` field for lazy pool init.
- **CLGauge** / **CLGaugeFactory** — one gauge per pool; accepts staked position NFTs, streams AERO, and routes that pool's swap fees to voters while staked.
- **Voter, VotingEscrow (veAERO), Minter, RewardsDistributor** — shared with Aerodrome v2, not Slipstream-specific. `Voter.gauges(pool)` is how you find a pool's gauge.
- **SwapRouter**, **QuoterV2**, **MixedRouteQuoterV1** (routes across v2-style and CL pools), **TickLens**, **NonfungibleTokenPositionDescriptor**.
- **CustomSwapFeeModule** and **CustomUnstakedFeeModule** — set per-pool swap fee and unstaked fee under governance control.
- **Sugar / SugarHelper** — Aerodrome's read-only data contracts; SugarHelper carries tick↔price math helpers used by their frontend.

Addresses — low confidence, verify before use:
- AERO token: `0x940181a94A35A4569E4529A3CDfB74e38FD98631` (medium)
- WETH (Base): `0x4200000000000000000000000000000000000006` (high)
- USDC (Base): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (high)
- Aerodrome Voter: `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5` (low–medium)
- Slipstream NPM: `0x827922686190790b37229fd06084350E74485b72` (low)

I do **not** reliably know the CLFactory, CLGaugeFactory, SwapRouter, or QuoterV2 addresses. I won't guess them.

## 4. Providing WETH/USDC in a chosen range — mechanically

Token ordering first: WETH `0x42…` < USDC `0x83…`, so **token0 = WETH (18 dp), token1 = USDC (6 dp)**. Price in pool terms is token1-per-token0, i.e. raw USDC units per raw WETH unit, so the human price needs a `10^(6-18)` decimal adjustment.

1. **Resolve the pool.** `CLFactory.getPool(WETH, USDC, tickSpacing)`. For a volatile blue-chip pair the conventional spacing is **100**; Slipstream's enabled set is roughly {1, 50, 100, 200, 2000}, 1 being for correlated/stable pairs. If it returns the zero address the pool doesn't exist yet.
2. **Read current price.** `CLPool.slot0()` → `sqrtPriceX96`, `tick`.
3. **Pick ticks.** Convert your target price bounds to ticks via `tick = log_1.0001(priceRaw)`, then round each to a multiple of `tickSpacing` (100). `tickLower < tickUpper`, both within ±887272 bounds. If both ticks sit above the current tick you deposit only token1 (USDC); both below, only token0 (WETH); straddling, both — and the split is fixed by the range geometry, not chosen by you.
4. **Approve.** `WETH.approve(NPM, amount0)` and `USDC.approve(NPM, amount1)`.
5. **Init the pool if needed.** `NPM.createAndInitializePoolIfNecessary(token0, token1, tickSpacing, sqrtPriceX96)` — or skip it and let `mint` handle init via its `sqrtPriceX96` param.
6. **Mint.** `NPM.mint(MintParams{ token0: WETH, token1: USDC, tickSpacing: 100, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline, sqrtPriceX96 })`. Returns `(tokenId, liquidity, amount0, amount1)`. Internally NPM calls `CLPool.mint(...)`, which calls back into NPM's mint callback to pull the two ERC-20s. `amount0Min`/`amount1Min` are your slippage guard against the price moving between quote and execution — do not set them to zero. To supply native ETH instead of WETH, send value and wrap through the NPM's `multicall([mint, refundETH])` pattern.
7. **Stake for AERO (optional but the point of Slipstream).** `gauge = Voter.gauges(pool)`; `NPM.approve(gauge, tokenId)` (or `setApprovalForAll`); `CLGauge.deposit(tokenId)`. From here swap fees on that position go to voters, and you accrue AERO whenever price is inside your range. Claim with `CLGauge.getReward(tokenId)`. Unstake with `CLGauge.withdraw(tokenId)`, which returns the NFT.
8. **If you stay unstaked**, collect fees with `NPM.collect(CollectParams{ tokenId, recipient, amount0Max: type(uint128).max, amount1Max: type(uint128).max })` — net of the unstaked-fee cut.
9. **Exit.** Unstake if staked, `NPM.decreaseLiquidity(tokenId, liquidity, amount0Min, amount1Min, deadline)` (this only credits tokens owed, it doesn't transfer), then `NPM.collect(...)` to actually receive them, then optionally `NPM.burn(tokenId)` once liquidity and owed amounts are zero.

The one thing that trips people coming from Uniswap v3: you cannot both earn swap fees and earn emissions. Staking is an either/or.

## 5. Confidence and known gaps

| Answer | Confidence |
|---|---|
| 1 — what it is | **High** on the mechanism (CL fork, gauge staking, fees-or-emissions trade-off, tickSpacing keying). |
| 2 — live / chains | **Medium.** High that it was live on Base as of early 2025; cannot verify present state; launch date and the Velodrome Superchain chain list are shaky. |
| 3 — contracts | **Medium** on names and roles. **Low** on addresses. |
| 4 — mechanics | **Medium-high** on call order and the `tickSpacing`/`sqrtPriceX96` deviations in `MintParams`. Medium on exact struct field ordering and on function names being byte-identical to Uniswap v3's. |

Explicitly do not know:
- Anything after roughly early 2025 — upgrades, redeployments, a Slipstream v2, fee-module changes, whether the protocol still operates as described.
- Nearly all deployment addresses. The five I gave carry the confidence marks shown; the Base WETH and USDC ones are the only two I'd act on unchecked.
- The exact enabled tick-spacing set and which spacing the canonical WETH/USDC pool actually uses. I said 100 by convention; that is inference, not recall.
- Current swap fee and unstaked fee values for that pool — these are governance-mutable and I have no reading of them.
- The precise mint-callback function name (Slipstream may or may not have renamed `uniswapV3MintCallback`).
- Whether `MintParams` field order matches what I listed, which matters if you're ABI-encoding by hand.

If you need any of this to be operationally correct, pull the Slipstream repo and read `CLFactory`, `CLPool`, and `NonfungiblePositionManager` directly, and resolve addresses from the deployment JSONs rather than from me.
