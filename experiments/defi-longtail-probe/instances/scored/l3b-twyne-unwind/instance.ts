import { encodeFunctionData, type Address } from 'viem';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { E, ETH, WETH_ABI, erc20Balance, read, walletSend } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { TWYNE, TWYNE_FACTORY_ABI, TWYNE_VAULT_ABI } from '../../_protocols.js';
import { openBoostedPosition, prefundCreditLp } from '../../_twyne.js';

export const meta: InstanceMeta = {
  id: 'l3b-twyne-unwind',
  family: 'L3',
  chain: 'ethereum',
  coverage: 'none',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Unwind a live Twyne boosted position completely — repay ordering across the delegation layer, credit release, no stranded dust.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await prefundCreditLp(rpcUrl, ETH(5));
  await fundWallet(ctx, { eth: 0.9, usdcEth: 50 }); // +50 USDC buffer for interest on repay
  await walletSend(rpcUrl, ctx.wallet, E.weth, encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), ETH(0.5));
  // Boosted sizing mirrors the l3a reference: 0.89×C×price, above the 0.86 plain-Euler
  // liquidation ceiling, below the ~0.918 boosted Euler-borrow ceiling.
  const { plainEulerLiqMaxUsdc } = await import('../../_twyne.js');
  const { parseAbi } = await import('viem');
  const price8 = await (await import('../../../harness/src/lib/defi.js')).read<bigint>(
    rpcUrl, E.chainlinkEthUsd, parseAbi(['function latestAnswer() view returns (int256)']), 'latestAnswer', []);
  const plainMax = await plainEulerLiqMaxUsdc(rpcUrl, ETH(0.5), price8);
  const vault = await openBoostedPosition(ctx, { wethIn: ETH(0.5), usdcBorrow: (plainMax * 89n) / 86n, liqLtv: 9400n });
  return { vault, borrowed: (plainMax * 89n) / 86n };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const vault = ctx.groundTruth.vault as Address;
  const debt = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'maxRepay', []).catch(() => 0n);
  const reserved = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'maxRelease', []).catch(() => 0n);
  const totalDeposited = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'totalAssetsDepositedOrReserved', []).catch(() => 0n);
  const weth = await erc20Balance(rpcUrl, E.weth, w);
  const usdc = await erc20Balance(rpcUrl, E.usdc, w);

  const checks: Check[] = [
    check('core:debt-cleared', debt === 0n, `maxRepay=${debt}`),
    // The invariant reserves credit proportional to residual collateral (×~0.093),
    // so wei-dust collateral implies wei-dust reserved credit — tolerance 1e11
    // (≈$2e-7), three orders below any meaningful reservation.
    check('core:credit-released', reserved <= 10n ** 11n, `maxRelease=${reserved}`),
    check('core:vault-emptied', totalDeposited <= 10n ** 12n, `totalAssetsDepositedOrReserved=${totalDeposited}`),
    // 0.5 WETH back minus the vault's fee siphon on reserved-credit interest (no warp → negligible).
    check('funds:weth-returned', weth >= ETH(0.495), `WETH=${weth}`),
    // Started with 900 borrowed + 50 buffer; repay consumed 900+interest.
    check('funds:usdc-accounting', usdc <= 55n * 10n ** 6n, `USDC residual=${usdc}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: E.usdc, spender: vault, label: 'USDC->vault' },
    { token: E.weth, spender: vault, label: 'WETH->vault' },
  ], [])));
  return checks;
}
