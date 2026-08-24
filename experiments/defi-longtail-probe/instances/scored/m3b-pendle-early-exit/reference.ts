import { encodeFunctionData } from 'viem';
import { erc20Approve, erc20Balance, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { EMPTY_LIMIT, PENDLE, PENDLE_ROUTER_ABI } from '../../_protocols.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** Reference: swapExactPtForToken to sUSDe (SY-sUSDe cannot redeem to raw USDe —
 * unstaking has a cooldown; tokenOut must be sUSDe). */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const pt = await erc20Balance(rpcUrl, PENDLE.ptAug13, ctx.wallet.address);
  await erc20Approve(rpcUrl, ctx.wallet, PENDLE.ptAug13, PENDLE.routerV4, pt);
  await walletSend(rpcUrl, ctx.wallet, PENDLE.routerV4, encodeFunctionData({
    abi: PENDLE_ROUTER_ABI,
    functionName: 'swapExactPtForToken',
    args: [
      ctx.wallet.address,
      PENDLE.marketSusdeAug13,
      pt,
      {
        // minTokenOut is in sUSDe units; ~1.19 USDe per sUSDe ⇒ a face-value×0.80 floor is loose but safe.
        tokenOut: PENDLE.susde, minTokenOut: (pt * 80n) / 100n / 2n, tokenRedeemSy: PENDLE.susde,
        pendleSwap: ZERO, swapData: { swapType: 0, extRouter: ZERO, extCalldata: '0x', needScale: false },
      },
      EMPTY_LIMIT,
    ],
  }));
}
