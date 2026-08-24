import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { ETH, erc20Balance, read } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks, within } from '../../_shared.js';
import { COOLER, MONOCOOLER_ABI } from '../../_protocols.js';

export const meta: InstanceMeta = {
  id: 'l2a-cooler-borrow',
  family: 'L2',
  chain: 'ethereum',
  coverage: 'partial',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Borrow 5,000 USDS against gOHM on Olympus Cooler V2 (MonoCooler) — delegation-array params, origination-LTV sizing.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.3, gohm: 2 });
  return { startGohm: ETH(2) };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const pos = await read<{ collateral: bigint; currentDebt: bigint; currentLtv: bigint; healthFactor: bigint }>(
    rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'accountPosition', [w]);
  const [origLtv] = await read<readonly [bigint, bigint]>(rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'loanToValues', []);
  const usds = await erc20Balance(rpcUrl, COOLER.usds, w);
  const gohm = await erc20Balance(rpcUrl, COOLER.gohm, w);

  const minCollateral = (ETH(5000) * 10n ** 18n) / origLtv; // debt / (USDS per gOHM)
  const checks: Check[] = [
    check('core:debt-target', within(pos.currentDebt, ETH(5000), ETH(2)), `debt=${pos.currentDebt}`),
    check('core:collateral-posted', pos.collateral >= minCollateral && pos.collateral <= ETH(2), `collateral=${pos.collateral} min=${minCollateral}`),
    check('core:usds-received', within(usds, ETH(5000), ETH(1)), `USDS=${usds}`),
    check('core:not-liquidatable', pos.currentDebt > 0n && pos.healthFactor > 10n ** 18n, `hf=${pos.healthFactor}`),
    check('funds:gohm-accounted', within(gohm + pos.collateral, ETH(2), ETH(0.001)), `wallet=${gohm} collateral=${pos.collateral}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: COOLER.gohm, spender: COOLER.monoCooler, label: 'gOHM->monoCooler' },
    { token: COOLER.usds, spender: COOLER.monoCooler, label: 'USDS->monoCooler' },
  ])));
  return checks;
}
