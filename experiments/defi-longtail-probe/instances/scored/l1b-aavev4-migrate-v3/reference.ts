import { encodeFunctionData, parseAbi } from 'viem';
import { E, erc20Approve, erc20Balance, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AAVE_V4, SPOKE_ABI } from '../../_protocols.js';

const V3_WITHDRAW_ABI = parseAbi(['function withdraw(address asset, uint256 amount, address to) returns (uint256)']);
const MAX = 2n ** 256n - 1n;

/** Reference: V3 withdraw(max) → approve Main spoke → supply full balance. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await walletSend(rpcUrl, ctx.wallet, AAVE_V4.v3Pool, encodeFunctionData({
    abi: V3_WITHDRAW_ABI, functionName: 'withdraw', args: [E.usdc, MAX, ctx.wallet.address],
  }));
  const bal = await erc20Balance(rpcUrl, E.usdc, ctx.wallet.address);
  await erc20Approve(rpcUrl, ctx.wallet, E.usdc, AAVE_V4.mainSpoke, bal);
  await walletSend(rpcUrl, ctx.wallet, AAVE_V4.mainSpoke, encodeFunctionData({
    abi: SPOKE_ABI, functionName: 'supply', args: [AAVE_V4.mainUsdcId, bal, ctx.wallet.address],
  }));
}
