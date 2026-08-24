// Protocol surface for the seven families. Addresses mirror ADDRESSES.md
// (locked, cast-verified); ABIs are minimal slices needed by setup/verify/
// reference code. QA (reference all-pass + null-op core-fail) gates every
// signature here before anything is scored.
import { parseAbi, type Address } from 'viem';
import { E } from '../harness/src/lib/defi.js';

// ---------- Base: Aerodrome (M1, M2) ----------
export const AERO_ADDR = {
  aero: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as Address,
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5' as Address,
  votingEscrow: '0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4' as Address,
  v2Factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as Address,
  clFactoryGen1: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A' as Address,
  clFactoryGen3: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef' as Address,
  npmGen1: '0x827922686190790b37229fd06084350E74485b72' as Address,
  npmGen3: '0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53' as Address,
  poolCl100Gen1: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59' as Address,
  poolCl50Gen3: '0x3FE04A59Ebd38cF06080a6F60a98D124eb59392A' as Address,
  poolVamm: '0xcDAC0d6c6C59727a65F871236188350531885C43' as Address,
  /** All WETH/USDC venues below the $5M canonicality bar (ADDRESSES.md enumeration). */
  dustPools: [
    '0xdbc6998296caA1652A810dc8D3BaF4A8294330f1', '0xb150768CF55d1625E2337a08FBd1b0f02ff94bdB',
    '0xAaD23a67F2AC693ABBe543489aeB3F24F561D517', '0x148BC43946a902258916e580B0e6D92Aaa74746F',
    '0x0652202C4b2D09CB93aEDeFAdc14B36869483a98', '0xc758d81B9b81A6FCDAd075bD471874A2c46B54e0',
    '0x56AeaF4af2DF4bdFD9D865830Fefdd278b25E7Ef', '0x4e392fBfE4D0557C82D2F97F02ec39daA31516dd',
    '0x493E74Eda2720e127BAcCC1A19B2D567Bc14aB43',
  ] as Address[],
};

export const CL_NPM_ABI = parseAbi([
  'struct MintParams { address token0; address token1; int24 tickSpacing; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; uint160 sqrtPriceX96; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'function decreaseLiquidity(DecreaseLiquidityParams params) returns (uint256 amount0, uint256 amount1)',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function collect(CollectParams params) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
]);
export const CL_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function gauge() view returns (address)',
  'function nft() view returns (address)',
]);
export const CL_GAUGE_ABI = parseAbi([
  'function deposit(uint256 tokenId)',
  'function withdraw(uint256 tokenId)',
  'function stakedContains(address depositor, uint256 tokenId) view returns (bool)',
  'function stakedValues(address depositor) view returns (uint256[] staked)',
]);
export const VOTING_ESCROW_ABI = parseAbi([
  'function createLock(uint256 value, uint256 lockDuration) returns (uint256)',
  'function increaseAmount(uint256 tokenId, uint256 value)',
  'function locked(uint256 tokenId) view returns (int128 amount, uint256 end, bool isPermanent)',
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)',
  'function balanceOfNFT(uint256 tokenId) view returns (uint256)',
]);
export const VOTER_ABI = parseAbi([
  'function vote(uint256 tokenId, address[] poolVote, uint256[] weights)',
  'function reset(uint256 tokenId)',
  'function votes(uint256 tokenId, address pool) view returns (uint256)',
  'function usedWeights(uint256 tokenId) view returns (uint256)',
  'function gauges(address pool) view returns (address)',
]);
export const V2_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
]);
export const CL_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)',
]);

// ---------- Ethereum: Pendle (M3) ----------
export const PENDLE = {
  routerV4: '0x888888888889758F76e7103c6CbF23ABbF58F946' as Address,
  usde: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' as Address,
  susde: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497' as Address,
  marketSusdeAug13: '0x177768caf9D0e036725A51D3f60d7E20F2D4D194' as Address,
  syAug13: '0xBF98480425A29197e5d99D003017f63a1e595D02' as Address,
  ptAug13: '0x5A19fa369F2895dCD8d2cEE62E4Ceae58eF92BBb' as Address,
  ytAug13: '0x45A699A11A4a17fe0931EF3ceA4BFc3235e659F2' as Address,
  marketUsdeAug13: '0x43c97094Da0E894D3aF2fDA6f507D59a29888251' as Address,
};
// Pendle V3 interface structs (IPAllActionTypeV3), used by Router V4.
export const PENDLE_ROUTER_ABI = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'struct TokenOutput { address tokenOut; uint256 minTokenOut; address tokenRedeemSy; address pendleSwap; SwapData swapData; }',
  'struct ApproxParams { uint256 guessMin; uint256 guessMax; uint256 guessOffchain; uint256 maxIteration; uint256 eps; }',
  'struct Order { uint256 salt; uint256 expiry; uint256 nonce; uint8 orderType; address token; address YT; address maker; address receiver; uint256 makingAmount; uint256 lnImpliedRate; uint256 failSafeRate; bytes permit; }',
  'struct FillOrderParams { Order order; bytes signature; uint256 makingAmount; }',
  'struct LimitOrderData { address limitRouter; uint256 epsSkipMarket; FillOrderParams[] normalFills; FillOrderParams[] flashFills; bytes optData; }',
  'function swapExactTokenForPt(address receiver, address market, uint256 minPtOut, ApproxParams guessPtOut, TokenInput input, LimitOrderData limit) payable returns (uint256 netPtOut, uint256 netSyFee, uint256 netSyInterm)',
  'function swapExactPtForToken(address receiver, address market, uint256 exactPtIn, TokenOutput output, LimitOrderData limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)',
]);
export const EMPTY_LIMIT = {
  limitRouter: '0x0000000000000000000000000000000000000000' as Address,
  epsSkipMarket: 0n, normalFills: [], flashFills: [], optData: '0x' as `0x${string}`,
};
export const DEFAULT_APPROX = { guessMin: 0n, guessMax: 2n ** 256n - 1n, guessOffchain: 0n, maxIteration: 256n, eps: 100000000000000n };

// ---------- Ethereum: Aave V4 (L1) ----------
export const AAVE_V4 = {
  mainSpoke: '0x94e7A5dCbE816e498b89aB752661904E2F56c485' as Address,
  bluechipSpoke: '0x973a023A77420ba610f06b3858aD991Df6d85A08' as Address,
  coreHub: '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9' as Address,
  /** Special-purpose spokes carrying USDC — wrong venues for a plain supply+borrow (L1a canonicality). */
  wrongSpokes: [
    '0x58131E79531caB1d52301228d1f7b842F26B9649', // Ethena Correlated
    '0xba1B3D55D249692b669A164024A838309B7508AF', // Ethena Ecosystem
    '0xD8B93635b8C6d0fF98CbE90b5988E3F2d1Cd9da1', // Forex
    '0x65407b940966954b23dfA3caA5C0702bB42984DC', // Gold
    '0x956d8e0A89cfa3744428C4641b5a53B56167a7f9', // USDG Pendle
  ] as Address[],
  // Spoke-local reserve ids (research: Main USDC=7 WETH=0; Bluechip USDC(Core)=7 USDC(Prime)=4 WETH=0). QA-verified.
  mainUsdcId: 7n, mainWethId: 0n,
  bluechipUsdcCoreId: 7n, bluechipUsdcPrimeId: 4n, bluechipWethId: 0n,
  v3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as Address,
  aEthUsdc: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c' as Address,
};
export const SPOKE_ABI = parseAbi([
  'function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)',
  'function getReserveCount() view returns (uint256)',
  'function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)',
  'function getUserDebt(uint256 reserveId, address user) view returns (uint256, uint256)',
  'struct UserAccountData { uint256 riskPremium; uint256 avgCollateralFactor; uint256 healthFactor; uint256 totalCollateralValue; uint256 totalDebtValueRay; uint256 activeCollateralCount; uint256 borrowCount; }',
  'function getUserAccountData(address user) view returns (UserAccountData data)',
]);
export const AAVE_V3_POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function getUserAccountData(address user) view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
]);

// ---------- Ethereum: Cooler V2 (L2) ----------
export const COOLER = {
  monoCooler: '0xdb591Ea2e5Db886dA872654D58f6cc584b68e7cC' as Address,
  gohm: '0x0ab87046fBb341D058F17CBC4c1133F25a20a52f' as Address,
  usds: '0xdC035D45d973E3EC169d2276DDab16f1e407384F' as Address,
};
export const MONOCOOLER_ABI = parseAbi([
  'struct DelegationRequest { address delegate; int256 amount; }',
  'function addCollateral(uint128 collateralAmount, address onBehalfOf, DelegationRequest[] delegationRequests)',
  'function borrow(uint128 borrowAmountInWad, address onBehalfOf, address recipient) returns (uint128)',
  'function repay(uint128 repayAmountInWad, address onBehalfOf) returns (uint128)',
  'function withdrawCollateral(uint128 collateralAmount, address onBehalfOf, address recipient, DelegationRequest[] delegationRequests) returns (uint128)',
  'struct AccountPosition { uint256 collateral; uint256 currentDebt; uint256 maxOriginationDebtAmount; uint256 liquidationDebtAmount; uint256 healthFactor; uint256 currentLtv; uint256 totalDelegated; uint256 numDelegateAddresses; uint256 maxDelegateAddresses; }',
  'function accountPosition(address account) view returns (AccountPosition position)',
  'function loanToValues() view returns (uint96 maxOriginationLtv, uint96 liquidationLtv)',
  'function minDebtRequired() view returns (uint256)',
]);

// ---------- Ethereum: Twyne (L3) ----------
export const TWYNE = {
  factory: '0xa1517cCe0bE75700A8838EA1cEE0dc383cd3A332' as Address,
  viewer: '0xe3632980F6D1a405211eAA698c125E4f3753337e' as Address,
  eeWethIntermediate: '0x87b8081A3ace680f35125F469526Ac10f5418Ca7' as Address,
  eulerEWeth: '0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2' as Address,
  eulerEUsdc: '0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9' as Address,
};
export const TWYNE_FACTORY_ABI = parseAbi([
  'function createCollateralVault(uint8 vaultType, address intermediateVault, address targetVault, uint256 liqLTV, address targetAsset) returns (address)',
  'function getCollateralVaults(address borrower) view returns (address[])',
  'function isCollateralVault(address vault) view returns (bool)',
]);
export const TWYNE_VAULT_ABI = parseAbi([
  'function depositUnderlying(uint256 underlying)',
  'function borrow(uint256 targetAmount, address receiver)',
  'function repay(uint256 amount)',
  'function redeemUnderlying(uint256 assets, address receiver)',
  'function withdraw(uint256 assets, address receiver)',
  'function maxRepay() view returns (uint256)',
  'function maxRelease() view returns (uint256)',
  'function totalAssetsDepositedOrReserved() view returns (uint256)',
  'function twyneLiqLTV() view returns (uint256)',
  'function borrower() view returns (address)',
]);
export const TWYNE_VIEWER_ABI = parseAbi([
  'function health(address collateralVault) view returns (uint256 extHF, uint256 inHF, uint256 externalBorrowDebtValue, uint256 internalBorrowDebtValue)',
]);
export const EVAULT_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function asset() view returns (address)',
  'function debtOf(address account) view returns (uint256)',
  'function LTVLiquidation(address collateral) view returns (uint16)',
]);

// ---------- Ethereum: Fira (L4) ----------
export const FIRA = {
  variableMarket: '0xc8Db629192a96D6840e88a8451F17655880A2e4D' as Address,
  usdcWstethId: '0xb3152ac00687cc9502b78ab452956f85cc89ac210deefda5dbff09f7f167b544' as `0x${string}`,
  wsteth: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0' as Address,
  oracle: '0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2' as Address,
  irm: '0x73C288826347af3718e6F09c2A24AaFDA77684cD' as Address,
};
export const FIRA_MARKET_PARAMS = {
  loanToken: E.usdc,
  collateralToken: FIRA.wsteth,
  oracle: FIRA.oracle,
  irm: FIRA.irm,
  ltv: 870000000000000000n,
  lltv: 890000000000000000n,
  whitelist: '0x0000000000000000000000000000000000000000' as Address,
};
export const FIRA_LENDING_ABI = parseAbi([
  'struct FiraMarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 ltv; uint256 lltv; address whitelist; }',
  'function supply(FiraMarketParams marketParams, uint256 assets, uint256 shares, address onBehalfOf, bytes data) returns (uint256, uint256)',
  'function withdraw(FiraMarketParams marketParams, uint256 assets, uint256 shares, address onBehalfOf, address receiver) returns (uint256, uint256)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
