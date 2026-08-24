import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AERO_ADDR } from '../../_protocols.js';
import { mintClPosition, slot0 } from '../../_aero.js';

export async function solve(ctx: FixtureCtx): Promise<void> {
  const { tick } = await slot0(ctx.anvil.rpcUrl, AERO_ADDR.poolCl100Gen1);
  const spacing = 100;
  const tickLower = (Math.floor(tick / spacing) + 2) * spacing;
  await mintClPosition(ctx, {
    npm: AERO_ADDR.npmGen1, tickSpacing: spacing,
    tickLower, tickUpper: tickLower + 1000,
    amount0: 5n * 10n ** 17n, amount1: 0n,
  });
}
