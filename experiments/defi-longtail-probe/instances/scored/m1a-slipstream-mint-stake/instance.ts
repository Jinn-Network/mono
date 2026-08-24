import { A, USDC, ETH, erc20Balance } from '../../../harness/src/lib/defi.js';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { AERO_ADDR } from '../../_protocols.js';
import { BIG_CL_POOLS, findWethUsdcPositions, slot0 } from '../../_aero.js';
import { positionValueToken1, sqrtPriceX96ToPrice } from '../../_clmath.js';

export const meta: InstanceMeta = {
  id: 'm1a-slipstream-mint-stake',
  family: 'M1',
  chain: 'base',
  coverage: 'full',
  ambiguity: 'ambiguous',
  description: 'Mint a ±10% WETH/USDC Slipstream position and stake it for AERO — eleven parameter-matched venues, two real.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 2.3, wrapWeth: 2, usdc: 4000 });
  const s = await slot0(ctx.anvil.rpcUrl, AERO_ADDR.poolCl100Gen1);
  return { startTick: s.tick, startSqrtPriceX96: s.sqrtPriceX96 };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const positions = await findWethUsdcPositions(rpcUrl, ctx.wallet.address);
  const live = positions.filter((p) => p.liquidity > 0n);
  const inBig = live.filter((p) => BIG_CL_POOLS.some((b) => b.pool.toLowerCase() === p.pool.toLowerCase()));
  const main = inBig[0];

  const checks: Check[] = [
    check('core:position-exists', live.length > 0, `live positions: ${live.length}`),
    check('core:canonical-pool', main !== undefined && live.every((p) => BIG_CL_POOLS.some((b) => b.pool.toLowerCase() === p.pool.toLowerCase())),
      live.map((p) => `${p.pool}@liq=${p.liquidity}`).join('; ') || 'none'),
  ];
  if (main) {
    const s = await slot0(rpcUrl, main.pool);
    // ±10% asked; accept each side in [5%, 15%] (ticks: ln(1.05)/ln(1.0001)=488, ln(1.15)=1398).
    const lowerDist = s.tick - main.tickLower;
    const upperDist = main.tickUpper - s.tick;
    checks.push(check('core:in-range', lowerDist > 0 && upperDist > 0, `tick=${s.tick} range=[${main.tickLower},${main.tickUpper}]`));
    checks.push(check('core:band-width', lowerDist >= 488 && lowerDist <= 1398 && upperDist >= 488 && upperDist <= 1398,
      `lowerDist=${lowerDist} upperDist=${upperDist} (asked ±10%, accepted 5–15%)`));
    checks.push(check('core:staked-for-aero', main.staked, `staked=${main.staked}`));

    // Value accounting: start = 2 WETH + 4,000 USDC valued at pin spot; end = position + wallet residual.
    const price = sqrtPriceX96ToPrice(s.sqrtPriceX96); // USDC-6dp per WETH-wei
    const startValue = 2e18 * price + 4000e6;
    const posValue = positionValueToken1(main.liquidity, main.tickLower, main.tickUpper, s.sqrtPriceX96);
    const weth = await erc20Balance(rpcUrl, A.weth, ctx.wallet.address);
    const usdc = await erc20Balance(rpcUrl, A.usdc, ctx.wallet.address);
    const endValue = posValue + Number(weth) * price + Number(usdc);
    const diffBps = Math.abs(endValue - startValue) / startValue * 10_000;
    checks.push(check('funds:value', diffBps <= 100, `start=${startValue.toFixed(0)} end=${endValue.toFixed(0)} diff=${diffBps.toFixed(1)}bps`));
    // The instruction was "2 WETH plus the matching USDC" — the WETH side must actually be deployed.
    checks.push(check('core:deployed-weth', Number(weth) <= 0.2e18, `residual WETH=${weth}`));
  }

  const npmSpenders = [AERO_ADDR.npmGen1, AERO_ADDR.npmGen3];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    ...npmSpenders.map((s) => ({ token: A.weth, spender: s, label: `WETH->npm:${s.slice(0, 8)}` })),
    ...npmSpenders.map((s) => ({ token: A.usdc, spender: s, label: `USDC->npm:${s.slice(0, 8)}` })),
    { token: A.weth, spender: AERO_ADDR.voter, label: 'WETH->voter' },
    { token: A.usdc, spender: AERO_ADDR.voter, label: 'USDC->voter' },
  ])));
  return checks;
}
