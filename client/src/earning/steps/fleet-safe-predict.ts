import { getAddress } from 'viem';
import type { StepContext } from './context.js';
import type { FleetState } from '../types.js';
import { deriveAgentAddress, walletPrivateKeyAtIndex } from '../wallet.js';
import { initPredictedSafe } from '../safe-adapter.js';

/** Deterministic Safe predict from the HD-index-1 agent EOA. */
export async function stepFleetSafePredict(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
): Promise<FleetState> {
  const agentAddress = deriveAgentAddress(mnemonic, 1);
  const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);

  console.error(
    `[fleet-bootstrap] Stage 1: predicting fleet Safe (owner=${agentAddress})`,
  );
  const { address } = await initPredictedSafe({
    rpcUrl: ctx.config.rpcUrl,
    signerKey: agentKey,
    owners: [agentAddress],
    threshold: 1,
  });

  void state;
  return ctx.store.patchFleet({ fleet_safe_address: getAddress(address) });
}
