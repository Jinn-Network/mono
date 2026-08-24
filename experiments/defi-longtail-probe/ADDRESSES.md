# Locked addresses + fork pins — long-tail protocol probe

Every address verified on-chain 2026-08-03 (method per row). Fork upstreams
verified serving archive state at the pins through anvil:
Base → `https://1rpc.io/base` (drpc 408-rate-limited, publicnode 403-no-archive,
llamarpc HTML error at anvil genesis); Ethereum → `https://ethereum-rpc.publicnode.com`.
Override with `DEFI_PROBE_FORK_URL_BASE` / `DEFI_PROBE_FORK_URL_ETH`.

**Fork pins: Base (8453) block `49482000`; Ethereum (1) block `25673800`** (both 2026-08-03).

## Base — Aerodrome (M1, M2)

| Component | Address | Verified by |
|---|---|---|
| WETH | `0x4200000000000000000000000000000000000006` | prior probe + `symbol()` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | prior probe + `symbol()` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | `VotingEscrow.token()` round-trip; `symbol()` = AERO |
| Router (v2 AMM) | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | prior probe; `factoryRegistry()` live |
| FactoryRegistry | `0x5C3F18F06CC09CA1910767A34a20F771039E37C0` | `Router.factoryRegistry()` |
| PoolFactory (v2 AMM) | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` | registry `poolFactories()[0]`; `voter()` → Voter |
| Voter | `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5` | `PoolFactory.voter()`; `gauges()`/`weights()` live |
| VotingEscrow (veAERO) | `0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4` | `Voter.ve()` |
| CLFactory (Slipstream, gen-1) | `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A` | registry `poolFactories()[1]`; `tickSpacings()` = [1,50,100,200,2000,10] |
| CLFactory (gen-2) | `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a` | registry `poolFactories()[2]`; `tickSpacings()` responds |
| CLFactory (gen-3) | `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` | registry `poolFactories()[3]`; `tickSpacings()` responds |
| NPM (gen-1 pools) | `0x827922686190790b37229fd06084350E74485b72` | `CLPool(0xb2cc…).nft()` |
| NPM (gen-3 pools) | `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53` | `CLPool(0x3FE0…).nft()` |

### WETH/USDC venue enumeration (M1a/M2a ambiguity ground truth, balances at ~tip 2026-08-03)

Twelve venues match "the WETH/USDC pool on Aerodrome":

| Venue | Address | Pooled value | Gauge | Vote weight |
|---|---|---|---|---|
| **CL100 gen-1** | `0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59` | 3,686 WETH + 2.63M USDC (~$16M) | `0xF33a…e0c8` alive | 49.8M veAERO |
| **CL50 gen-3** | `0x3FE04A59Ebd38cF06080a6F60a98D124eb59392A` | 1,746 WETH + 3.58M USDC (~$10M) | `0xA0B6…2D28` alive | 105.1M veAERO |
| **vAMM** | `0xcDAC0d6c6C59727a65F871236188350531885C43` | 2,073 WETH + 3.83M USDC (~$11M) | `0x519B…C025` alive | 4.9M veAERO |
| CL1 gen-1 | `0xdbc6…30f1` | ~$130k | alive | — |
| 8 further CL venues (gen-1 ts10/50/200/2000; gen-2 ts50/500; gen-3 ts1/10/50-dust) | see git history of this file | $75–$81k each, mostly dust | various | — |

Canonicality rule (locked for verifiers): **M1a `core:canonical-pool` passes iff
the position sits in a WETH/USDC Slipstream pool with ≥$5M pooled value at the
pin** (i.e. CL100 gen-1 or CL50 gen-3 — both real venues; choosing between them
is legitimate judgment, choosing any of the nine dust venues is the T6-heir
failure). vAMM fails M1a (not concentrated). **M2a vote check passes on any of
the three ≥$5M venues** (vAMM included — voting the volatile pool is a
defensible reading of "the main WETH/USDC pool").

## Ethereum — Pendle (M3)

| Component | Address | Verified by |
|---|---|---|
| USDe | `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3` | `symbol()` = USDe |
| sUSDe | `0x9D39A5DE30e57443BfF2A8307A4256c8797A3497` | holder used in slot discovery |
| Router V4 | `0x888888888889758F76e7103c6CbF23ABbF58F946` | code present (proxy shell) |
| sUSDe market (exp 2026-08-13) | `0x177768CAf9D0E036725a51d3f60D7e20F2D4d194` | Pendle API + `readTokens()` round-trip; $8.23M liquidity |
| → SY | `0xBF98480425A29197e5d99D003017f63a1e595D02` | `readTokens()[0]` |
| → PT | `0x5A19fa369F2895dCD8d2cEE62E4Ceae58eF92BBb` | `readTokens()[1]` |
| → YT | `0x45A699A11A4a17fe0931EF3ceA4BFc3235e659F2` | `readTokens()[2]` |
| USDe market (exp 2026-08-13) | `0x43C97094DA0E894d3AF2fda6F507d59a29888251` | Pendle API; $393k liquidity (thin sibling — recorded for the ambiguity audit) |

Only one live sUSDe maturity exists (2026-08-13), so "PT-sUSDe" resolves
uniquely; the proposal's "~90-day maturity" phrasing is void (no such market)
— logged as a design refinement in QA-LOG.md, not an instance swap.

## Ethereum — Aave V4 (L1) — researched via docs + bgd-labs/aave-address-book + live reads (three concordant sources)

| Component | Address |
|---|---|
| Core Hub | `0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9` |
| Prime Hub | `0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931` |
| Plus Hub | `0x06002e9c4412CB7814a791eA3666D905871E536A` |
| Global Dollar (Paxos) Hub | `0x62d63197660c080236193CA60b70E49A08E90368` |
| Main Spoke | `0x94e7A5dCbE816e498b89aB752661904E2F56c485` |
| Bluechip Spoke | `0x973a023A77420ba610f06b3858aD991Df6d85A08` |
| NativeTokenGateway | `0xe68ab4F90Fe026B9873F5F276eD2d7efBbbE42Be` |
| USDC (mainnet) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| WETH (mainnet) | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Aave V3 Pool (live decoy) | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` |
| aEthUSDC (V3) | `0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c` |

Mechanics locked from ISpoke.sol + live calls: users call the **Spoke**
(`supply/borrow/withdraw/repay(uint256 reserveId, uint256 amount, address onBehalfOf)`),
approve the Spoke as spender, tokens land on the **Hub**; `reserveId` is
spoke-local (resolve via `getReserve()`); reads via `getUserAccountData` /
`getUserSuppliedAssets` / `getUserDebt` per spoke; HF is per-spoke.

**USDC ambiguity ground truth (L1a):** USDC is listed in **6 user-facing spokes
across 8 distinct reserves** (Main id7-Core; Bluechip id4-Prime AND id7-Core;
Ethena Ecosystem id4-Plus AND id7-Core; Forex id1-Core; Gold id1-Core;
USDG-Pendle id1-Paxos). WETH in 5 spokes (Main id0-Core, Bluechip id0-Prime,
3 eSpokes). L1a `ambiguous` designation confirmed. Canonicality rule (locked):
`core:canonical-spoke` passes iff USDC supplied + WETH borrowed on **Main or
Bluechip** spoke (the two general-purpose venues with both assets; the
special-purpose spokes — Forex, Gold, Ethena, USDG-Pendle, eSpokes — are wrong
venues for a plain supply-and-borrow and fail).

## Ethereum — Cooler V2 (L2) — docs + olympus-v3 env.json + live wiring round-trips

| Component | Address |
|---|---|
| MonoCooler | `0xdb591Ea2e5Db886dA872654D58f6cc584b68e7cC` |
| CoolerTreasuryBorrower | `0xD58d7406E9CE34c90cf849Fc3eed3764EB3779B0` |
| CoolerLtvOracle | `0x9ee9f0c2e91E4f6B195B988a9e6e19efcf91e8dc` |
| DLGTE (OlympusGovDelegation) | `0xD3204Ae00d6599Ba6e182c6D640A79d76CdAad74` |
| gOHM | `0x0ab87046fBb341D058F17CBC4c1133F25a20a52f` |
| USDS | `0xdC035D45d973E3EC169d2276DDab16f1e407384F` |

Live params at research time: rate 0.5% APY (`interestRateWad`=4.9875415e15),
origination LTV ~3,061.86 USDS/gOHM (drips up ~0.1/day — verifiers read
`loanToValues()` live, never hard-code), liquidation LTV = origination × 1.01,
`minDebtRequired()` = exactly 1,000e18 USDS. Live since May 2025 (OCG Prop 8).

## Ethereum — Twyne (L3) — docs + Immunefi scope + twyne-contracts-v1 source + live reads

| Component | Address |
|---|---|
| CollateralVaultFactory (proxy) | `0xa1517cCe0bE75700A8838EA1cEE0dc383cd3A332` |
| VaultManager (proxy) | `0x0acd3A3c8Ab6a5F7b5A594C88DFa28999dA858aC` |
| Twyne EVC | `0xef39D6493884C4C84D38a4bFF879Ce16CEdE702a` |
| HealthStatViewer | `0xe3632980F6D1a405211eAA698c125E4f3753337e` |
| eeWETH-2-1 intermediate vault | `0x87b8081A3ace680f35125F469526Ac10f5418Ca7` |
| Euler Prime eWETH (credit asset) | `0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2` |
| Euler eUSDC (target vault) | `0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9` |

L3 uses the **pure-Euler WETH→USDC pair** (eeWETH intermediate, maxTwyneLTV
94%, buffer 1.00). The intermediate vault holds only ~0.64 eWETH free under a
7-eWETH supply cap, so instance setup pre-funds the credit-LP side
permissionlessly (WETH → Euler eWETH `deposit` → intermediate-vault
`deposit`), sized inside the cap; positions sized small accordingly. Write
path: `factory.createCollateralVault(EULER_V2, eeWETH-iv, eUSDC, liqLTV, _)` →
`depositUnderlying(WETH)` → `borrow(usdc, receiver)`; credit reservation is
automatic (`_handleExcessCredit`). Reads: `factory.getCollateralVaults(user)`,
vault `maxRepay()/maxRelease()/totalAssetsDepositedOrReserved()`,
`HealthStatViewer.health(vault)`. Hazard: Euler Chainlink adapters enforce
`maxStaleness` — no long time-warps on L3.

## Ethereum — Fira (L4) — docs.fira.money contracts page + app API + live reads

**Design refinement (pre-preregistration, logged in QA-LOG.md):** all of Fira's
fixed-rate USDC series are expired at the pin (last maturity 2026-06-18; no new
series created since 2026-04-22, verified by factory-log scan). Pinning a
historical block would let the agent's *live* web access contradict fork state
(app + docs correctly say "all expired"), poisoning failure attribution. L4
therefore pivots to Fira's **live variable-rate lending market** — same
zero-coverage protocol, same discoverable docs (`docs.fira.money/llms.txt`),
and a sharper trap: Fira's lending market is Morpho-Blue-shaped but takes a
**7-field MarketParams `{loanToken, collateralToken, oracle, irm, ltv, lltv,
whitelist}`** where Morpho Blue has 5 — verified by live
`idToMarketParams(bytes32)` decode. Protocol TVL $15.7M (DefiLlama) still
clears the ≥$5M floor; the press-reported $450M is the looped USD0/bUSD0 UZR
market (445.7M supplied / 430.4M borrowed on a separate whitelisted contract —
reconciliation recorded, discrepancy resolved).

| Component | Address | Verified by |
|---|---|---|
| VariableLendingMarket | `0xc8Db629192a96D6840e88a8451F17655880A2e4D` | docs contracts page; live `idToMarketParams`/`market`/`position` calls |
| USDC/wstETH market id | `0xb3152ac00687cc9502b78ab452956f85cc89ac210deefda5dbff09f7f167b544` | app API + on-chain decode: loan=USDC, coll=wstETH, ltv=0.87, lltv=0.89, whitelist=0x0; ~125.8k USDC supplied, ~101.8k borrowed, ~24k liquidity |
| → oracle | `0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2` | from market params |
| → irm | `0x73C288826347af3718e6F09c2A24AaFDA77684cD` | from market params |
| FiraRouterV4 | `0xFF615E63aAF2d1B1EE4AdFD34a5840747185d8A0` | docs; code present (router NOT needed for the plain lend path) |
| wstETH | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | canonical |

Read path (verified live): `position(bytes32 id, address) → (supplyShares, borrowShares, collateral)`,
`market(bytes32) → (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee)` —
Morpho-shaped. Other live USDC variable markets (cbBTC/UNI/LINK collateral)
exist; L4a names the wstETH market so venue choice is `unique`. Excluded: the
whitelisted UZR USD0 market.

## Funding strategies (locked)

- ETH: `anvil_setBalance`.
- USDC (Base): storage slot 9 write (prior probe's proven path).
- USDC (Ethereum): FiatTokenV2 slot 9 — verify once in QA before locking.
- WETH (both): `deposit()` wrap from setup.
- AERO: balances slot **0** (verified vs VotingEscrow holding).
- USDe: balances slot **2** (verified vs sUSDe-contract holding).
- gOHM: balances slot **0** (verified vs holder 0x8655…A88e).
