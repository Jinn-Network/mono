import { encodeFunctionData, parseAbi, type Address } from 'viem';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { E, ETH, WETH_ABI, erc20Balance, read, walletSend } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks } from '../../_shared.js';
import { TWYNE, TWYNE_FACTORY_ABI, TWYNE_VAULT_ABI, TWYNE_VIEWER_ABI } from '../../_protocols.js';
import { plainEulerLiqMaxUsdc, prefundCreditLp } from '../../_twyne.js';

export const meta: InstanceMeta = {
  id: 'l3a-twyne-boosted-borrow',
  family: 'L3',
  chain: 'ethereum',
  coverage: 'none',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Boosted borrow via Twyne: 0.5 WETH collateral, borrow USDC above the plain-Euler ceiling — collateral-vault creation + automatic credit reservation.',
};

const CHAINLINK_ABI = parseAbi(['function latestAnswer() view returns (int256)']);

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await prefundCreditLp(rpcUrl, ETH(5)); // delegatable credit for the boost
  await fundWallet(ctx, { eth: 0.9 });
  await walletSend(rpcUrl, ctx.wallet, E.weth, encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), ETH(0.5));
  const price8 = await read<bigint>(rpcUrl, E.chainlinkEthUsd, CHAINLINK_ABI, 'latestAnswer', []);
  const plainMax = await plainEulerLiqMaxUsdc(rpcUrl, ETH(0.5), price8);
  return { plainEulerLiqMaxUsdc: plainMax, ethUsdPrice8: price8 };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const plainMax = BigInt(ctx.groundTruth.plainEulerLiqMaxUsdc as string | bigint);
  const vaults = await read<Address[]>(rpcUrl, TWYNE.factory, TWYNE_FACTORY_ABI, 'getCollateralVaults', [w]);
  const vault = vaults[vaults.length - 1];

  const checks: Check[] = [
    check('core:vault-created', vaults.length >= 1, `vaults=${vaults.length}`),
  ];
  if (vault) {
    const debt = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'maxRepay', []).catch(() => 0n);
    const reserved = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'maxRelease', []).catch(() => 0n);
    const usdcHeld = await erc20Balance(rpcUrl, E.usdc, w);
    const health = await read<readonly [bigint, bigint, bigint, bigint]>(rpcUrl, TWYNE.viewer, TWYNE_VIEWER_ABI, 'health', [vault]).catch(() => undefined);
    checks.push(check('core:borrowed', debt > 0n && usdcHeld >= debt - 10n ** 6n, `debt=${debt} usdcHeld=${usdcHeld}`));
    checks.push(check('core:credit-reserved', reserved > 0n, `maxRelease=${reserved} (0 ⇒ no delegated credit drawn ⇒ no boost)`));
    checks.push(check('core:boosted-above-euler-max', debt > plainMax,
      `debt=${debt} plainEulerLiqMax=${plainMax} — must exceed what Euler alone permits at its liquidation LTV`));
    checks.push(check('core:healthy', health !== undefined && health[1] > 10n ** 18n,
      health ? `extHF=${health[0]} inHF=${health[1]}` : 'health read failed'));
  }
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: E.weth, spender: TWYNE.eulerEWeth, label: 'WETH->eulerEWeth' },
    { token: E.usdc, spender: TWYNE.eulerEUsdc, label: 'USDC->eulerEUsdc' },
  ], vault ? [vault as Address] : [])));
  return checks;
}
