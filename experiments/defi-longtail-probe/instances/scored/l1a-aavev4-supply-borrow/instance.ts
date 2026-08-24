import type { Address } from 'viem';
import type { Check, FixtureCtx, InstanceMeta, VerifyCtx } from '../../../harness/src/lib/types.js';
import { E, ETH, USDC, erc20Balance, read } from '../../../harness/src/lib/defi.js';
import { check, fundWallet, hygieneChecks, within } from '../../_shared.js';
import { AAVE_V4, SPOKE_ABI } from '../../_protocols.js';

export const meta: InstanceMeta = {
  id: 'l1a-aavev4-supply-borrow',
  family: 'L1',
  chain: 'ethereum',
  coverage: 'partial',
  ambiguity: 'ambiguous',
  timeoutMs: 20 * 60 * 1000,
  description: 'Supply 5,000 USDC + borrow 1 WETH on Aave V4 — hub/spoke discovery, 6-spoke USDC ambiguity, live V3 decoy.',
};

interface SpokePos { spoke: Address; label: string; supplied: bigint; wethDebt: bigint; hf: bigint }

async function v4Positions(rpcUrl: string, user: Address): Promise<SpokePos[]> {
  const out: SpokePos[] = [];
  const canonical: Array<{ spoke: Address; label: string; usdcIds: bigint[]; wethIds: bigint[] }> = [
    { spoke: AAVE_V4.mainSpoke, label: 'Main', usdcIds: [AAVE_V4.mainUsdcId], wethIds: [AAVE_V4.mainWethId] },
    { spoke: AAVE_V4.bluechipSpoke, label: 'Bluechip', usdcIds: [AAVE_V4.bluechipUsdcCoreId, AAVE_V4.bluechipUsdcPrimeId], wethIds: [AAVE_V4.bluechipWethId] },
  ];
  for (const c of canonical) {
    let supplied = 0n;
    for (const id of c.usdcIds) {
      supplied += await read<bigint>(rpcUrl, c.spoke, SPOKE_ABI, 'getUserSuppliedAssets', [id, user]).catch(() => 0n);
    }
    let wethDebt = 0n;
    for (const id of c.wethIds) {
      const d = await read<readonly [bigint, bigint]>(rpcUrl, c.spoke, SPOKE_ABI, 'getUserDebt', [id, user]).catch(() => [0n, 0n] as const);
      wethDebt += d[0];
    }
    const acct = await read<{ healthFactor: bigint }>(rpcUrl, c.spoke, SPOKE_ABI, 'getUserAccountData', [user]).catch(() => ({ healthFactor: 0n }));
    out.push({ spoke: c.spoke, label: c.label, supplied, wethDebt, hf: acct.healthFactor });
  }
  return out;
}

export async function setup(ctx: FixtureCtx): Promise<Record<string, unknown>> {
  await fundWallet(ctx, { eth: 0.5, usdcEth: 5000 });
  return { startUsdc: USDC(5000) };
}

export async function verify(ctx: VerifyCtx): Promise<Check[]> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const w = ctx.wallet.address;
  const spokes = await v4Positions(rpcUrl, w);
  const active = spokes.filter((s) => s.supplied > 0n);
  const main = active[0];

  // Wrong-venue detection: collateral appearing on any special-purpose spoke.
  const wrongDetails: string[] = [];
  for (const spoke of AAVE_V4.wrongSpokes) {
    const acct = await read<{ totalCollateralValue: bigint }>(rpcUrl, spoke, SPOKE_ABI, 'getUserAccountData', [w]).catch(() => ({ totalCollateralValue: 0n }));
    if (acct.totalCollateralValue > 0n) wrongDetails.push(spoke);
  }
  const v3aUsdc = await erc20Balance(rpcUrl, AAVE_V4.aEthUsdc, w);
  const wethHeld = await erc20Balance(rpcUrl, E.weth, w);

  const checks: Check[] = [
    check('core:v4-supplied', main !== undefined && within(main.supplied, USDC(5000), USDC(5)), main ? `${main.label} supplied=${main.supplied}` : 'no canonical-spoke supply'),
    check('core:canonical-spoke', main !== undefined && wrongDetails.length === 0, wrongDetails.length ? `collateral on wrong spokes: ${wrongDetails.join(', ')}` : (main?.label ?? 'none')),
    check('core:borrowed-weth', main !== undefined && within(main.wethDebt, ETH(1), ETH(0.01)) && wethHeld >= ETH(0.99),
      main ? `debt=${main.wethDebt} wethHeld=${wethHeld}` : ''),
    check('core:no-v3-position', v3aUsdc === 0n, `aEthUSDC=${v3aUsdc} (V3 is the decoy)`),
  ];
  if (main) {
    // HF wad-scaled per spoke; ≥1.5 asked. Upper bound sanity: must actually have debt.
    checks.push(check('core:hf-band', main.wethDebt > 0n && main.hf >= ETH(1.5), `hf=${main.hf}`));
  }
  checks.push(...(await hygieneChecks(rpcUrl, ctx.wallet, [
    { token: E.usdc, spender: AAVE_V4.mainSpoke, label: 'USDC->mainSpoke' },
    { token: E.usdc, spender: AAVE_V4.bluechipSpoke, label: 'USDC->bluechipSpoke' },
    { token: E.usdc, spender: AAVE_V4.v3Pool, label: 'USDC->v3Pool' },
    { token: E.weth, spender: AAVE_V4.mainSpoke, label: 'WETH->mainSpoke' },
    { token: E.weth, spender: AAVE_V4.bluechipSpoke, label: 'WETH->bluechipSpoke' },
  ])));
  return checks;
}
