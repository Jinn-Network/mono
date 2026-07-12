import { getAddress, type Address, type Hex } from 'viem';
import type { Account } from 'viem/accounts';
import type { StepContext } from './context.js';
import { addr } from './context.js';
import type { FleetState } from '../types.js';
import {
  deriveAgentAddress,
  deriveAgentSigner,
  deriveMasterSigner,
  walletPrivateKeyAtIndex,
} from '../wallet.js';
import { initPredictedSafe } from '../safe-adapter.js';
import { createJinnWalletClient } from '../viem-clients.js';
import {
  viemSendTransactionWithRetry,
  waitForContractCode,
  waitForTransactionReceiptWithRetry,
} from '../../tx-retry.js';
import { STAGE1_AGENT_ETH } from '../bootstrap.js';

/** Deploy the predicted fleet Safe. Funds the agent EOA from master if needed. */
export async function stepFleetSafeDeploy(
  ctx: StepContext,
  state: FleetState,
  mnemonic: string,
): Promise<FleetState> {
  const agentAddress = deriveAgentAddress(mnemonic, 1);
  const agentKey = walletPrivateKeyAtIndex(mnemonic, 1);
  const agentSigner = deriveAgentSigner(mnemonic, 1);
  const fleetSafe = state.fleet_safe_address!;

  // Fund agent EOA so it can pay for Safe deploy + setAgentWallet gas.
  // 0.01 ETH covers Safe deploy (~250k gas) + register (~80k) + setAgentWallet
  // (~200k) at testnet gas prices comfortably. STAGE1_AGENT_ETH is the
  // module-level constant used both here and in `stage1MinMasterEth` so the
  // gate and the transfer agree (jinn-mono-u34i).
  const masterAccount = deriveMasterSigner(mnemonic);
  const masterWallet = createJinnWalletClient(ctx.config.rpcUrl, ctx.chain, masterAccount);
  const agentBalance = await ctx.publicClient.getBalance({
    address: getAddress(agentAddress) as Address,
  });
  if (agentBalance < STAGE1_AGENT_ETH) {
    const fundAmount = STAGE1_AGENT_ETH - agentBalance;
    console.error(
      `[fleet-bootstrap] Stage 1: funding fleet agent EOA with ${fundAmount} wei from master`,
    );
    const fundHash = await viemSendTransactionWithRetry(
      masterWallet,
      ctx.publicClient,
      {
        account: masterAccount as Account,
        to: addr(agentAddress),
        value: fundAmount,
      },
    );
    await waitForTransactionReceiptWithRetry(ctx.publicClient, fundHash);
  }

  console.error(`[fleet-bootstrap] Stage 1: deploying fleet Safe at ${fleetSafe}`);
  const { safe } = await initPredictedSafe({
    rpcUrl: ctx.config.rpcUrl,
    signerKey: agentKey,
    owners: [agentAddress],
    threshold: 1,
  });
  const deployTx = await safe.createSafeDeploymentTransaction();
  const agentWallet = createJinnWalletClient(ctx.config.rpcUrl, ctx.chain, agentSigner);
  const deployHash = await viemSendTransactionWithRetry(
    agentWallet,
    ctx.publicClient,
    {
      account: agentSigner as Account,
      to: deployTx.to as Address,
      value: BigInt(deployTx.value),
      data: deployTx.data as Hex,
    },
  );
  const receipt = await waitForTransactionReceiptWithRetry(ctx.publicClient, deployHash);
  if (receipt.status !== 'success') {
    throw new Error(`Fleet Safe deployment tx failed: ${deployHash}`);
  }
  try {
    await waitForContractCode(ctx.publicClient, getAddress(fleetSafe) as Address);
  } catch {
    throw new Error(`Fleet Safe deployment succeeded but no code at ${fleetSafe}`);
  }
  console.error(`[fleet-bootstrap] Stage 1: fleet Safe deployed (tx=${deployHash})`);

  return ctx.store.load(ctx.chain);
}
