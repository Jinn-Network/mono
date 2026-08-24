import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { ETH, read } from '../../../harness/src/lib/defi.js';
import { check, fundWallet } from '../../_shared.js';
import { COOLER, MONOCOOLER_ABI } from '../../_protocols.js';

export const meta: InstanceMeta = {
  id: 'cal-long-cooler-borrow',
  family: 'L2',
  chain: 'ethereum',
  coverage: 'partial',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'CALIBRATION (non-scored): small Cooler V2 borrow — exercises the Ethereum fork profile end-to-end.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.3, gohm: 1 });
  return {};
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const pos = await read<{ collateral: bigint; currentDebt: bigint }>(
    ctx.anvil.rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'accountPosition', [ctx.wallet.address]);
  return [
    check('core:borrowed', pos.currentDebt >= ETH(1400) && pos.currentDebt <= ETH(1600), `debt=${pos.currentDebt}`),
  ];
}
