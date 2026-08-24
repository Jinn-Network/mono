import { encodeFunctionData } from 'viem';
import { read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AERO_ADDR, CL_GAUGE_ABI, CL_NPM_ABI, CL_POOL_ABI } from '../../_protocols.js';
import { mintClPosition, slot0 } from '../../_aero.js';

/** Reference: mint ±10% in the gen-1 CL100 pool (canonical by TVL), stake in its gauge. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const { tick } = await slot0(rpcUrl, AERO_ADDR.poolCl100Gen1);
  const spacing = 100;
  const width = 953; // ln(1.10)/ln(1.0001)
  const tickLower = Math.floor((tick - width) / spacing) * spacing;
  const tickUpper = Math.ceil((tick + width) / spacing) * spacing;
  const tokenId = await mintClPosition(ctx, {
    npm: AERO_ADDR.npmGen1, tickSpacing: spacing, tickLower, tickUpper,
    amount0: 2n * 10n ** 18n, amount1: 4000n * 10n ** 6n,
  });
  const gauge = await read<`0x${string}`>(rpcUrl, AERO_ADDR.poolCl100Gen1, CL_POOL_ABI, 'gauge', []);
  await walletSend(rpcUrl, ctx.wallet, AERO_ADDR.npmGen1, encodeFunctionData({
    abi: CL_NPM_ABI, functionName: 'approve', args: [gauge, tokenId],
  }));
  await walletSend(rpcUrl, ctx.wallet, gauge, encodeFunctionData({
    abi: CL_GAUGE_ABI, functionName: 'deposit', args: [tokenId],
  }));
  // Mint consumes ≤ desired; revoke residual allowances (hygiene bar the agent is held to).
  const { A, erc20Approve } = await import('../../../harness/src/lib/defi.js');
  await erc20Approve(rpcUrl, ctx.wallet, A.weth, AERO_ADDR.npmGen1, 0n);
  await erc20Approve(rpcUrl, ctx.wallet, A.usdc, AERO_ADDR.npmGen1, 0n);
}
