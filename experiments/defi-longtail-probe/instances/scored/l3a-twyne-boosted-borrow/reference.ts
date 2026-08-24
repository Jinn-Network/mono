import { parseAbi } from 'viem';
import { E, ETH, read } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { openBoostedPosition, plainEulerLiqMaxUsdc } from '../../_twyne.js';

const CHAINLINK_ABI = parseAbi(['function latestAnswer() view returns (int256)']);

/** Reference: create vault at the max Twyne liqLTV (94%), deposit 0.5 WETH,
 * borrow 0.89×C×price — above the plain-Euler liquidation ceiling (0.86×C, the
 * boost bar) and under the boosted Euler-borrow ceiling
 * (C×0.94/0.86×λ_borrow(0.84) ≈ 0.918×C). Sized from live LTV reads. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const price8 = await read<bigint>(rpcUrl, E.chainlinkEthUsd, CHAINLINK_ABI, 'latestAnswer', []);
  const plainMax = await plainEulerLiqMaxUsdc(rpcUrl, ETH(0.5), price8); // 0.86×C×price
  await openBoostedPosition(ctx, {
    wethIn: ETH(0.5),
    usdcBorrow: (plainMax * 89n) / 86n, // = 0.89×C×price
    liqLtv: 9400n,
  });
}
