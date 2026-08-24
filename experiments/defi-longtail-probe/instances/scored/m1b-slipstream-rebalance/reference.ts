import { encodeFunctionData } from 'viem';
import { blockTimestamp, read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AERO_ADDR, CL_NPM_ABI } from '../../_protocols.js';
import { mintClPosition, slot0 } from '../../_aero.js';

/** Reference: decrease→collect→burn the old position, re-mint ±5% two-sided. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const npm = AERO_ADDR.npmGen1;
  const n = await read<bigint>(rpcUrl, npm, CL_NPM_ABI, 'balanceOf', [ctx.wallet.address]);
  const tokenId = await read<bigint>(rpcUrl, npm, CL_NPM_ABI, 'tokenOfOwnerByIndex', [ctx.wallet.address, n - 1n]);
  const pos = await read<readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]>(
    rpcUrl, npm, CL_NPM_ABI, 'positions', [tokenId]);
  const deadline = BigInt(await blockTimestamp(rpcUrl)) + 3600n;
  await walletSend(rpcUrl, ctx.wallet, npm, encodeFunctionData({
    abi: CL_NPM_ABI, functionName: 'decreaseLiquidity',
    args: [{ tokenId, liquidity: pos[7], amount0Min: 0n, amount1Min: 0n, deadline }],
  }));
  await walletSend(rpcUrl, ctx.wallet, npm, encodeFunctionData({
    abi: CL_NPM_ABI, functionName: 'collect',
    args: [{ tokenId, recipient: ctx.wallet.address, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }],
  }));
  await walletSend(rpcUrl, ctx.wallet, npm, encodeFunctionData({
    abi: CL_NPM_ABI, functionName: 'burn', args: [tokenId],
  }));
  const { tick } = await slot0(rpcUrl, AERO_ADDR.poolCl100Gen1);
  const spacing = 100;
  const width = 488; // ln(1.05)/ln(1.0001)
  await mintClPosition(ctx, {
    npm, tickSpacing: spacing,
    tickLower: Math.floor((tick - width) / spacing) * spacing,
    tickUpper: Math.ceil((tick + width) / spacing) * spacing,
    amount0: 1n * 10n ** 18n, amount1: 5000n * 10n ** 6n,
  });
  const { A, erc20Approve } = await import('../../../harness/src/lib/defi.js');
  await erc20Approve(rpcUrl, ctx.wallet, A.weth, npm, 0n);
  await erc20Approve(rpcUrl, ctx.wallet, A.usdc, npm, 0n);
}
