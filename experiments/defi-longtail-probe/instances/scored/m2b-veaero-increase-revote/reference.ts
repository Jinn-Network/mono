import { encodeFunctionData, type Address } from 'viem';
import { erc20Approve, read, walletSend } from '../../../harness/src/lib/defi.js';
import type { FixtureCtx } from '../../../harness/src/lib/types.js';
import { AERO_ADDR, VOTER_ABI, VOTING_ESCROW_ABI } from '../../_protocols.js';
import { AERO } from '../../_aero.js';

/** Reference: increaseAmount on the existing tokenId, then vote the v2 AERO/USDC pool. */
export async function solve(ctx: FixtureCtx): Promise<void> {
  const rpcUrl = ctx.anvil.rpcUrl;
  const tokenId = await read<bigint>(rpcUrl, AERO_ADDR.votingEscrow, VOTING_ESCROW_ABI, 'ownerToNFTokenIdList', [ctx.wallet.address, 0n]);
  await erc20Approve(rpcUrl, ctx.wallet, AERO_ADDR.aero, AERO_ADDR.votingEscrow, AERO(500));
  await walletSend(rpcUrl, ctx.wallet, AERO_ADDR.votingEscrow, encodeFunctionData({
    abi: VOTING_ESCROW_ABI, functionName: 'increaseAmount', args: [tokenId, AERO(500)],
  }));
  const { V2_FACTORY_ABI } = await import('../../_protocols.js');
  const { A } = await import('../../../harness/src/lib/defi.js');
  const vamm = await read<Address>(rpcUrl, AERO_ADDR.v2Factory, V2_FACTORY_ABI, 'getPool', [AERO_ADDR.aero, A.usdc, false]);
  await walletSend(rpcUrl, ctx.wallet, AERO_ADDR.voter, encodeFunctionData({
    abi: VOTER_ABI, functionName: 'vote', args: [tokenId, [vamm], [100n]],
  }));
}
