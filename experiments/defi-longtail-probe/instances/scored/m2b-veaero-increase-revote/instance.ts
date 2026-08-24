import type { Address } from 'viem';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { A, blockTimestamp, erc20Balance, read, warpTime } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { AERO_ADDR, CL_FACTORY_ABI, V2_FACTORY_ABI } from '../../_protocols.js';
import { AERO, createLockAndMaybeVote, secondsToNextEpoch, usedWeights, veState, votesOn } from '../../_aero.js';

export const meta: InstanceMeta = {
  id: 'm2b-veaero-increase-revote',
  family: 'M2',
  chain: 'base',
  coverage: 'full',
  ambiguity: 'unique',
  description: 'Add 500 AERO to an existing lock and switch this week\'s vote from WETH/USDC to AERO/USDC — increaseAmount vs new-lock, reset/re-vote.',
};

/** AERO/USDC venues an agent could defensibly vote for, enumerated at setup
 * from pinned state: the v2 volatile pool plus any CL venue holding ≥250k
 * USDC. Locked into ground truth deterministically. */
async function acceptableAeroUsdcPools(rpcUrl: string): Promise<Address[]> {
  const out: Address[] = [];
  const zero = '0x0000000000000000000000000000000000000000';
  const vamm = await read<Address>(rpcUrl, AERO_ADDR.v2Factory, V2_FACTORY_ABI, 'getPool', [AERO_ADDR.aero, A.usdc, false]);
  if (vamm !== zero) out.push(vamm);
  for (const f of [AERO_ADDR.clFactoryGen1, AERO_ADDR.clFactoryGen3]) {
    for (const ts of [1, 10, 50, 100, 200, 500, 2000]) {
      const p = await read<Address>(rpcUrl, f, CL_FACTORY_ABI, 'getPool', [AERO_ADDR.aero, A.usdc, ts]).catch(() => zero as Address);
      if (p === zero) continue;
      const usdcBal = await erc20Balance(rpcUrl, A.usdc, p);
      if (usdcBal >= 250_000n * 10n ** 6n) out.push(p);
    }
  }
  return out;
}

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await fundWallet(ctx, { eth: 0.2, aero: 1500 });
  const tokenId = await createLockAndMaybeVote(ctx, {
    aero: AERO(1000), durationSec: 365n * 24n * 3600n, votePool: AERO_ADDR.poolCl100Gen1,
  });
  // Cross into the next epoch (+2h past the flip) so a fresh vote is allowed.
  const now = await blockTimestamp(rpcUrl);
  await warpTime(rpcUrl, secondsToNextEpoch(now, 2 * 3600));
  const poolsB = await acceptableAeroUsdcPools(rpcUrl);
  if (poolsB.length === 0) throw new Error('no acceptable AERO/USDC pool found at pin');
  return { tokenId, poolA: AERO_ADDR.poolCl100Gen1, poolsB };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const poolsB = (ctx.groundTruth.poolsB as string[]).map((p) => p as Address);
  const poolA = ctx.groundTruth.poolA as Address;
  const ve = await veState(rpcUrl, ctx.wallet);
  const checks: Check[] = [
    check('core:single-lock', ve !== null && ve.count === 1n, ve ? `count=${ve.count}` : 'no veNFT'),
  ];
  if (ve) {
    checks.push(check('core:lock-increased', ve.amount === AERO(1500), `amount=${ve.amount} (expected 1500e18 in ONE lock)`));
    const va = await votesOn(rpcUrl, ve.tokenId, poolA);
    let vb = 0n;
    const details: string[] = [];
    for (const p of poolsB) {
      const v = await votesOn(rpcUrl, ve.tokenId, p);
      vb += v;
      if (v > 0n) details.push(`${p.slice(0, 10)}=${v}`);
    }
    const used = await usedWeights(rpcUrl, ve.tokenId);
    checks.push(check('core:old-vote-cleared', va === 0n, `votes(poolA)=${va}`));
    checks.push(check('core:new-vote-cast', used > 0n && vb === used, `aeroUsdcVotes=${vb} used=${used} (${details.join(', ') || 'none'})`));
  }
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: AERO_ADDR.aero, spender: AERO_ADDR.votingEscrow, label: 'AERO->votingEscrow' },
    { token: AERO_ADDR.aero, spender: AERO_ADDR.voter, label: 'AERO->voter' },
  ])));
  return checks;
}
