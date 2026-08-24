import { encodeFunctionData } from 'viem';
import { ETH, erc20Approve, read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { COOLER, MONOCOOLER_ABI } from '../../_protocols.js';

/** Reference: addCollateral(sized to origination LTV + 5% headroom) → borrow(5,000). */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const [origLtv] = await read<readonly [bigint, bigint]>(rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'loanToValues', []);
  const collateral = (ETH(5000) * 10n ** 18n * 105n) / (origLtv * 100n);
  await erc20Approve(rpcUrl, ctx.wallet, COOLER.gohm, COOLER.monoCooler, collateral);
  await walletSend(rpcUrl, ctx.wallet, COOLER.monoCooler, encodeFunctionData({
    abi: MONOCOOLER_ABI, functionName: 'addCollateral', args: [collateral, ctx.wallet.address, []],
  }));
  await walletSend(rpcUrl, ctx.wallet, COOLER.monoCooler, encodeFunctionData({
    abi: MONOCOOLER_ABI, functionName: 'borrow', args: [ETH(5000), ctx.wallet.address, ctx.wallet.address],
  }));
}
