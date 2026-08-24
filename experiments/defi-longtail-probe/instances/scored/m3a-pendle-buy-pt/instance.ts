import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { ERC20_ABI, ETH, erc20Balance, read } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { PENDLE } from '../../_protocols.js';

export const meta: InstanceMeta = {
  id: 'm3a-pendle-buy-pt',
  family: 'M3',
  chain: 'ethereum',
  coverage: 'full',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Swap 10,000 USDe into PT-sUSDe via Pendle — SY routing, ApproxParams, slippage floor, no mid-conversion residue.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.5, usde: 10_000 });
  return { startUsde: ETH(10_000) };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const pt = await erc20Balance(rpcUrl, PENDLE.ptAug13, w);
  const usde = await erc20Balance(rpcUrl, PENDLE.usde, w);
  const sy = await erc20Balance(rpcUrl, PENDLE.syAug13, w);
  const yt = await erc20Balance(rpcUrl, PENDLE.ytAug13, w);
  const ptWrongMarket = await read<bigint>(rpcUrl, PENDLE.marketUsdeAug13, ERC20_ABI, 'balanceOf', [w]).catch(() => 0n);

  const checks: Check[] = [
    // Floor set from the QA reference run (PT trades at a small discount to USDe 10 days out).
    check('core:pt-received', pt >= ETH(9_950), `PT=${pt}`),
    check('core:fully-deployed', usde <= ETH(10), `USDe residual=${usde}`),
    check('core:correct-market', ptWrongMarket === 0n, `USDe-market LP balance=${ptWrongMarket} (thin sibling market)`),
    check('funds:no-sy-residue', sy <= ETH(1), `SY=${sy}`),
    check('funds:no-yt-residue', yt <= ETH(1), `YT=${yt}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: PENDLE.usde, spender: PENDLE.routerV4, label: 'USDe->routerV4' },
    { token: PENDLE.susde, spender: PENDLE.routerV4, label: 'sUSDe->routerV4' },
  ])));
  return checks;
}
