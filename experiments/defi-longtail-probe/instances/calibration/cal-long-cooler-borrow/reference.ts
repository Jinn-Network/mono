import { encodeFunctionData } from 'viem';
import { ETH, erc20Approve, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { COOLER, MONOCOOLER_ABI } from '../../_protocols.js';

export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await erc20Approve(rpcUrl, ctx.wallet, COOLER.gohm, COOLER.monoCooler, ETH(1));
  await walletSend(rpcUrl, ctx.wallet, COOLER.monoCooler, encodeFunctionData({
    abi: MONOCOOLER_ABI, functionName: 'addCollateral', args: [ETH(1), ctx.wallet.address, []],
  }));
  await walletSend(rpcUrl, ctx.wallet, COOLER.monoCooler, encodeFunctionData({
    abi: MONOCOOLER_ABI, functionName: 'borrow', args: [ETH(1500), ctx.wallet.address, ctx.wallet.address],
  }));
}
