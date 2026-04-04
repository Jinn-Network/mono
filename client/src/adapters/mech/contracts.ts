import {
  encodeFunctionData,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Log,
} from 'viem';
import { MECH_MARKETPLACE_ABI, MECH_ABI, JINN_ROUTER_ABI, CLAIM_REGISTRY_ABI, NATIVE_PAYMENT_TYPE } from './types.js';
import { executeSafeTransaction } from './safe.js';

export async function submitRestorationJob(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  mechAddress: Address,
  requestDataHex: Hex,
  priceWei: bigint,
  responseTimeout: bigint,
): Promise<string[]> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'createRestorationJob',
    args: [requestDataHex, mechAddress, priceWei, responseTimeout, NATIVE_PAYMENT_TYPE, '0x' as Hex],
  });

  const txHash = await executeSafeTransaction(publicClient, walletClient, {
    safeAddress,
    to: routerAddress,
    value: priceWei,
    data: calldata,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const requestIds: string[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'RestorationJobCreated') {
        const args = decoded.args as { requestId: Hex };
        requestIds.push(String(args.requestId));
      }
    } catch {
      // Not our event
    }
  }

  return requestIds;
}

export async function submitEvaluationJob(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  restorationRequestId: Hex,
  mechAddress: Address,
  requestDataHex: Hex,
  priceWei: bigint,
  responseTimeout: bigint,
): Promise<string[]> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'createEvaluationJob',
    args: [restorationRequestId, requestDataHex, mechAddress, priceWei, responseTimeout, NATIVE_PAYMENT_TYPE, '0x' as Hex],
  });

  const txHash = await executeSafeTransaction(publicClient, walletClient, {
    safeAddress,
    to: routerAddress,
    value: priceWei,
    data: calldata,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  const requestIds: string[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'EvaluationJobCreated') {
        const args = decoded.args as { requestId: Hex };
        requestIds.push(String(args.requestId));
      }
    } catch {
      // Not our event
    }
  }

  return requestIds;
}

const CLAIM_RETRY_ATTEMPTS = 3;
const CLAIM_RETRY_DELAY_MS = 2000;

export async function claimDelivery(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  requestId: Hex,
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'claimDelivery',
    args: [requestId],
  });

  for (let attempt = 1; attempt <= CLAIM_RETRY_ATTEMPTS; attempt++) {
    try {
      return await executeSafeTransaction(publicClient, walletClient, {
        safeAddress,
        to: routerAddress,
        value: 0n,
        data: calldata,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // AlreadyClaimed — idempotent, treat as success
      if (message.includes('AlreadyClaimed')) {
        console.error(`[router] claimDelivery: already claimed ${requestId}`);
        return '0x' as Hex;
      }

      // RequestNotFound — not a router request, skip entirely
      if (message.includes('RequestNotFound')) {
        throw err;
      }

      // NotDelivered — marketplace state may not have settled yet, retry
      if (message.includes('NotDelivered') && attempt < CLAIM_RETRY_ATTEMPTS) {
        console.error(`[router] claimDelivery: not yet delivered, retry ${attempt}/${CLAIM_RETRY_ATTEMPTS}`);
        await new Promise(r => setTimeout(r, CLAIM_RETRY_DELAY_MS));
        continue;
      }

      throw err;
    }
  }

  throw new Error(`claimDelivery failed after ${CLAIM_RETRY_ATTEMPTS} attempts for ${requestId}`);
}

// ── ClaimRegistry helpers ──────────────────────────────────────────────────

export async function claimJob(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  claimRegistryAddress: Address,
  requestId: Hex,
): Promise<string> {
  const data = encodeFunctionData({
    abi: CLAIM_REGISTRY_ABI,
    functionName: 'claimJob',
    args: [requestId],
  });

  try {
    const txHash = await executeSafeTransaction(
      publicClient, walletClient,
      { safeAddress, to: claimRegistryAddress, value: 0n, data },
    );
    await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
    return txHash;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('JobAlreadyClaimed')) {
      return ''; // Already claimed by someone else
    }
    if (message.includes('IneligibleToClaim')) {
      return ''; // Not eligible
    }
    if (message.includes('GS013') || message.includes('execution reverted')) {
      // Safe execution failed (inner call reverted) — treat as claim failure
      return '';
    }
    throw err;
  }
}

export async function getJobClaim(
  publicClient: PublicClient,
  claimRegistryAddress: Address,
  requestId: Hex,
): Promise<{ claimer: Address; expiresAt: bigint }> {
  const result = await publicClient.readContract({
    address: claimRegistryAddress,
    abi: CLAIM_REGISTRY_ABI,
    functionName: 'getJobClaim',
    args: [requestId],
  }) as [Address, bigint];

  return { claimer: result[0], expiresAt: result[1] };
}

export async function getMechDeliveryRate(
  publicClient: PublicClient,
  mechAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: mechAddress,
    abi: MECH_ABI,
    functionName: 'maxDeliveryRate',
  }) as Promise<bigint>;
}

export async function getTimeoutBounds(
  publicClient: PublicClient,
  marketplaceAddress: Address,
): Promise<{ min: bigint; max: bigint }> {
  const [min, max] = await Promise.all([
    publicClient.readContract({
      address: marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'minResponseTimeout',
    }) as Promise<bigint>,
    publicClient.readContract({
      address: marketplaceAddress,
      abi: MECH_MARKETPLACE_ABI,
      functionName: 'maxResponseTimeout',
    }) as Promise<bigint>,
  ]);
  return { min, max };
}

export async function pollDeliverEvents(
  publicClient: PublicClient,
  mechAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  return publicClient.getLogs({
    address: mechAddress,
    fromBlock,
    toBlock,
  });
}

// ── Router event scanning (for crash recovery) ──────────────────────────────

export interface RestorationJobRecord {
  requestId: string;
  creator: string;
}

export interface EvaluationJobRecord {
  requestId: string;
  restorationRequestId: string;
  creator: string;
}

export async function scanRestorationJobs(
  publicClient: PublicClient,
  routerAddress: Address,
  creator: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RestorationJobRecord[]> {
  const results: RestorationJobRecord[] = [];
  const chunkSize = 9999n;

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    const logs = await publicClient.getLogs({
      address: routerAddress,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: JINN_ROUTER_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'RestorationJobCreated') {
          const args = decoded.args as { creator: Address; requestId: Hex };
          if (args.creator.toLowerCase() === creator.toLowerCase()) {
            results.push({ requestId: String(args.requestId), creator: String(args.creator) });
          }
        }
      } catch {}
    }
  }

  return results;
}

export async function scanEvaluationJobs(
  publicClient: PublicClient,
  routerAddress: Address,
  creator: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<EvaluationJobRecord[]> {
  const results: EvaluationJobRecord[] = [];
  const chunkSize = 9999n;

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    const logs = await publicClient.getLogs({
      address: routerAddress,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: JINN_ROUTER_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'EvaluationJobCreated') {
          const args = decoded.args as { creator: Address; requestId: Hex; restorationRequestId: Hex };
          if (args.creator.toLowerCase() === creator.toLowerCase()) {
            results.push({
              requestId: String(args.requestId),
              restorationRequestId: String(args.restorationRequestId),
              creator: String(args.creator),
            });
          }
        }
      } catch {}
    }
  }

  return results;
}

// ── Event decoding helpers ───────────────────────────────────────────────────

export interface DecodedMarketplaceRequest {
  requestId: string;
  requestDataHex: string;
  priorityMech: string;
}

export function decodeMarketplaceRequestLogs(logs: Log[]): DecodedMarketplaceRequest[] {
  const results: DecodedMarketplaceRequest[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: MECH_MARKETPLACE_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'MarketplaceRequest') {
        const args = decoded.args as {
          priorityMech: string;
          requestIds: readonly Hex[];
          requestDatas: readonly Hex[];
        };
        for (let i = 0; i < args.requestIds.length; i++) {
          results.push({
            requestId: String(args.requestIds[i]),
            requestDataHex: String(args.requestDatas[i]),
            priorityMech: String(args.priorityMech),
          });
        }
      }
    } catch {
      // Not a MarketplaceRequest event — skip
    }
  }
  return results;
}

export interface DecodedDeliverEvent {
  requestId: string;
  deliveryDataHex: string;
  mechAddress: string;
}

export function decodeDeliverLogs(logs: Log[]): DecodedDeliverEvent[] {
  const results: DecodedDeliverEvent[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: MECH_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'Deliver') {
        const args = decoded.args as {
          mech: Address;
          mechServiceMultisig: Address;
          requestId: Hex;
          deliveryRate: bigint;
          data: Hex;
        };
        results.push({
          requestId: String(args.requestId),
          deliveryDataHex: String(args.data),
          mechAddress: String(args.mechServiceMultisig),
        });
      }
    } catch {
      // Not a Deliver event — skip
    }
  }
  return results;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export async function callDeliverToMarketplace(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  mechContractAddress: Address,
  requestIds: Hex[],
  datas: Hex[],
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: MECH_ABI,
    functionName: 'deliverToMarketplace',
    args: [requestIds, datas],
  });

  return executeSafeTransaction(publicClient, walletClient, {
    safeAddress,
    to: mechContractAddress,
    value: 0n,
    data: calldata,
  });
}
