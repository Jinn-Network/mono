import { encodeFunctionData } from 'viem';
import { E, USDC, erc20Approve, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { FIRA, FIRA_LENDING_ABI, FIRA_MARKET_PARAMS } from '../../_protocols.js';

/** Reference: approve + supply with the full 7-field params. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  await erc20Approve(rpcUrl, ctx.wallet, E.usdc, FIRA.variableMarket, USDC(10_000));
  await walletSend(rpcUrl, ctx.wallet, FIRA.variableMarket, encodeFunctionData({
    abi: FIRA_LENDING_ABI, functionName: 'supply',
    args: [FIRA_MARKET_PARAMS, USDC(10_000), 0n, ctx.wallet.address, '0x'],
  }));
}
