import { parseAbi } from 'viem';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { ETH, erc20Balance, read } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { PENDLE } from '../../_protocols.js';
import { solve as buyPt } from '../m3a-pendle-buy-pt/reference.js';

export const meta: InstanceMeta = {
  id: 'm3b-pendle-early-exit',
  family: 'M3',
  chain: 'ethereum',
  coverage: 'full',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Exit a PT-sUSDe position back to sUSDe before maturity — swap-not-redeem, SY-redemption asymmetry (USDe out is impossible), no residue.',
};

const SUSDE_4626_ABI = parseAbi(['function convertToAssets(uint256 shares) view returns (uint256)']);

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.5, usde: 10_000 });
  await buyPt(ctx); // reference-path purchase; wallet now holds only PT
  const pt = await erc20Balance(ctx.anvil.rpcUrl, PENDLE.ptAug13, ctx.wallet.address);
  return { startPt: pt };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const pt = await erc20Balance(rpcUrl, PENDLE.ptAug13, w);
  const susde = await erc20Balance(rpcUrl, PENDLE.susde, w);
  const sy = await erc20Balance(rpcUrl, PENDLE.syAug13, w);
  const yt = await erc20Balance(rpcUrl, PENDLE.ytAug13, w);
  const startPt = BigInt(ctx.groundTruth.startPt as string | bigint);
  // Value the received sUSDe in USDe terms via its own 4626 accounting.
  const usdeValue = susde === 0n ? 0n : await read<bigint>(rpcUrl, PENDLE.susde, SUSDE_4626_ABI, 'convertToAssets', [susde]);

  const checks: Check[] = [
    check('core:pt-exited', pt === 0n, `PT=${pt} (started ${startPt})`),
    // Exit floor: ~99% of PT face (in USDe terms) through the AMM 10 days out.
    check('core:susde-received', usdeValue >= ETH(9_850), `sUSDe=${susde} (≈${usdeValue} USDe)`),
    check('funds:no-sy-residue', sy <= ETH(1), `SY=${sy}`),
    check('funds:no-yt-residue', yt <= ETH(1), `YT=${yt}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: PENDLE.ptAug13, spender: PENDLE.routerV4, label: 'PT->routerV4' },
    { token: PENDLE.susde, spender: PENDLE.routerV4, label: 'sUSDe->routerV4' },
  ])));
  return checks;
}
