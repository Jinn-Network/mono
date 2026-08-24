import { encodeFunctionData } from 'viem';
import { read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { FIRA, FIRA_LENDING_ABI, FIRA_MARKET_PARAMS } from '../../_protocols.js';

/** Reference: withdraw by shares (exact-everything exit, Morpho convention). */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const pos = await read<readonly [bigint, bigint, bigint]>(rpcUrl, FIRA.variableMarket, FIRA_LENDING_ABI, 'position', [FIRA.usdcWstethId, ctx.wallet.address]);
  await walletSend(rpcUrl, ctx.wallet, FIRA.variableMarket, encodeFunctionData({
    abi: FIRA_LENDING_ABI, functionName: 'withdraw',
    args: [FIRA_MARKET_PARAMS, 0n, pos[0], ctx.wallet.address, ctx.wallet.address],
  }));
}
