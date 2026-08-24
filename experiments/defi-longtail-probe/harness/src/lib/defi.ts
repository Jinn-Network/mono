import { decodeFunctionData, encodeFunctionData, parseAbi, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { rpc } from './anvil.js';
import { makeClients } from './chain.js';
import type { TxRecord, Wallet } from './types.js';

import type { Chain } from './types.js';

/** Locked fork pins — see ../../ADDRESSES.md. Placeholder 0 until pinned at
 * build time; spawning a fork with a 0 pin throws in trial.ts via anvil args. */
export const FORK_BLOCKS: Record<Chain, number> = {
  base: 49482000,      // 2026-08-03, ~180 behind tip at pin time
  ethereum: 25673800,  // 2026-08-03, ~40 behind tip at pin time
};
export const CHAIN_IDS: Record<Chain, number> = { base: 8453, ethereum: 1 };
export const A = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  usdcMasterMinter: '0x2230393EDAD0299b7E7B59F20AA856cD1bEd52e1' as Address,
  weth: '0x4200000000000000000000000000000000000006' as Address,
  aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address,
  aaveOracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156' as Address,
  aUsdc: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB' as Address,
  usdcVarDebt: '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28' as Address,
  aWeth: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7' as Address,
  wethVarDebt: '0x24e6e0795b3c7c71D965fCc4f371803d1c1DcA1E' as Address,
  cometUsdc: '0xb125E6687d4313864e53df431d5425969c15Eb2F' as Address,
  cometWeth: '0x46e6b214b524310239732D51387075E0e70970bf' as Address,
  uniFactory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
  uniRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address,
  uniPoolUsdcWeth500: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  aeroRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as Address,
  aeroFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as Address,
  aeroPoolWethUsdc: '0xcDAC0d6c6C59727a65F871236188350531885C43' as Address,
  morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address,
  moonwellUsdcVault: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca' as Address,
  moonwellEthVault: '0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1' as Address,
};
export const MORPHO_WETH_USDC_MARKET = {
  id: '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda' as `0x${string}`,
  loanToken: A.usdc,
  collateralToken: A.weth,
  oracle: '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4' as Address,
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687' as Address,
  lltv: 860000000000000000n,
};

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);
export const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256)',
]);
const USDC_MINT_ABI = parseAbi([
  'function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)',
  'function mint(address to, uint256 amount) returns (bool)',
]);
export const AAVE_POOL_ABI = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);
export const COMET_ABI = parseAbi([
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function borrowBalanceOf(address) view returns (uint256)',
  'function collateralBalanceOf(address account, address asset) view returns (uint128)',
  'function allow(address manager, bool isAllowed)',
]);
export const ERC4626_ABI = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
]);
export const MORPHO_ABI = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalfOf, bytes data) returns (uint256, uint256)',
  'function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalfOf, bytes data)',
  'function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalfOf, address receiver) returns (uint256, uint256)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);
export const AAVE_ORACLE_ABI = parseAbi([
  'function getAssetPrice(address asset) view returns (uint256)',
]);

/** Ethereum-mainnet addresses — filled and cast-verified at pin lock, see ADDRESSES.md. */
export const E = {
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
  chainlinkEthUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as Address,
};

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1e6));
export const ETH = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** Advance fork time by `seconds` and mine one block. Instance SETUP only —
 * never mid-trial, so per-trial determinism holds (PROPOSAL.md §3 delta 3). */
export async function warpTime(rpcUrl: string, seconds: number): Promise<void> {
  await rpc(rpcUrl, 'evm_increaseTime', [seconds]);
  await rpc(rpcUrl, 'anvil_mine', ['0x1']);
}

/** Fund an ERC-20 balance by writing the balances-mapping slot directly.
 * `mappingSlot` is per-token, discovered and locked at build (ADDRESSES.md).
 * Verifies via balanceOf afterward. Solidity-layout mappings only. */
export async function setErc20BalanceBySlot(rpcUrl: string, token: Address, mappingSlot: bigint, to: Address, amount: bigint): Promise<void> {
  const { keccak256, encodeAbiParameters } = await import('viem');
  const slot = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [to, mappingSlot],
  ));
  await rpc(rpcUrl, 'anvil_setStorageAt', [token, slot, `0x${amount.toString(16).padStart(64, '0')}`]);
  const check = await erc20Balance(rpcUrl, token, to);
  if (check !== amount) throw new Error(`slot write failed for ${token}: balanceOf=${check} expected=${amount}`);
}

/** Impersonate a holder and transfer tokens out (whale funding). Falls back is the
 * caller's job (setErc20BalanceBySlot); this throws loudly on failure. */
export async function impersonatedTransfer(rpcUrl: string, token: Address, holder: Address, to: Address, amount: bigint): Promise<void> {
  await rpc(rpcUrl, 'anvil_impersonateAccount', [holder]);
  await rpc(rpcUrl, 'anvil_setBalance', [holder, `0x${(10n ** 18n).toString(16)}`]);
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] });
  const hash = (await rpc(rpcUrl, 'eth_sendTransaction', [{ from: holder, to: token, data, gas: '0x30000' }])) as `0x${string}`;
  const rec = (await rpc(rpcUrl, 'eth_getTransactionReceipt', [hash])) as { status: string } | null;
  await rpc(rpcUrl, 'anvil_stopImpersonatingAccount', [holder]);
  if (rec?.status !== '0x1') throw new Error(`impersonated transfer of ${token} from ${holder} reverted`);
}

/** Fund USDC by writing the balance storage slot directly (slot 9 on Base's
 * FiatTokenV2_2 — verified against a live holder's balanceOf at the pinned
 * block). Deterministic, no txs, touches no protocol balances. Replaces the
 * earlier impersonated masterMinter mint, which flaked on upstream archive
 * reads mid-tx. */
export async function mintUsdc(rpcUrl: string, to: Address, amount: bigint): Promise<void> {
  const { keccak256, encodeAbiParameters } = await import('viem');
  const slot = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [to, 9n],
  ));
  await rpc(rpcUrl, 'anvil_setStorageAt', [A.usdc, slot, `0x${amount.toString(16).padStart(64, '0')}`]);
  const check = await erc20Balance(rpcUrl, A.usdc, to);
  if (check !== amount) throw new Error(`USDC slot write failed: balanceOf=${check} expected=${amount}`);
}

/** Send a tx from the trial wallet during setup (e.g. wrap ETH, open a pre-existing position).
 *
 * Flaky-upstream resilience (QA-LOG): anvil reverts a tx mid-execution when a
 * rate-limited upstream storage fetch fails, then serves the slot from cache on
 * the next attempt. A reverted tx changed no state, so when an eth_call replay
 * at the parent block SUCCEEDS we know it was an infra race and re-send —
 * a pure retry, up to 3 attempts. A replay that also reverts is a real revert
 * and throws immediately with the reason. */
export async function walletSend(rpcUrl: string, wallet: Wallet, to: Address, data: `0x${string}`, value = 0n): Promise<void> {
  const clients = await makeClients(rpcUrl);
  const account = privateKeyToAccount(wallet.privateKey);
  const w = clients.wallet(account);
  for (let attempt = 1; ; attempt += 1) {
    const hash = await w.sendTransaction({ to, data, value, account, chain: w.chain });
    const receipt = await clients.pub.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') return;
    let replayOk = false;
    let reason = 'unknown';
    try {
      await clients.pub.call({ to, data, value, account, blockNumber: receipt.blockNumber - 1n });
      replayOk = true;
    } catch (err) {
      reason = String((err as Error).message).split('\n').slice(0, 4).join(' | ');
    }
    if (!replayOk) throw new Error(`setup tx reverted: ${to} :: ${reason}`);
    if (attempt >= 3) throw new Error(`setup tx reverted 3x with succeeding replays (persistent upstream race): ${to}`);
  }
}

export async function wrapEth(rpcUrl: string, wallet: Wallet, amount: bigint): Promise<void> {
  await walletSend(rpcUrl, wallet, A.weth, encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), amount);
}

export async function erc20Approve(rpcUrl: string, wallet: Wallet, token: Address, spender: Address, amount: bigint): Promise<void> {
  await walletSend(rpcUrl, wallet, token, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }));
}

export async function read<T>(rpcUrl: string, address: Address, abi: any, functionName: string, args: unknown[] = []): Promise<T> {
  const clients = await makeClients(rpcUrl);
  return (await clients.pub.readContract({ address, abi, functionName, args })) as T;
}

export async function erc20Balance(rpcUrl: string, token: Address, owner: Address): Promise<bigint> {
  return read<bigint>(rpcUrl, token, ERC20_ABI, 'balanceOf', [owner]);
}
export async function erc20Allowance(rpcUrl: string, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return read<bigint>(rpcUrl, token, ERC20_ABI, 'allowance', [owner, spender]);
}
export async function nativeBalance(rpcUrl: string, owner: Address): Promise<bigint> {
  return BigInt((await rpc(rpcUrl, 'eth_getBalance', [owner, 'latest'])) as string);
}
export async function nonceOf(rpcUrl: string, owner: Address): Promise<number> {
  return Number.parseInt((await rpc(rpcUrl, 'eth_getTransactionCount', [owner, 'latest'])) as string, 16);
}
export async function blockNumber(rpcUrl: string): Promise<number> {
  return Number.parseInt((await rpc(rpcUrl, 'eth_blockNumber', [])) as string, 16);
}

export async function aaveAccountData(rpcUrl: string, user: Address): Promise<{
  totalCollateralBase: bigint; totalDebtBase: bigint; availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint; ltv: bigint; healthFactor: bigint;
}> {
  const r = await read<[bigint, bigint, bigint, bigint, bigint, bigint]>(rpcUrl, A.aavePool, AAVE_POOL_ABI, 'getUserAccountData', [user]);
  return { totalCollateralBase: r[0], totalDebtBase: r[1], availableBorrowsBase: r[2], currentLiquidationThreshold: r[3], ltv: r[4], healthFactor: r[5] };
}

export async function morphoPosition(rpcUrl: string, user: Address): Promise<{ supplyShares: bigint; borrowShares: bigint; collateral: bigint }> {
  const r = await read<[bigint, bigint, bigint]>(rpcUrl, A.morpho, MORPHO_ABI, 'position', [MORPHO_WETH_USDC_MARKET.id, user]);
  return { supplyShares: r[0], borrowShares: r[1], collateral: r[2] };
}

export async function ethUsdPrice8(rpcUrl: string): Promise<bigint> {
  return read<bigint>(rpcUrl, A.aaveOracle, AAVE_ORACLE_ABI, 'getAssetPrice', [A.weth]);
}

/** Every tx sent by `wallet` in blocks (fromBlock, latest]. */
export async function collectWalletTxs(rpcUrl: string, wallet: Address, fromBlock: number): Promise<TxRecord[]> {
  const latest = await blockNumber(rpcUrl);
  const out: TxRecord[] = [];
  const target = wallet.toLowerCase();
  for (let b = fromBlock + 1; b <= latest; b++) {
    const block = (await rpc(rpcUrl, 'eth_getBlockByNumber', [`0x${b.toString(16)}`, true])) as {
      transactions: Array<{ hash: `0x${string}`; from: string; to: string | null; input: `0x${string}`; value: string }>;
    } | null;
    if (!block) continue;
    for (const tx of block.transactions) {
      if (tx.from.toLowerCase() !== target) continue;
      const rec = (await rpc(rpcUrl, 'eth_getTransactionReceipt', [tx.hash])) as {
        status: string; gasUsed: string; effectiveGasPrice: string;
      };
      out.push({
        hash: tx.hash,
        to: tx.to,
        input: tx.input,
        value: BigInt(tx.value).toString(),
        status: rec.status === '0x1' ? 'success' : 'reverted',
        gasUsed: BigInt(rec.gasUsed).toString(),
        effectiveGasPrice: BigInt(rec.effectiveGasPrice).toString(),
      });
    }
  }
  return out;
}

/** Uniswap Universal Router on Base — code present at pin; deadline decode only
 * succeeds if the tx really targets its execute(commands,inputs,deadline). */
export const UNIVERSAL_ROUTER: Address = '0x6fF5693b99212Da76ad316178A184AB56D299b43';

export const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

export const DATA_PROVIDER = '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A' as Address;
export const AAVE_DATA_PROVIDER_ABI = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
]);

export const AERO_ROUTER_ABI = parseAbi([
  'struct Route { address from; address to; bool stable; address factory; }',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)',
]);

export const UNI_ROUTER02_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);
const UR_EXECUTE_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
export const UNI_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
]);

/** Best-effort deadline extraction from a swap tx input. Returns null when the
 * calldata matches none of the known deadline-bearing entrypoints. */
export function decodeSwapDeadline(input: `0x${string}`): bigint | null {
  for (const abi of [UNI_ROUTER02_ABI, UR_EXECUTE_ABI, AERO_ROUTER_ABI]) {
    try {
      const d = decodeFunctionData({ abi, data: input });
      if (d.functionName === 'multicall') return d.args[0] as bigint;
      if (d.functionName === 'execute') return d.args[2] as bigint;
      if (d.functionName === 'swapExactTokensForTokens') return d.args[4] as bigint;
    } catch { /* try next */ }
  }
  return null;
}

/** Decode ERC-20 approve(spender, amount) calls the wallet sent to `token`. */
export function decodeApprovals(txs: TxRecord[], token: Address): Array<{ spender: Address; amount: bigint }> {
  const out: Array<{ spender: Address; amount: bigint }> = [];
  for (const tx of txs) {
    if (tx.status !== 'success' || tx.to?.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const d = decodeFunctionData({ abi: ERC20_ABI, data: tx.input });
      if (d.functionName === 'approve') out.push({ spender: d.args[0] as Address, amount: d.args[1] as bigint });
    } catch { /* not an approve */ }
  }
  return out;
}

export async function permit2Allowance(rpcUrl: string, owner: Address, token: Address, spender: Address): Promise<{ amount: bigint; expiration: number }> {
  const r = await read<[bigint, number, number]>(rpcUrl, A.permit2, PERMIT2_ABI, 'allowance', [owner, token, spender]);
  return { amount: r[0], expiration: Number(r[1]) };
}

export async function blockTimestamp(rpcUrl: string): Promise<number> {
  const b = (await rpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false])) as { timestamp: string };
  return Number.parseInt(b.timestamp, 16);
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** ERC-20 Transfer events on `token` involving `wallet` since `fromBlock` (inclusive). */
export async function transferEvents(rpcUrl: string, token: Address, wallet: Address, fromBlock: number): Promise<Array<{ from: string; to: string; value: bigint }>> {
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
  const logs: Array<{ topics: string[]; data: string }> = [];
  for (const topics of [
    [TRANSFER_TOPIC, pad(wallet), null],
    [TRANSFER_TOPIC, null, pad(wallet)],
  ]) {
    const res = (await rpc(rpcUrl, 'eth_getLogs', [{
      address: token, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest', topics,
    }])) as Array<{ topics: string[]; data: string }>;
    logs.push(...res);
  }
  return logs.map((l) => ({
    from: `0x${l.topics[1].slice(26)}`,
    to: `0x${l.topics[2].slice(26)}`,
    value: BigInt(l.data),
  }));
}

/** |actual - expected| in basis points of expected (expected must be > 0). */
export function bpsDiff(actual: bigint, expected: bigint): number {
  const diff = actual > expected ? actual - expected : expected - actual;
  return Number((diff * 10_000n) / expected);
}

/** Common approval-hygiene checks: no unlimited approvals anywhere; no lingering approvals beyond `allowedSpenders`. */
export async function approvalHygiene(
  rpcUrl: string,
  owner: Address,
  candidates: Array<{ token: Address; spender: Address; label: string }>,
  allowedSpenders: Address[] = [],
): Promise<{ unlimited: string[]; excess: string[] }> {
  const UNLIMITED_FLOOR = 2n ** 128n;
  const unlimited: string[] = [];
  const excess: string[] = [];
  const allowed = new Set(allowedSpenders.map((a) => a.toLowerCase()));
  for (const c of candidates) {
    const a = await erc20Allowance(rpcUrl, c.token, owner, c.spender);
    if (a >= UNLIMITED_FLOOR) unlimited.push(`${c.label}=${a}`);
    else if (a > 0n && !allowed.has(c.spender.toLowerCase())) excess.push(`${c.label}=${a}`);
  }
  return { unlimited, excess };
}
