import { encodeFunctionData } from 'viem';
import { erc20Approve, read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { COOLER, MONOCOOLER_ABI } from '../../_protocols.js';

const ETH18 = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** Reference: repay (currentDebt − 2,000), then withdraw down to the origination floor. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const pos = await read<{ collateral: bigint; currentDebt: bigint }>(rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'accountPosition', [w]);
  const repayAmt = pos.currentDebt - ETH18(2000);
  await erc20Approve(rpcUrl, ctx.wallet, COOLER.usds, COOLER.monoCooler, repayAmt);
  await walletSend(rpcUrl, ctx.wallet, COOLER.monoCooler, encodeFunctionData({
    abi: MONOCOOLER_ABI, functionName: 'repay', args: [repayAmt, w],
  }));
  const after = await read<{ collateral: bigint; currentDebt: bigint }>(rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'accountPosition', [w]);
  const [origLtv] = await read<readonly [bigint, bigint]>(rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'loanToValues', []);
  // Withdraw to the origination floor + tiny buffer against per-second LTV drip.
  const floor = (after.currentDebt * 10n ** 18n) / origLtv + 10n ** 12n;
  const withdrawable = after.collateral - floor;
  await walletSend(rpcUrl, ctx.wallet, COOLER.monoCooler, encodeFunctionData({
    abi: MONOCOOLER_ABI, functionName: 'withdrawCollateral', args: [withdrawable, w, w, []],
  }));
}
