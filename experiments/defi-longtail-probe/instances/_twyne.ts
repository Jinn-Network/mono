// Twyne (L3) shared setup helpers.
import { encodeFunctionData, type Address } from 'viem';
import { rpc } from '../harness/src/lib/anvil.js';
import { freshAccount } from '../harness/src/lib/chain.js';
import { E, ETH, WETH_ABI, erc20Approve, read, walletSend } from '../harness/src/lib/defi.js';
import type { FixtureCtx, Wallet } from '../harness/src/lib/types.js';
import { EVAULT_ABI, TWYNE, TWYNE_FACTORY_ABI, TWYNE_VAULT_ABI } from './_protocols.js';

/** Deposit delegatable credit into the eeWETH intermediate vault from a
 * throwaway funder account (permissionless; sized inside the 7-eWETH cap). */
export async function prefundCreditLp(rpcUrl: string, wethAmount: bigint): Promise<void> {
  const { key, account } = freshAccount();
  const funder: Wallet = { address: account.address as Address, privateKey: key };
  await rpc(rpcUrl, 'anvil_setBalance', [funder.address, `0x${(wethAmount + ETH(1)).toString(16)}`]);
  await walletSend(rpcUrl, funder, E.weth, encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), wethAmount);
  await erc20Approve(rpcUrl, funder, E.weth, TWYNE.eulerEWeth, wethAmount);
  await walletSend(rpcUrl, funder, TWYNE.eulerEWeth, encodeFunctionData({
    abi: EVAULT_ABI, functionName: 'deposit', args: [wethAmount, funder.address],
  }));
  const shares = await read<bigint>(rpcUrl, TWYNE.eulerEWeth, EVAULT_ABI, 'balanceOf', [funder.address]);
  await erc20Approve(rpcUrl, funder, TWYNE.eulerEWeth, TWYNE.eeWethIntermediate, shares);
  await walletSend(rpcUrl, funder, TWYNE.eeWethIntermediate, encodeFunctionData({
    abi: EVAULT_ABI, functionName: 'deposit', args: [shares, funder.address],
  }));
}

export const EULER_V2_VAULT_TYPE = 0; // enum VaultType { EULER_V2, AAVE_V3 }

/** Setup/reference path: create a collateral vault, deposit WETH, borrow USDC. */
export async function openBoostedPosition(ctx: FixtureCtx, opts: { wethIn: bigint; usdcBorrow: bigint; liqLtv: bigint }): Promise<Address> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await walletSend(rpcUrl, ctx.wallet, TWYNE.factory, encodeFunctionData({
    abi: TWYNE_FACTORY_ABI, functionName: 'createCollateralVault',
    args: [EULER_V2_VAULT_TYPE, TWYNE.eeWethIntermediate, TWYNE.eulerEUsdc, opts.liqLtv, '0x0000000000000000000000000000000000000000'],
  }));
  const vaults = await read<Address[]>(rpcUrl, TWYNE.factory, TWYNE_FACTORY_ABI, 'getCollateralVaults', [ctx.wallet.address]);
  const vault = vaults[vaults.length - 1];
  await erc20Approve(rpcUrl, ctx.wallet, E.weth, vault, opts.wethIn);
  await walletSend(rpcUrl, ctx.wallet, vault, encodeFunctionData({
    abi: TWYNE_VAULT_ABI, functionName: 'depositUnderlying', args: [opts.wethIn],
  }));
  await walletSend(rpcUrl, ctx.wallet, vault, encodeFunctionData({
    abi: TWYNE_VAULT_ABI, functionName: 'borrow', args: [opts.usdcBorrow, ctx.wallet.address],
  }));
  return vault;
}

/** Plain-Euler max borrow (USDC 6dp) for `wethCollateral` at Euler's liquidation
 * LTV — the boost bar: debt above this proves Twyne actually boosted. */
export async function plainEulerLiqMaxUsdc(rpcUrl: string, wethCollateral: bigint, ethUsdPrice8: bigint): Promise<bigint> {
  const ltv1e4 = await read<number>(rpcUrl, TWYNE.eulerEUsdc, EVAULT_ABI, 'LTVLiquidation', [TWYNE.eulerEWeth]);
  // wethCollateral(1e18) × price(1e8) × ltv(1e4) → USDC(1e6)
  return (wethCollateral * ethUsdPrice8 * BigInt(ltv1e4)) / (10n ** 4n * 10n ** 12n * 10n ** 8n);
}
