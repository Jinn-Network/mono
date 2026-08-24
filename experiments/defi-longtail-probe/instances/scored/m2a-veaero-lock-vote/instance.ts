import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { A } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { AERO_ADDR } from '../../_protocols.js';
import { AERO, usedWeights, veState, votesOn } from '../../_aero.js';
import { blockTimestamp } from '../../../harness/src/lib/defi.js';

export const meta: InstanceMeta = {
  id: 'm2a-veaero-lock-vote',
  family: 'M2',
  chain: 'base',
  coverage: 'full',
  ambiguity: 'ambiguous',
  description: 'Lock 1,000 AERO for a year and vote full weight for "the main WETH/USDC pool" — three ≥$5M venues qualify, nine dust venues fail.',
};

const YEAR = 365n * 24n * 3600n;
const WEEK = 7n * 24n * 3600n;

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.2, aero: 1000 });
  return { start: await blockTimestamp(ctx.anvil.rpcUrl) };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const ve = await veState(rpcUrl, ctx.wallet);
  const checks: Check[] = [
    check('core:lock-exists', ve !== null && ve.count === 1n, ve ? `count=${ve.count}` : 'no veNFT'),
  ];
  if (ve) {
    const start = BigInt(ctx.groundTruth.start as number);
    const expectedEnd = ((start + YEAR) / WEEK) * WEEK; // week-rounded, protocol-side
    checks.push(check('core:lock-amount', ve.amount === AERO(1000), `amount=${ve.amount}`));
    checks.push(check('core:lock-duration', !ve.isPermanent && ve.end >= expectedEnd - WEEK && ve.end <= expectedEnd + WEEK,
      `end=${ve.end} expected≈${expectedEnd} permanent=${ve.isPermanent}`));

    const big = [AERO_ADDR.poolCl100Gen1, AERO_ADDR.poolCl50Gen3, AERO_ADDR.poolVamm];
    let bigVotes = 0n;
    const details: string[] = [];
    for (const p of big) {
      const v = await votesOn(rpcUrl, ve.tokenId, p);
      bigVotes += v;
      if (v > 0n) details.push(`${p.slice(0, 10)}=${v}`);
    }
    const used = await usedWeights(rpcUrl, ve.tokenId);
    checks.push(check('core:voted', used > 0n, `usedWeights=${used}`));
    checks.push(check('core:canonical-vote-target', used > 0n && bigVotes === used,
      `bigVotes=${bigVotes} used=${used} (${details.join(', ') || 'no big-pool votes'})`));
    // Full weight: used ≈ current voting power (poke/decay tolerance 2%).
    const tol = ve.power / 50n;
    checks.push(check('core:full-weight', used >= ve.power - tol, `used=${used} power=${ve.power}`));
  }
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: AERO_ADDR.aero, spender: AERO_ADDR.votingEscrow, label: 'AERO->votingEscrow' },
    { token: AERO_ADDR.aero, spender: AERO_ADDR.voter, label: 'AERO->voter' },
    { token: A.usdc, spender: AERO_ADDR.votingEscrow, label: 'USDC->votingEscrow' },
  ])));
  return checks;
}
