import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { ETH, erc20Balance, read, warpTime } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { COOLER, MONOCOOLER_ABI } from '../../_protocols.js';
import { solve as openLoan } from '../l2a-cooler-borrow/reference.js';

export const meta: InstanceMeta = {
  id: 'l2b-cooler-repay-withdraw',
  family: 'L2',
  chain: 'ethereum',
  coverage: 'partial',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Repay a Cooler loan to exactly 2,000 USDS and withdraw max safe gOHM — interest-first accounting, min-debt floor, drip-updated LTV.',
};

const THIRTY_DAYS = 30 * 24 * 3600;

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.3, gohm: 2 });
  await openLoan(ctx); // collateral ≈ debt/origLTV + 5%, debt = 5,000 USDS in wallet
  await warpTime(ctx.anvil.rpcUrl, THIRTY_DAYS);
  const pos = await read<{ collateral: bigint; currentDebt: bigint }>(
    ctx.anvil.rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'accountPosition', [ctx.wallet.address]);
  return { collateralAtStart: pos.collateral, debtAtStart: pos.currentDebt };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const pos = await read<{ collateral: bigint; currentDebt: bigint; healthFactor: bigint }>(
    rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'accountPosition', [w]);
  const [origLtv] = await read<readonly [bigint, bigint]>(rpcUrl, COOLER.monoCooler, MONOCOOLER_ABI, 'loanToValues', []);
  const gohm = await erc20Balance(rpcUrl, COOLER.gohm, w);
  const startCollateral = BigInt(ctx.groundTruth.collateralAtStart as string | bigint);

  // Max-safe withdrawal leaves collateral == debt/origLTV; accept ≤ +5% headroom left behind.
  const minCollateral = (pos.currentDebt * 10n ** 18n) / origLtv;
  const checks: Check[] = [
    check('core:debt-target', pos.currentDebt >= ETH(2000) && pos.currentDebt <= ETH(2002),
      `debt=${pos.currentDebt} (target exactly 2,000, small accrual tolerance)`),
    check('core:loan-still-open', pos.currentDebt > 0n && pos.collateral > 0n, `collateral=${pos.collateral}`),
    check('core:max-withdrawn', pos.collateral >= minCollateral && pos.collateral <= (minCollateral * 105n) / 100n,
      `collateral=${pos.collateral} floor=${minCollateral}`),
    check('core:not-liquidatable', pos.healthFactor > 10n ** 18n, `hf=${pos.healthFactor}`),
    check('funds:gohm-returned', gohm >= startCollateral - (minCollateral * 105n) / 100n - ETH(0.001),
      `wallet gOHM=${gohm} startCollateral=${startCollateral}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: COOLER.gohm, spender: COOLER.monoCooler, label: 'gOHM->monoCooler' },
    { token: COOLER.usds, spender: COOLER.monoCooler, label: 'USDS->monoCooler' },
  ])));
  return checks;
}
