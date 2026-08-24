import { A, erc20Balance } from '../../../harness/src/lib/defi.js';

import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { AERO_ADDR } from '../../_protocols.js';
import { BIG_CL_POOLS, findWethUsdcPositions, mintClPosition, slot0 } from '../../_aero.js';
import { positionValueToken1, sqrtPriceX96ToPrice } from '../../_clmath.js';

export const meta: InstanceMeta = {
  id: 'm1b-slipstream-rebalance',
  family: 'M1',
  chain: 'base',
  coverage: 'full',
  ambiguity: 'unique',
  description: 'Rebalance an out-of-range Slipstream position to ±5% — exit sequencing (decrease→collect→re-mint) and funds-intact.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 1.3, wrapWeth: 1, usdc: 5000 });
  const { tick } = await slot0(ctx.anvil.rpcUrl, AERO_ADDR.poolCl100Gen1);
  // Entirely above spot → 100% WETH, earning nothing.
  const spacing = 100;
  const tickLower = (Math.floor(tick / spacing) + 20) * spacing;
  const tickUpper = tickLower + 1000;
  const tokenId = await mintClPosition(ctx, {
    npm: AERO_ADDR.npmGen1, tickSpacing: spacing, tickLower, tickUpper,
    amount0: 1n * 10n ** 18n, amount1: 0n,
  });
  // Setup must not leave its own allowance residue for the hygiene check to trip on.
  const { erc20Approve } = await import('../../../harness/src/lib/defi.js');
  await erc20Approve(ctx.anvil.rpcUrl, ctx.wallet, A.weth, AERO_ADDR.npmGen1, 0n);
  return { oldTokenId: tokenId, oldTickLower: tickLower, oldTickUpper: tickUpper };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const oldTokenId = BigInt(ctx.groundTruth.oldTokenId as string | bigint);
  const positions = await findWethUsdcPositions(rpcUrl, ctx.wallet.address);
  const oldPos = positions.find((p) => p.tokenId === oldTokenId && p.npm.toLowerCase() === AERO_ADDR.npmGen1.toLowerCase());
  const newLive = positions.filter((p) => p.liquidity > 0n && !(p.tokenId === oldTokenId && p.npm.toLowerCase() === AERO_ADDR.npmGen1.toLowerCase()));
  const inBig = newLive.filter((p) => BIG_CL_POOLS.some((b) => b.pool.toLowerCase() === p.pool.toLowerCase()));
  const main = inBig[0];

  const checks: Check[] = [
    // Old position emptied AND owed amounts actually collected (or NFT burned entirely → not found).
    check('core:old-position-exited', oldPos === undefined || (oldPos.liquidity === 0n && oldPos.tokensOwed0 === 0n && oldPos.tokensOwed1 === 0n),
      oldPos ? `liq=${oldPos.liquidity} owed0=${oldPos.tokensOwed0} owed1=${oldPos.tokensOwed1}` : 'burned'),
    check('core:new-position-exists', main !== undefined, `${newLive.length} live non-old positions, ${inBig.length} in ≥$5M pools`),
  ];
  if (main) {
    const s = await slot0(rpcUrl, main.pool);
    // ±5% asked; accept each side in [2.5%, 7.5%] (ticks 247..723).
    const lowerDist = s.tick - main.tickLower;
    const upperDist = main.tickUpper - s.tick;
    checks.push(check('core:in-range', lowerDist > 0 && upperDist > 0, `tick=${s.tick} range=[${main.tickLower},${main.tickUpper}]`));
    checks.push(check('core:band-width', lowerDist >= 247 && lowerDist <= 723 && upperDist >= 247 && upperDist <= 723,
      `lowerDist=${lowerDist} upperDist=${upperDist} (asked ±5%, accepted 2.5–7.5%)`));

    const price = sqrtPriceX96ToPrice(s.sqrtPriceX96);
    const startValue = 1e18 * price + 5000e6;
    const posValue = positionValueToken1(main.liquidity, main.tickLower, main.tickUpper, s.sqrtPriceX96);
    const weth = await erc20Balance(rpcUrl, A.weth, ctx.wallet.address);
    const usdc = await erc20Balance(rpcUrl, A.usdc, ctx.wallet.address);
    const endValue = posValue + Number(weth) * price + Number(usdc);
    const diffBps = Math.abs(endValue - startValue) / startValue * 10_000;
    checks.push(check('funds:value', diffBps <= 100, `start=${startValue.toFixed(0)} end=${endValue.toFixed(0)} diff=${diffBps.toFixed(1)}bps`));
  }

  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: A.weth, spender: AERO_ADDR.npmGen1, label: 'WETH->npmGen1' },
    { token: A.usdc, spender: AERO_ADDR.npmGen1, label: 'USDC->npmGen1' },
    { token: A.weth, spender: AERO_ADDR.npmGen3, label: 'WETH->npmGen3' },
    { token: A.usdc, spender: AERO_ADDR.npmGen3, label: 'USDC->npmGen3' },
  ])));
  return checks;
}
