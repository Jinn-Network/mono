import { encodeFunctionData, getAddress, type Hex } from 'viem';
import type { Account } from 'viem/accounts';
import type { StepContext } from './context.js';
import { addr } from './context.js';
import type { FleetState } from '../types.js';
import { deriveAgentSigner } from '../wallet.js';
import { createJinnWalletClient } from '../viem-clients.js';
import {
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
} from '../../tx-retry.js';
import { IDENTITY_REGISTRY_ABI, IDENTITY_REGISTRY_ADDRESSES } from '../contracts.js';

/** Mint the fleet agentId + bind Safe via setAgentWallet (ERC-1271). */
export async function stepFleetIdentityRegister(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
): Promise<FleetState> {
  const identityRegistry =
    ctx.config.identityRegistry ?? IDENTITY_REGISTRY_ADDRESSES[ctx.config.chainId];
  if (!identityRegistry) {
    throw new Error(
      `IdentityRegistry address not configured for chainId=${ctx.config.chainId}.`,
    );
  }

  const fleetSafe = state.fleet_safe_address!;
  const agentSigner = deriveAgentSigner(mnemonic, 1);
  const agentWallet = createJinnWalletClient(ctx.config.rpcUrl, ctx.chain, agentSigner);

  // Mint agentId — empty agent URI for v0 (matches stepRegisterAgent §6.1 in spec).
  const registerData = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [''],
  }) as Hex;

  console.error(
    `[fleet-bootstrap] Stage 1: minting fleet agentId ` +
      `(IdentityRegistry=${identityRegistry}, agentEOA=${agentSigner.address})`,
  );
  const mintTxHash = await viemSendTransactionWithRetry(
    agentWallet,
    ctx.publicClient,
    {
      account: agentSigner as Account,
      to: addr(identityRegistry),
      data: registerData,
    },
  );
  const mintReceipt = await waitForTransactionReceiptWithRetry(ctx.publicClient, mintTxHash);
  if (mintReceipt.status !== 'success') {
    throw new Error(`Fleet IdentityRegistry.register() failed: ${mintTxHash}`);
  }
  const fleetAgentId = ctx.parseAgentIdFromReceipt(mintReceipt, identityRegistry);
  if (fleetAgentId === null) {
    throw new Error(
      `Fleet IdentityRegistry.register() succeeded but Registered event missing (tx=${mintTxHash})`,
    );
  }

  // Persist agentId IMMEDIATELY so a crash between mint and bind doesn't lose it.
  await ctx.store.patchFleet({
    fleet_agent_id: fleetAgentId,
    fleet_identity_registry: getAddress(identityRegistry),
  });

  // Bind the Safe via setAgentWallet (ERC-1271).
  // Wrapped in the freshly-deployed-Safe retry (jinn-mono-k1ng). The
  // pre-k1ng single-attempt version halted bootstrap when the documented
  // race fired on the first attempt — exactly the 2026-05-18 canary's
  // second-time-around failure mode.
  console.error(
    `[fleet-bootstrap] Stage 1: binding fleet Safe ${fleetSafe} to agentId=${fleetAgentId}`,
  );
  const bindResult = await ctx.bindAgentWalletWithRetry(
    {
      identityRegistryAddress: addr(identityRegistry),
      agentId: BigInt(fleetAgentId),
      safeAddress: addr(fleetSafe),
      agentEoaAccount: agentSigner,
      agentEoaWalletClient: agentWallet,
      publicClient: ctx.publicClient,
      chainId: ctx.config.chainId,
    },
    'Stage 1',
  );
  if (!bindResult.ok) {
    const bindErr = bindResult.error;
    throw new Error(
      `Fleet setAgentWallet failed after ${ctx.safeBindingMaxAttempts} attempts: ${bindErr.shortMessage}` +
        (bindErr.revertReason ? ` (revert: ${bindErr.revertReason})` : ''),
    );
  }
  console.error(
    `[fleet-bootstrap] Stage 1: setAgentWallet succeeded (tx=${bindResult.txHash})`,
  );

  return ctx.store.patchFleet({ fleet_stage: 'stage1' });
}
