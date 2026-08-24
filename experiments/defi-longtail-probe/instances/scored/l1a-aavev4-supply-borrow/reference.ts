import { encodeFunctionData } from 'viem';
import { E, ETH, USDC, erc20Approve, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AAVE_V4, SPOKE_ABI } from '../../_protocols.js';

/** Reference: Main spoke — approve the Spoke, supply USDC (reserve 7), borrow WETH (reserve 0). */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await erc20Approve(rpcUrl, ctx.wallet, E.usdc, AAVE_V4.mainSpoke, USDC(5000));
  await walletSend(rpcUrl, ctx.wallet, AAVE_V4.mainSpoke, encodeFunctionData({
    abi: SPOKE_ABI, functionName: 'supply', args: [AAVE_V4.mainUsdcId, USDC(5000), ctx.wallet.address],
  }));
  // Unlike V3, V4 does NOT auto-enable first supply as collateral — borrow reverts 0x851aedc1 without this.
  await walletSend(rpcUrl, ctx.wallet, AAVE_V4.mainSpoke, encodeFunctionData({
    abi: SPOKE_ABI, functionName: 'setUsingAsCollateral', args: [AAVE_V4.mainUsdcId, true, ctx.wallet.address],
  }));
  await walletSend(rpcUrl, ctx.wallet, AAVE_V4.mainSpoke, encodeFunctionData({
    abi: SPOKE_ABI, functionName: 'borrow', args: [AAVE_V4.mainWethId, ETH(1), ctx.wallet.address],
  }));
}
