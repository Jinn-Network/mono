Answering from memory only. My reliable knowledge of Olympus runs to roughly **early 2025**; I have no dependable information after that, and today is stated as August 2026. Treat everything below as potentially 18 months stale.

## 1. What Cooler Loans V2 is

Cooler V2 (codename **MonoCooler**) is Olympus DAO's lending facility that lets gOHM holders borrow the protocol's own treasury stablecoin against their gOHM at a low, governance-set interest rate. It replaces the V1 design — which issued each loan as a separate escrow contract with a fixed 121-day term that had to be manually rolled — with a **single perpetual position per address**: one collateral balance, one debt balance, no maturity, no rollover. Borrowing capacity is set by an **origination LTV** expressed in debt-token per gOHM, which ratchets upward over time in line with Olympus's growing backing per gOHM, and a slightly higher **liquidation LTV** above it. Interest accrues continuously on the position. The distinguishing feature versus a generic money market is that the lender is the Olympus treasury itself, the rate is set by governance rather than by a utilisation curve, and collateralised gOHM can still be **delegated for governance voting** while it sits in the facility — each borrower gets per-delegate escrow contracts so voting power isn't lost when you borrow against your stake.

## 2. Live status and chains

I believe it went live on **Ethereum mainnet** in the first half of 2025, denominated in **USDS** (post-Sky rebrand; V1 had migrated DAI → USDS via a third Clearinghouse). Mainnet only — the treasury and the whole Bophades policy stack are mainnet-resident; bridged gOHM on Arbitrum/Base/etc. is not usable as Cooler collateral as far as I know. I cannot confirm it is still live today, whether governance has since changed the rate, LTV schedule or debt asset, or whether a V3 exists.

## 3. Core contracts

Names and roles I recall; **I do not know any of the mainnet addresses and will not guess them.**

- **MonoCooler** — the user-facing entry point. Holds collateral accounting and debt accounting, enforces LTV, exposes borrow/repay/add/withdraw/liquidate.
- **CoolerTreasuryBorrower** — the policy that actually sources USDS from the Olympus treasury module (TRSRY) and returns repayments to it. Keeps MonoCooler decoupled from the treasury's internals and from the specific debt asset.
- **CoolerLtvOracle** — supplies origination LTV and liquidation LTV, both time-varying on a governance-set schedule (origination LTV increases at a fixed rate per second; liquidation LTV sits above it as a buffer).
- **DLGTE (delegation module) + delegate escrow factory** — deploys per-(account, delegate) escrow contracts that hold gOHM and delegate its voting power, so collateral remains vote-active. Capped number of delegates per account.
- **CoolerV2Migrator** — one-shot helper that flash-loans to close V1 Cooler loans and reopen the position in V2.
- Supporting: **gOHM** (collateral, ERC-20 with delegation), **USDS** (debt asset), plus the standard Bophades kernel/modules (TRSRY, ROLES) behind the treasury borrower.

Lower confidence on the exact contract names for the treasury borrower and the delegation module; higher on `MonoCooler` and `CoolerLtvOracle`.

## 4. Mechanical borrow flow (mainnet)

Types below are from memory — collateral and debt amounts are `uint128` in the interface I recall.

1. **`gOHM.approve(monoCooler, collateralAmount)`** — standard ERC-20 approval.
2. **`MonoCooler.addCollateral(uint128 collateralAmount, address onBehalfOf, IDLGTE.DelegationRequest[] delegationRequests)`**
   - `onBehalfOf` — whose position is credited (usually `msg.sender`).
   - `delegationRequests` — optional array of (delegate, amount) instructions; each spins up or reuses a delegate escrow so the collateral keeps voting. Pass an empty array to skip.
   - Pulls gOHM from `msg.sender`.
3. **`MonoCooler.borrow(uint128 borrowAmount, address onBehalfOf, address recipient)`**
   - Accrues interest, computes the position's LTV against the oracle's current **origination** LTV, reverts if the new debt would exceed it.
   - Enforces a **minimum debt** floor (a dust guard — I recall something on the order of 1,000 USDS, not certain).
   - `type(uint128).max` borrows the maximum currently available.
   - Calls through `CoolerTreasuryBorrower` to draw USDS from the treasury and sends it to `recipient`.

There is no single combined "deposit and borrow" function on MonoCooler that I'm aware of; the front end batches steps 2 and 3, and third parties can act for a user via `setAuthorization(address, uint96 deadline)` or its EIP-712 signed variant.

Closing out, for completeness:
- **`USDS.approve(monoCooler, amount)`** → **`repay(uint128 repayAmount, address onBehalfOf)`** (`max` repays in full; partial repayment must leave you above the min-debt floor or repay everything).
- **`withdrawCollateral(uint128 amount, address onBehalfOf, address recipient, DelegationRequest[] delegationRequests)`** — you must un-delegate enough collateral out of the escrows first, which is what the `delegationRequests` argument (or a separate `applyDelegations`) is for. Reverts if the withdrawal pushes LTV above origination LTV.
- **`batchLiquidate(address[] accounts, ...)`** — permissionless; positions above the liquidation LTV are seized. My recollection is that liquidation takes the **whole** position rather than partially unwinding it, with the gOHM returned to the treasury.

## 5. Confidence and explicit unknowns

| Answer | Confidence |
|---|---|
| 1. What it is / mechanism | **Medium-high** on the design (perpetual single position, oracle-driven ratcheting LTV, treasury as lender, delegation-preserving collateral). |
| 2. Live status and chain | **Low-medium.** Mainnet-only I'm fairly confident about; the launch date and whether it's still live in this form, I am not. |
| 3. Contract names | **Medium** for MonoCooler, CoolerLtvOracle, the migrator; **low** for the exact naming of the treasury borrower and delegation module. **Zero** on addresses. |
| 4. Call sequence | **Medium** on the order and the function names; **low** on exact parameter types, ordering within signatures, and the min-debt value. |

What I specifically do **not** know:

- Any deployed address for any Cooler V2 contract. I have no reliable recall and refuse to produce a plausible-looking one.
- The current interest rate, current origination/liquidation LTV values, or the rate at which origination LTV increases. V1 was 0.5% fixed; I'd expect V2 to be in that neighbourhood and governance-adjustable, but that's inference, not recall.
- The exact launch date, the governing OIP/proposal number, and the auditors.
- Whether liquidation is full-seizure or partial — I lean full-seizure but I'm not sure.
- Anything that happened after roughly early 2025: parameter changes, a debt-asset switch, migration to a successor, deprecation, or incidents.

If any of this needs to be relied on, verify the addresses and live parameters against the Olympus docs and Etherscan before acting.
