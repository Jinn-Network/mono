import { encodeFunctionData, type Address } from 'viem';
import { E, erc20Approve, read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { TWYNE, TWYNE_FACTORY_ABI, TWYNE_VAULT_ABI } from '../../_protocols.js';

const MAX = 2n ** 256n - 1n;

/** Reference: repay(max) → redeemUnderlying(everything left) — credit release is automatic. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const vaults = await read<Address[]>(rpcUrl, TWYNE.factory, TWYNE_FACTORY_ABI, 'getCollateralVaults', [ctx.wallet.address]);
  const vault = vaults[vaults.length - 1];
  const debt = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'maxRepay', []);
  await erc20Approve(rpcUrl, ctx.wallet, E.usdc, vault, debt + 10n ** 6n);
  await walletSend(rpcUrl, ctx.wallet, vault, encodeFunctionData({
    abi: TWYNE_VAULT_ABI, functionName: 'repay', args: [MAX],
  }));
  const remaining = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'totalAssetsDepositedOrReserved', []);
  const reserved = await read<bigint>(rpcUrl, vault, TWYNE_VAULT_ABI, 'maxRelease', []);
  // Own collateral (in eWETH-share terms) = total minus still-reserved credit; unwrap to WETH.
  // Margin 5e11 wei: reserved-credit interest accrues between these reads and the tx
  // landing, so an exact ask intermittently trips T_WithdrawMoreThanMax. The dust left
  // behind stays under the verifier's 1e12 vault-emptied tolerance.
  await walletSend(rpcUrl, ctx.wallet, vault, encodeFunctionData({
    abi: TWYNE_VAULT_ABI, functionName: 'redeemUnderlying', args: [remaining - reserved - 500_000_000_000n, ctx.wallet.address],
  }));
  // Revoke the repay-buffer allowance residue (hygiene bar the agent is held to).
  await erc20Approve(rpcUrl, ctx.wallet, E.usdc, vault, 0n);
}
