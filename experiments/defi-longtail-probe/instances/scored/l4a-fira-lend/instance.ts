import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { E, USDC, erc20Balance, read } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { FIRA, FIRA_LENDING_ABI } from '../../_protocols.js';

export const meta: InstanceMeta = {
  id: 'l4a-fira-lend',
  family: 'L4',
  chain: 'ethereum',
  coverage: 'none',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Lend 10,000 USDC into Fira\'s wstETH-collateral market — zero-coverage discovery; 7-field MarketParams vs Morpho\'s 5.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.3, usdcEth: 10_000 });
  return { startUsdc: USDC(10_000) };
}

async function suppliedAssets(rpcUrl: string, user: `0x${string}`): Promise<{ assets: bigint; shares: bigint; borrowShares: bigint; collateral: bigint }> {
  const pos = await read<readonly [bigint, bigint, bigint]>(rpcUrl, FIRA.variableMarket, FIRA_LENDING_ABI, 'position', [FIRA.usdcWstethId, user]);
  const mkt = await read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(rpcUrl, FIRA.variableMarket, FIRA_LENDING_ABI, 'market', [FIRA.usdcWstethId]);
  const assets = mkt[1] === 0n ? 0n : (pos[0] * mkt[0]) / mkt[1];
  return { assets, shares: pos[0], borrowShares: pos[1], collateral: pos[2] };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const p = await suppliedAssets(rpcUrl, w);
  const usdc = await erc20Balance(rpcUrl, E.usdc, w);

  const checks: Check[] = [
    check('core:supplied-to-market', p.assets >= USDC(9_990) && p.assets <= USDC(10_010), `suppliedAssets=${p.assets}`),
    check('core:lend-not-collateral', p.collateral === 0n && p.borrowShares === 0n, `collateral=${p.collateral} borrowShares=${p.borrowShares}`),
    check('funds:fully-deployed', usdc <= USDC(1), `USDC residual=${usdc}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: E.usdc, spender: FIRA.variableMarket, label: 'USDC->firaVariableMarket' },
  ])));
  return checks;
}
