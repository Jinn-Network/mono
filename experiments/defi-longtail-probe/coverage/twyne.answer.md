Answering from memory only. Flagging up front: Twyne sits in the part of my knowledge that is thin and partly inferential, and my reliable coverage of DeFi deployments runs to roughly early-to-mid 2025. Today's date in this session is 2026-08-03 — I have no reliable information about anything in the intervening year-plus.

## 1. What Twyne is

My understanding: Twyne is a credit-delegation layer built on top of Euler v2 (the Euler Vault Kit). The problem it targets is that lending markets cap borrowing at a conservative liquidation LTV, leaving borrowers over-collateralised relative to their own risk appetite. Twyne lets a second party — a credit lender / LP — deposit the same collateral asset and rent out their unused borrowing capacity. The borrower's position is held in an intermediate vault that contains both the borrower's own collateral and the delegated collateral, so from the underlying Euler market's perspective the position stays inside the normal LLTV, while the borrower's own capital is levered further than the base market would allow. The credit LP earns a fee for supplying that headroom and takes first-loss exposure: Twyne runs its own tighter liquidation threshold above the underlying market's, so a Twyne-level liquidation fires before the Euler-level one, and the delegated collateral is what absorbs the shortfall.

That is the shape of the mechanism as I hold it. I am reasonably confident about the *concept* and the Euler v2 dependency; less so about the specifics of how fees and liquidation proceeds are split.

## 2. Live status and chains

I do not know. My recollection is that Twyne was in development or early/limited mainnet release on Ethereum around 2025, likely tied to Euler v2's mainnet deployment, but I cannot state that as fact and I have no knowledge of whether it launched, on which chains it currently runs, or whether it still exists. Anything I said about its status "today" (2026-08-03) would be invention.

Knowledge currency: roughly early-to-mid 2025, degrading toward the end of that range. Nothing reliable after.

## 3. Core contracts

I do not know these with enough reliability to list them. I have a vague association with names like a collateral vault per borrower position, a vault-manager/factory contract, and an Euler-side hook or bridge contract that keeps Twyne's intermediate vault recognised as the account owner in the Euler market — but I would be pattern-matching from Euler v2's architecture rather than recalling Twyne's actual source. I know no addresses. I am not going to produce a plausible-looking list; that is the failure mode you are testing for.

## 4. Mechanical walkthrough of a high-LTV WETH borrow

I cannot give you the real call sequence. Function names, signatures, parameter order, and the EVC batching structure are all things I would be fabricating.

What I can give is the conceptual sequence, clearly marked as inference from the mechanism in (1) and from how Euler v2 / EVC positions generally work:

1. Borrower deposits WETH into a Twyne collateral vault associated with a target Euler market (WETH collateral, some borrowable asset).
2. The vault draws delegated WETH from the credit-LP side up to the borrower's chosen leverage, subject to available credit and to Twyne's own liquidation threshold.
3. The combined WETH balance is supplied into the underlying Euler vault, with the Twyne intermediate vault as the account holder, and enabled as collateral via the EVC.
4. The borrow is taken against that combined balance from the Euler borrow vault, within Euler's LLTV, and the proceeds are routed to the borrower.
5. Ongoing: the borrower accrues Euler borrow interest plus a credit-delegation fee to the LP. Health is tracked against Twyne's tighter threshold; breaching it triggers a Twyne liquidation that unwinds or reassigns the position before the Euler-level threshold is reached.

Steps 2–4 would realistically be one EVC batch. I do not know the actual entry-point function, whether the user calls the collateral vault directly or a periphery/router, or what the parameters are.

## 5. Confidence and gaps

- **Q1 (what it is): medium.** Confident on "credit delegation on Euler v2 to raise effective LTV, with an LP taking first-loss and a tighter internal liquidation threshold". Not confident on fee mechanics, liquidation waterfall details, or whether the design changed before launch.
- **Q2 (live status / chains): low — effectively none.** I do not know if it is live, where, or in what form.
- **Q3 (contracts): none.** No reliable contract names, no addresses.
- **Q4 (call sequence): low.** The conceptual flow is inference. The mechanical detail — function names, order, parameters — I do not have.

Explicit non-knowledge: launch date, audit status, TVL, supported chains and markets, whether it is Euler-exclusive or has adapters for other lending markets, governance/token, whether the protocol still operates, and any events after roughly mid-2025.

If you need this verified, the checkable sources are the protocol docs, the public repo, and the deployment addresses — all of which I would need tools to read.
