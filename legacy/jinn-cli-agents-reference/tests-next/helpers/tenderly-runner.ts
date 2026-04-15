import process from 'node:process';
import { Wallet } from 'ethers';
import { createTenderlyClient, ethToWei, type VnetResult } from 'jinn-node/lib/tenderly.js';
import { getServicePrivateKey, getServiceSafeAddress } from 'jinn-node/env/operate-profile.js';

export interface TenderlyContext {
  vnet: VnetResult;
  rpcUrl: string;
  publicRpcUrl?: string;
  fundedAgent: string;
  fundedSafe?: string;
}

export interface TenderlyOptions {
  chainId?: number;
  agentAllowanceEth?: string;
  safeAllowanceEth?: string;
  /**
   * Keeps the Tenderly VNet alive (and leaves RPC env vars pointing to it) when the wrapped
   * function throws, to allow manual debugging.
   */
  keepAliveOnFailure?: boolean;
}

function ensureWalletAddress(): { address: string; privateKey: string } {
  console.log('[tenderly-runner] ensureWalletAddress called, OPERATE_PROFILE_DIR:', process.env.OPERATE_PROFILE_DIR);
  const pk = getServicePrivateKey();
  if (!pk || pk.trim().length === 0) {
    throw new Error(
      'Service private key not found. Ensure OPERATE_PROFILE_DIR points to a valid .operate directory ' +
      'with keys/[agent_address] files, or run conductor-setup.sh to populate test fixtures.'
    );
  }
  const normalized = pk.startsWith('0x') ? pk : `0x${pk}`;
  const wallet = new Wallet(normalized);
  console.log('[tenderly-runner] Resolved wallet address:', wallet.address);
  return { address: wallet.address, privateKey: normalized };
}

function applyRpcEnv(rpcUrl: string, publicRpcUrl?: string) {
  const previous: Record<string, string | undefined> = {
    RPC_URL: process.env.RPC_URL,
    BASE_RPC_URL: process.env.BASE_RPC_URL,
    MECH_RPC_HTTP_URL: process.env.MECH_RPC_HTTP_URL,
    MECHX_CHAIN_RPC: process.env.MECHX_CHAIN_RPC,
    VNET_PUBLIC_RPC_URL: process.env.VNET_PUBLIC_RPC_URL,
  };

  process.env.RPC_URL = rpcUrl;
  process.env.BASE_RPC_URL = rpcUrl;
  process.env.MECH_RPC_HTTP_URL = rpcUrl;
  process.env.MECHX_CHAIN_RPC = rpcUrl;
  if (publicRpcUrl) {
    process.env.VNET_PUBLIC_RPC_URL = publicRpcUrl;
  } else {
    delete process.env.VNET_PUBLIC_RPC_URL;
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function withTenderlyVNet<T>(
  fn: (ctx: TenderlyContext) => Promise<T>,
  options?: TenderlyOptions
): Promise<T> {
  const tenderlyClient = createTenderlyClient();
  
  // Cleanup old/stale vnets before creating a new one to avoid quota issues
  // Only cleanup vnets older than 30 minutes
  try {
    await tenderlyClient.cleanupOldVnets({ maxAgeMs: 30 * 60 * 1000 });
  } catch (err) {
    console.warn('[tenderly-runner] Failed to cleanup old vnets:', (err as Error).message);
  }
  
  const chainId = options?.chainId ?? 8453;
  const vnet = await tenderlyClient.createVnet(chainId);
  const rpcUrl = vnet.adminRpcUrl;
  if (!rpcUrl) {
    await tenderlyClient.deleteVnet(vnet.id);
    throw new Error(`Tenderly VNet ${vnet.id} did not return an admin RPC URL`);
  }

  const agent = ensureWalletAddress();
  const safeAddress = getServiceSafeAddress();

  const agentAllowance = options?.agentAllowanceEth ?? '100';
  console.log(`[tenderly-runner] Funding agent wallet ${agent.address} with ${agentAllowance} ETH`);
  await tenderlyClient.fundAddress(agent.address, ethToWei(agentAllowance), rpcUrl);

  let fundedSafe: string | undefined;
  const safeAllowance = options?.safeAllowanceEth ?? '200';
  if (safeAddress && safeAddress.trim().length > 0) {
    fundedSafe = safeAddress.trim();
    console.log(`[tenderly-runner] Funding safe wallet ${fundedSafe} with ${safeAllowance} ETH`);
    await tenderlyClient.fundAddress(fundedSafe, ethToWei(safeAllowance), rpcUrl);
  }

  process.env.E2E_VNET_ID = vnet.id;
  const revertRpcEnv = applyRpcEnv(rpcUrl, vnet.publicRpcUrl);

  const ctx: TenderlyContext = {
    vnet,
    rpcUrl,
    publicRpcUrl: vnet.publicRpcUrl,
    fundedAgent: agent.address,
    fundedSafe,
  };

  let failed = false;
  try {
    return await fn(ctx);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    const keepAliveEnv = process.env.KEEP_DEBUG_VNET === '1';
    const keepAliveRequested = options?.keepAliveOnFailure ?? keepAliveEnv;
    if (failed && keepAliveRequested) {
      console.warn('[tenderly-runner] KEEP_DEBUG_VNET active - leaving Tenderly VNet running.');
      console.warn(`[tenderly-runner] VNet ID: ${vnet.id} | RPC URL: ${rpcUrl}`);
    } else {
      revertRpcEnv();
      try {
        await tenderlyClient.deleteVnet(vnet.id);
      } catch (error) {
        console.warn(`[tests-next] Failed to delete VNet ${vnet.id}:`, (error as Error).message);
      }
    }
  }
}
