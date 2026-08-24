Answering from memory only. Flagging drift up front: my knowledge is reliably current to roughly **mid-2025**. You've told me today is 3 August 2026, so there's about a year I cannot see — protocol upgrades, address migrations, market listings, or deprecations in that window are invisible to me.

## 1. What Aave v3 on Base is

Aave v3 is an overcollateralised lending market — a pooled, algorithmic money market where suppliers deposit ERC-20 assets into shared reserves and receive interest-bearing receipt tokens (aTokens), and borrowers draw against collateral they have supplied, subject to per-asset loan-to-value and liquidation thresholds. Interest rates are set algorithmically from utilisation against a kinked rate curve. Positions that fall below a health factor of 1 are liquidatable by anyone, who repays debt in exchange for discounted collateral. "Aave v3 on Base" is an instance of that same codebase deployed to Base (Coinbase's OP-Stack L2), governed by Aave DAO on Ethereum mainnet and controlled cross-chain through a governance bridge/executor, with its own reserve set, caps, and rate parameters. It is a separate liquidity pool from Aave on Ethereum — no shared liquidity.

## 2. Live? Chains? Currency of knowledge

Live on Base since roughly **August 2023**, shortly after Base mainnet opened. Still live as of my knowledge cut-off. I cannot confirm its status on 3 August 2026 — verify on-chain.

Aave v3 was deployed across a wide chain set: Ethereum, Polygon PoS, Avalanche, Optimism, Arbitrum, Base, Metis, Gnosis, BNB Chain, Scroll, zkSync Era, Linea, Sonic, and others added over time. I do not have a reliable complete list for 2026.

Version drift matters: Aave shipped v3.1, v3.2 (stable-rate borrowing removed, "liquid e-modes"), and v3.3 (deficit accounting, position-manager surface) through 2024–2025, and v4 was in design. Which exact revision Base runs today, I don't know.

## 3. Core contracts

Roles I'm confident about:

- **Pool** (behind a transparent-style proxy) — main user entry point: `supply`, `withdraw`, `borrow`, `repay`, `liquidationCall`, `flashLoan`, `setUserUseReserveAsCollateral`, `setUserEMode`. Logic lives in linked libraries (`SupplyLogic`, `BorrowLogic`, `LiquidationLogic`, `FlashLoanLogic`, `ValidationLogic`, `ReserveLogic`).
- **PoolAddressesProvider** — per-market registry; the canonical root address you resolve everything else from.
- **PoolConfigurator** — admin surface: list reserves, set LTV/liquidation threshold/caps/reserve factor, freeze/pause.
- **ACLManager** — role registry (pool admin, risk admin, emergency admin).
- **AToken** — per-reserve supply receipt, balance scaled by the reserve's `liquidityIndex`.
- **VariableDebtToken** — non-transferable debt receipt. (**StableDebtToken** existed in early v3 and was removed in v3.2.)
- **AaveOracle** — Chainlink-backed price source, quotes in USD (8 decimals) for v3.
- **Interest-rate strategy** — `DefaultReserveInterestRateStrategy` per reserve in early v3; consolidated to a single `DefaultReserveInterestRateStrategyV2` in v3.2.
- **L2Pool + L2Encoder** — on OP-Stack/Arbitrum deployments, a calldata-compressed variant of the Pool taking packed `bytes32` args, to cut L1 data cost. I believe Base has these; medium confidence.
- **WrappedTokenGatewayV3** — native ETH wrap/unwrap around WETH supply/borrow.
- **AaveProtocolDataProvider**, **UiPoolDataProviderV3**, **WalletBalanceProvider** — read-only helpers.
- **RewardsController** + **EmissionManager** — incentives.
- **Collector** — treasury for reserve-factor accrual.
- **Cross-chain governance executor** — receives Aave DAO payloads from mainnet.

**Addresses.** I do not trust my recall here and will not present guesses as fact. Two strings surface with weak association for Base — Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` and PoolAddressesProvider `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` — but treat them as **unverified**; check the `aave-address-book` package or resolve from the addresses provider on-chain. I'm reasonably confident native USDC on Base is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and bridged USDbC is `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`, but verify those too.

## 4. Supplying 5,000 USDC — mechanically

USDC has 6 decimals, so the amount is `5000000000` (5e9).

**Two transactions, or one with permit.**

*Path A — approve then supply:*

1. `USDC.approve(spender = Pool, amount = 5000000000)`. Spender is the **Pool proxy**, not the aToken. (The aToken is where the underlying actually lands, but `transferFrom` is initiated by the Pool.)
2. `Pool.supply(asset = USDC, amount = 5000000000, onBehalfOf = <your address>, referralCode = 0)`.

*Path B — one transaction:* native USDC implements EIP-2612, so `Pool.supplyWithPermit(asset, amount, onBehalfOf, referralCode, deadline, permitV, permitR, permitS)` folds the approval in via an off-chain signature. Bridged USDbC may not support permit — check before assuming.

*L2 variant:* if Base runs L2Pool, the front end likely calls `L2Pool.supply(bytes32 args)` where `args` packs a 16-bit reserve id, a 128-bit amount, and a 16-bit referral code, encoded via `L2Encoder.encodeSupplyParams`. Functionally identical. The uncompressed `Pool.supply` signature remains callable regardless — use it if you want to be safe.

**What happens inside `supply`:**

1. `SupplyLogic.executeSupply` loads the reserve.
2. `reserve.updateState()` — accrues `liquidityIndex` and `variableBorrowIndex` from the last update timestamp, mints the accrued reserve-factor share to the Collector.
3. `ValidationLogic.validateSupply` — reverts if the reserve is inactive, frozen, or paused, if amount is zero, or if the **supply cap** would be breached (error code `51`). 5,000 USDC is unlikely to breach a cap, but caps do bind on smaller reserves.
4. `reserve.updateInterestRates()` — recomputes supply/borrow rates at the new, lower utilisation.
5. `IERC20(USDC).safeTransferFrom(msg.sender, aTokenAddress, 5000000000)` — the underlying sits in the aToken contract, not the Pool.
6. `IAToken.mint(caller, onBehalfOf, amount, liquidityIndex)` — mints a **scaled** balance of `amount / liquidityIndex`. Your visible aToken balance is `scaledBalance × currentLiquidityIndex`, so it grows without further transactions. Returns `isFirstSupply`.
7. If it's your first supply of that reserve and the reserve has non-zero LTV and you're not blocked by isolation-mode rules, the user config bit is set to use it as collateral and `ReserveUsedAsCollateralEnabled` is emitted. You can flip this later with `Pool.setUserUseReserveAsCollateral(USDC, false)`.
8. Emits `Supply(reserve, msg.sender, onBehalfOf, amount, referralCode)` plus aToken `Transfer`/`Mint`.

**Result:** you hold ~5,000 aBasUSDC (exact ticker uncertain), earning the variable supply rate, redeemable 1:1 for underlying via `Pool.withdraw(USDC, amount | type(uint256).max, to)` subject to available liquidity and, if you've borrowed, your health factor staying above 1.

`Pool.deposit()` was retained in v3 as a deprecated alias for `supply()` — I'm not certain it survived later revisions. Use `supply`.

## 5. Confidence and explicit unknowns

| Answer | Confidence |
|---|---|
| 1 — what it is | **High** |
| 2 — live, chain, cut-off | **Medium-high** on the 2023 launch and it being live at my cut-off; **low** on its status today |
| 3 — contract names/roles | **High** on names and roles; **low** on which exact revision Base runs; **very low** on addresses |
| 4 — supply mechanics | **High** on the call sequence and internal logic; **medium** on the L2Pool/L2Encoder detail for Base specifically |

What I do **not** know:

- Any concrete Base address with the confidence needed to act on it. The two I offered are recall-with-doubt, not knowledge.
- The exact aToken ticker for USDC on Base.
- Whether Base runs v3.1, v3.2, v3.3, or something later; whether stable-rate remnants are present; whether v4 has shipped anywhere.
- Current reserve set on Base — I believe WETH, cbETH, wstETH, USDbC, native USDC, and likely more; I can't enumerate it reliably, and can't confirm whether GHO is live on Base.
- Current supply caps, LTVs, liquidation thresholds, reserve factors, e-mode categories, or rates. All parameters are governance-mutable and I have no live values.
- Whether anything material happened between mid-2025 and today: migrations, deprecations, incidents, an Aave v4 deployment on Base.
- Whether the Aave DAO's Base instance still uses the same cross-chain governance path.

If any of this is going into a probe that will be scored against ground truth, the addresses and parameters need fetching from `@bgd-labs/aave-address-book` or read directly from the PoolAddressesProvider — not from me.
