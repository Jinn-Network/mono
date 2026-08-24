import { encodeFunctionData, type Address } from 'viem';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { E, USDC, erc20Approve, erc20Balance, read, walletSend } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks, within } from '../../_shared.js';
import { AAVE_V3_POOL_ABI, AAVE_V4, SPOKE_ABI } from '../../_protocols.js';

export const meta: InstanceMeta = {
  id: 'l1b-aavev4-migrate-v3',
  family: 'L1',
  chain: 'ethereum',
  coverage: 'partial',
  ambiguity: 'unique',
  timeoutMs: 20 * 60 * 1000,
  description: 'Migrate a 5,000 USDC supply from live Aave V3 to V4 — withdraw-then-supply across architectures, no V3 dust.',
};

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await fundWallet(ctx, { eth: 0.5, usdcEth: 5000 });
  await erc20Approve(rpcUrl, ctx.wallet, E.usdc, AAVE_V4.v3Pool, USDC(5000));
  await walletSend(rpcUrl, ctx.wallet, AAVE_V4.v3Pool, encodeFunctionData({
    abi: AAVE_V3_POOL_ABI, functionName: 'supply', args: [E.usdc, USDC(5000), ctx.wallet.address, 0],
  }));
  return { startSupplied: USDC(5000) };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const v3aUsdc = await erc20Balance(rpcUrl, AAVE_V4.aEthUsdc, w);
  const usdcHeld = await erc20Balance(rpcUrl, E.usdc, w);

  const canonical: Array<{ spoke: Address; label: string; usdcIds: bigint[] }> = [
    { spoke: AAVE_V4.mainSpoke, label: 'Main', usdcIds: [AAVE_V4.mainUsdcId] },
    { spoke: AAVE_V4.bluechipSpoke, label: 'Bluechip', usdcIds: [AAVE_V4.bluechipUsdcCoreId, AAVE_V4.bluechipUsdcPrimeId] },
  ];
  let supplied = 0n;
  let where = 'none';
  for (const c of canonical) {
    for (const id of c.usdcIds) {
      const s = await read<bigint>(rpcUrl, c.spoke, SPOKE_ABI, 'getUserSuppliedAssets', [id, w]).catch(() => 0n);
      if (s > 0n) { supplied += s; where = c.label; }
    }
  }
  const wrongDetails: string[] = [];
  for (const spoke of AAVE_V4.wrongSpokes) {
    const acct = await read<{ totalCollateralValue: bigint }>(rpcUrl, spoke, SPOKE_ABI, 'getUserAccountData', [w]).catch(() => ({ totalCollateralValue: 0n }));
    if (acct.totalCollateralValue > 0n) wrongDetails.push(spoke);
  }

  const checks: Check[] = [
    // Interest accrues on V3 between setup and exit — allow +5 USDC on the migrated amount.
    check('core:v4-supplied', within(supplied, USDC(5000), USDC(5)), `supplied=${supplied} on ${where}`),
    check('core:canonical-spoke', supplied > 0n && wrongDetails.length === 0, wrongDetails.join(', ') || where),
    check('core:v3-emptied', v3aUsdc <= USDC(0.01), `aEthUSDC=${v3aUsdc}`),
    check('funds:no-stranded-usdc', usdcHeld <= USDC(1), `wallet USDC=${usdcHeld}`),
  ];
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: E.usdc, spender: AAVE_V4.mainSpoke, label: 'USDC->mainSpoke' },
    { token: E.usdc, spender: AAVE_V4.bluechipSpoke, label: 'USDC->bluechipSpoke' },
    { token: E.usdc, spender: AAVE_V4.v3Pool, label: 'USDC->v3Pool' },
  ], [])));
  return checks;
}
