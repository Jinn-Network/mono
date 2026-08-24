## 1. What Aave V4 is

Aave V4 is the fourth-generation architecture for the Aave lending protocol, announced by Aave Labs in May 2024 as an "Aave 2030" proposal (ARFC/tech paper, Stani Kulechov). Its central change is splitting the monolithic V3 `Pool` into a **unified Liquidity Layer (the "hub")** that holds all supplied capital and manages interest-rate and liquidity accounting, and **Spokes** — modular, permissionlessly-addable borrowing markets that draw liquidity from the hub under a per-spoke risk configuration and pay a **liquidity premium** scaled to their risk. Other headline design elements: fuzzy-logic-controlled interest rates that adjust the rate curve automatically rather than via governance votes, native GHO minting as a first-class spoke, "smart accounts"/vaults so one address can hold multiple isolated positions, dynamic risk parameters, automatic bad-debt handling (excess debt is cut off from the liquidity layer rather than silently socialised), and a redesigned liquidation engine. The pitch is that new markets — RWAs, long-tail assets, isolated experiments — can be added without fragmenting liquidity or requiring a full governance cycle per asset.

## 2. Is it live, and where?

**I don't know.** My knowledge is reliable to roughly **early-to-mid 2025**, at which point V4 was in development with a target of "mid-2025" that had already slipped at least once, with audits planned/underway, and **not deployed to any mainnet**. V3 (and V3.x point releases) was the live production version on Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Base, BNB, Gnosis, Scroll, Metis, ZKsync and others.

You are telling me the date is 3 August 2026. That is more than a year past anything I can vouch for. V4 may well have shipped in that window, on Ethereum mainnet first (that was the stated plan), possibly with a testnet phase before it. I cannot confirm it, cannot date it, and cannot name the chains. Anything I said here with confidence would be fabricated.

## 3. Core smart contracts

Design-level names from the tech paper, not deployment artefacts:

- **Liquidity Hub / Liquidity Layer** — holds all supplied assets, tracks supply and borrow accounting, meters liquidity out to spokes.
- **Spoke** — a borrowing market with its own collateral set, LTVs, liquidation thresholds and e-mode-style configuration; borrows from the hub and pays the liquidity premium.
- **Interest rate controller** — the fuzzy-logic rate mechanism that shifts the curve based on utilisation dynamics.
- **GHO spoke / native GHO minting facility** — mints GHO directly against hub collateral rather than through a separate facilitator design.
- **Liquidation engine** — reworked, with the soft/partial liquidation and bad-debt-isolation logic.
- **Smart account / vault** — per-user contract enabling multiple isolated positions under one EOA.

**I do not know the actual Solidity contract names, interfaces, or any deployed addresses.** I have never seen the V4 codebase. If a "Liquidity Hub" contract exists on mainnet today I could not tell you what it is called or where it lives, and I will not invent an address.

## 4. Supplying 5,000 USDC and borrowing WETH

**I cannot give you the V4 call sequence.** I don't know V4's function signatures, which contract is the user-facing entry point (hub or spoke), or whether a smart account must be created first. Guessing here would produce plausible-looking, wrong code — the worst failure mode for this question.

What I can give you is the **V3** sequence, which is well-established and which V4 presumably resembles in shape but not in detail:

1. `USDC.approve(POOL_ADDRESS, 5_000e6)` — USDC is 6 decimals.
2. `Pool.supply(asset = USDC, amount = 5_000e6, onBehalfOf = msg.sender, referralCode = 0)` — mints aUSDC 1:1 to the supplier.
3. `Pool.setUserUseReserveAsCollateral(USDC, true)` — usually unnecessary; the first supply of an asset is enabled as collateral by default if the reserve permits it.
4. `Pool.borrow(asset = WETH, amount = <wei>, interestRateMode = 2 (variable), referralCode = 0, onBehalfOf = msg.sender)` — sends WETH; health factor must stay above 1, and the borrowable amount is bounded by USDC's LTV, not its liquidation threshold.

Known-or-likely V4 deltas, stated as expectations rather than facts: the stable-rate mode was being removed, so `interestRateMode` probably disappears; the entry point is likely a spoke rather than a single global `Pool`; and there may be a position/vault identifier parameter because of smart accounts. **Do not treat that paragraph as an interface spec.**

## 5. Confidence

| Answer | Confidence | Basis |
|---|---|---|
| 1 — what V4 is | **Medium-high** for the architectural concept as *proposed*; **low** that the shipped product matches the 2024 paper. Designs drift over two years. |
| 2 — live status / chains | **Low.** Effectively no knowledge. My cutoff predates any plausible launch. |
| 3 — core contracts | **Medium** on design vocabulary; **zero** on real contract names, interfaces, or addresses. |
| 4 — the call walkthrough | **High** for the V3 sequence given; **zero** for V4. I did not answer the question you asked. |

What I explicitly do not know:

- Whether Aave V4 has launched, when, or on which chains.
- Any V4 contract address on any network.
- V4 function names, signatures, parameter ordering, or ABI.
- Whether the hub/spoke split survived to production, or was cut/renamed.
- Whether V3 markets migrated, run in parallel, or were deprecated.
- Current V4 risk parameters, LTVs, liquidity premiums, or supported assets.
- Any audit outcomes, incidents, or post-launch changes.

If you need the mechanical walkthrough in point 4 for real, it has to come from the current Aave docs or the deployed ABI — not from me.
