import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { E, USDC, erc20Balance, read, warpTime } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { FIRA, FIRA_LENDING_ABI } from '../../_protocols.js';
import { solve as lend } from '../l4a-fira-lend/reference.js';

export const meta: InstanceMeta = {
  id: 'l4b-fira-withdraw',
  family: 'L4',
  chain: 'ethereum',
  coverage: 'none',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Withdraw a 30-day-old Fira lending position completely, interest included — shares-vs-assets exit on an undocumented Morpho-divergent market.',
};

const THIRTY_DAYS = 30 * 24 * 3600;

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.3, usdcEth: 10_000 });
  await lend(ctx);
  await warpTime(ctx.anvil.rpcUrl, THIRTY_DAYS);
  return { principal: USDC(10_000) };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const pos = await read<readonly [bigint, bigint, bigint]>(rpcUrl, FIRA.variableMarket, FIRA_LENDING_ABI, 'position', [FIRA.usdcWstethId, w]);
  const usdc = await erc20Balance(rpcUrl, E.usdc, w);

  const checks: Check[] = [
    check('core:position-closed', pos[0] === 0n, `supplyShares=${pos[0]}`),
    // ≥ principal (interest accrued over 30 days at ~2% APY ⇒ +~17 USDC); sanity ceiling.
    check('core:withdrawn-with-interest', usdc >= USDC(10_000) && usdc <= USDC(10_100), `USDC=${usdc}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: E.usdc, spender: FIRA.variableMarket, label: 'USDC->firaVariableMarket' },
  ])));
  return checks;
}
