import { encodeFunctionData } from 'viem';
import { ETH, erc20Approve, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { DEFAULT_APPROX, EMPTY_LIMIT, PENDLE, PENDLE_ROUTER_ABI } from '../../_protocols.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** Reference: router swapExactTokenForPt with the on-chain approximation. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await erc20Approve(rpcUrl, ctx.wallet, PENDLE.usde, PENDLE.routerV4, ETH(10_000));
  await walletSend(rpcUrl, ctx.wallet, PENDLE.routerV4, encodeFunctionData({
    abi: PENDLE_ROUTER_ABI,
    functionName: 'swapExactTokenForPt',
    args: [
      ctx.wallet.address,
      PENDLE.marketSusdeAug13,
      ETH(9_950),
      DEFAULT_APPROX,
      {
        tokenIn: PENDLE.usde, netTokenIn: ETH(10_000), tokenMintSy: PENDLE.usde,
        pendleSwap: ZERO, swapData: { swapType: 0, extRouter: ZERO, extCalldata: '0x', needScale: false },
      },
      EMPTY_LIMIT,
    ],
  }));
}
