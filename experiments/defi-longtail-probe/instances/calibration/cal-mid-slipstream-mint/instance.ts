import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { check, fundWallet } from '../../_shared.js';
import { findWethUsdcPositions } from '../../_aero.js';

export const meta: InstanceMeta = {
  id: 'cal-mid-slipstream-mint',
  family: 'M1',
  chain: 'base',
  coverage: 'full',
  ambiguity: 'unique',
  description: 'CALIBRATION (non-scored): single-sided 0.5 WETH Slipstream mint — exercises the Base fork profile end-to-end.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.8, wrapWeth: 0.5 });
  return {};
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const positions = await findWethUsdcPositions(ctx.anvil.rpcUrl, ctx.wallet.address);
  const live = positions.filter((p) => p.liquidity > 0n);
  return [
    check('core:position-exists', live.length > 0, `live=${live.length}`),
  ];
}
