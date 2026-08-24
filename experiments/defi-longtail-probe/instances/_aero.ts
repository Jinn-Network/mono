// Shared Aerodrome helpers for M1/M2 setup + verification.
import { encodeFunctionData, type Address } from 'viem';
import { A, ETH, erc20Approve, read, walletSend, blockTimestamp } from '../harness/src/lib/defi.js';
import type { FixtureCtx, Wallet } from '../harness/src/lib/types.js';
import {
  AERO_ADDR, CL_GAUGE_ABI, CL_NPM_ABI, CL_POOL_ABI, VOTER_ABI, VOTING_ESCROW_ABI,
} from './_protocols.js';

export const BIG_CL_POOLS: Array<{ pool: Address; npm: Address }> = [
  { pool: AERO_ADDR.poolCl100Gen1, npm: AERO_ADDR.npmGen1 },
  { pool: AERO_ADDR.poolCl50Gen3, npm: AERO_ADDR.npmGen3 },
];

export interface FoundPosition {
  pool: Address; npm: Address; tokenId: bigint; staked: boolean;
  tickLower: number; tickUpper: number; liquidity: bigint;
  tokensOwed0: bigint; tokensOwed1: bigint;
}

/** Every WETH/USDC CL position the wallet holds (staked or not) across the
 * eleven enumerated venues. */
export async function findWethUsdcPositions(rpcUrl: string, wallet: Address): Promise<FoundPosition[]> {
  const out: FoundPosition[] = [];
  const allPools: Array<{ pool: Address; npm?: Address }> = [
    ...BIG_CL_POOLS,
    ...AERO_ADDR.dustPools.map((p) => ({ pool: p })),
  ];
  for (const { pool, npm } of allPools) {
    const poolNpm = npm ?? (await read<Address>(rpcUrl, pool, CL_POOL_ABI, 'nft', []).catch(() => undefined));
    // Staked positions live in the pool's gauge.
    const gauge = await read<Address>(rpcUrl, pool, CL_POOL_ABI, 'gauge', []).catch(() => undefined);
    const spacing = await read<number>(rpcUrl, pool, CL_POOL_ABI, 'tickSpacing', []).catch(() => undefined);
    if (spacing === undefined) continue;
    const candidates: Array<{ tokenId: bigint; staked: boolean }> = [];
    if (gauge) {
      const staked = await read<bigint[]>(rpcUrl, gauge, CL_GAUGE_ABI, 'stakedValues', [wallet]).catch(() => [] as bigint[]);
      for (const t of staked) candidates.push({ tokenId: t, staked: true });
    }
    if (poolNpm) {
      const n = await read<bigint>(rpcUrl, poolNpm, CL_NPM_ABI, 'balanceOf', [wallet]).catch(() => 0n);
      for (let i = 0n; i < n; i += 1n) {
        const t = await read<bigint>(rpcUrl, poolNpm, CL_NPM_ABI, 'tokenOfOwnerByIndex', [wallet, i]);
        candidates.push({ tokenId: t, staked: false });
      }
    }
    for (const c of candidates) {
      if (!poolNpm) continue;
      const p = await read<readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]>(
        rpcUrl, poolNpm, CL_NPM_ABI, 'positions', [c.tokenId],
      ).catch(() => undefined);
      if (!p) continue;
      const [, , token0, token1, ts, tickLower, tickUpper, liquidity, , , owed0, owed1] = p;
      const isWethUsdc = token0.toLowerCase() === A.weth.toLowerCase() && token1.toLowerCase() === A.usdc.toLowerCase();
      if (!isWethUsdc || ts !== spacing) continue;
      out.push({ pool, npm: poolNpm, tokenId: c.tokenId, staked: c.staked, tickLower, tickUpper, liquidity, tokensOwed0: owed0, tokensOwed1: owed1 });
    }
  }
  return out;
}

export async function slot0(rpcUrl: string, pool: Address): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const r = await read<readonly [bigint, number, number, number, number, boolean]>(rpcUrl, pool, CL_POOL_ABI, 'slot0', []);
  return { sqrtPriceX96: r[0], tick: r[1] };
}

/** Setup-side mint into a CL pool via its NPM (used by M1b + calibration). */
export async function mintClPosition(ctx: FixtureCtx, opts: {
  npm: Address; tickSpacing: number; tickLower: number; tickUpper: number;
  amount0: bigint; amount1: bigint;
}): Promise<bigint> {
  const rpcUrl = ctx.anvil.rpcUrl;
  if (opts.amount0 > 0n) await erc20Approve(rpcUrl, ctx.wallet, A.weth, opts.npm, opts.amount0);
  if (opts.amount1 > 0n) await erc20Approve(rpcUrl, ctx.wallet, A.usdc, opts.npm, opts.amount1);
  const deadline = BigInt(await blockTimestamp(rpcUrl)) + 3600n;
  await walletSend(rpcUrl, ctx.wallet, opts.npm, encodeFunctionData({
    abi: CL_NPM_ABI, functionName: 'mint', args: [{
      token0: A.weth, token1: A.usdc, tickSpacing: opts.tickSpacing,
      tickLower: opts.tickLower, tickUpper: opts.tickUpper,
      amount0Desired: opts.amount0, amount1Desired: opts.amount1,
      amount0Min: 0n, amount1Min: 0n, recipient: ctx.wallet.address,
      deadline, sqrtPriceX96: 0n,
    }],
  }));
  const n = await read<bigint>(rpcUrl, opts.npm, CL_NPM_ABI, 'balanceOf', [ctx.wallet.address]);
  return read<bigint>(rpcUrl, opts.npm, CL_NPM_ABI, 'tokenOfOwnerByIndex', [ctx.wallet.address, n - 1n]);
}

export async function createLockAndMaybeVote(ctx: FixtureCtx, opts: { aero: bigint; durationSec: bigint; votePool?: Address }): Promise<bigint> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await erc20Approve(rpcUrl, ctx.wallet, AERO_ADDR.aero, AERO_ADDR.votingEscrow, opts.aero);
  await walletSend(rpcUrl, ctx.wallet, AERO_ADDR.votingEscrow, encodeFunctionData({
    abi: VOTING_ESCROW_ABI, functionName: 'createLock', args: [opts.aero, opts.durationSec],
  }));
  const tokenId = await read<bigint>(rpcUrl, AERO_ADDR.votingEscrow, VOTING_ESCROW_ABI, 'ownerToNFTokenIdList', [ctx.wallet.address, 0n]);
  if (opts.votePool) {
    await walletSend(rpcUrl, ctx.wallet, AERO_ADDR.voter, encodeFunctionData({
      abi: VOTER_ABI, functionName: 'vote', args: [tokenId, [opts.votePool], [100n]],
    }));
  }
  return tokenId;
}

const WEEK = 7 * 24 * 3600;
/** Seconds from `now` to (start of next epoch + offset). */
export function secondsToNextEpoch(now: number, offsetSec: number): number {
  const nextFlip = (Math.floor(now / WEEK) + 1) * WEEK;
  return nextFlip - now + offsetSec;
}

export async function veState(rpcUrl: string, wallet: Wallet): Promise<{ count: bigint; tokenId: bigint; amount: bigint; end: bigint; isPermanent: boolean; power: bigint } | null> {
  const count = await read<bigint>(rpcUrl, AERO_ADDR.votingEscrow, VOTING_ESCROW_ABI, 'balanceOf', [wallet.address]);
  if (count === 0n) return null;
  const tokenId = await read<bigint>(rpcUrl, AERO_ADDR.votingEscrow, VOTING_ESCROW_ABI, 'ownerToNFTokenIdList', [wallet.address, 0n]);
  const l = await read<readonly [bigint, bigint, boolean]>(rpcUrl, AERO_ADDR.votingEscrow, VOTING_ESCROW_ABI, 'locked', [tokenId]);
  const power = await read<bigint>(rpcUrl, AERO_ADDR.votingEscrow, VOTING_ESCROW_ABI, 'balanceOfNFT', [tokenId]);
  return { count, tokenId, amount: l[0], end: l[1], isPermanent: l[2], power };
}

export async function votesOn(rpcUrl: string, tokenId: bigint, pool: Address): Promise<bigint> {
  return read<bigint>(rpcUrl, AERO_ADDR.voter, VOTER_ABI, 'votes', [tokenId, pool]);
}
export async function usedWeights(rpcUrl: string, tokenId: bigint): Promise<bigint> {
  return read<bigint>(rpcUrl, AERO_ADDR.voter, VOTER_ABI, 'usedWeights', [tokenId]);
}
export const AERO = (n: number): bigint => ETH(n);
