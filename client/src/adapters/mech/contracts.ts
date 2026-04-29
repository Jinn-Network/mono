import {
  encodeFunctionData,
  decodeEventLog,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Log,
} from 'viem';
import {
  MECH_MARKETPLACE_ABI,
  MECH_ABI,
  JINN_ROUTER_ABI,
  JINN_ROUTER_CLAIM_DELIVERY_V1_ABI,
  JINN_ROUTER_CLAIM_DELIVERY_V2_ABI,
  NATIVE_PAYMENT_TYPE,
  type EvictionRecoveryConfig,
} from './types.js';
import { STAKING_ABI, STOLAS_DISTRIBUTOR_ABI } from '../../earning/contracts.js';
import { isUnauthorizedAccountError } from '../../errors/unauthorized-account.js';
import { CLAIM_REGISTRY_ABI } from '../claim-registry/abi.js';
import { executeSafeTransaction } from './safe.js';
import {
  flattenErrorMessage,
  isRecoverableTransactionError,
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
  backoffDelay,
} from '../../tx-retry.js';

const EVICTED_STAKING_STATE = 2;
const restakeLocks = new Map<string, Promise<void>>();

async function withRestakeLock(key: string, fn: () => Promise<void>): Promise<void> {
  const pending = restakeLocks.get(key) ?? Promise.resolve();

  let releaseLock!: () => void;
  const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
  restakeLocks.set(key, newLock);

  await pending;

  try {
    await fn();
  } finally {
    releaseLock();
    if (restakeLocks.get(key) === newLock) {
      restakeLocks.delete(key);
    }
  }
}

async function readStakingState(
  publicClient: PublicClient,
  recovery: EvictionRecoveryConfig,
): Promise<number> {
  return Number(await publicClient.readContract({
    address: recovery.stakingProxyAddress,
    abi: STAKING_ABI,
    functionName: 'getStakingState',
    args: [BigInt(recovery.serviceId)],
  }));
}

async function restakeEvictedService(
  publicClient: PublicClient,
  recovery: EvictionRecoveryConfig,
  label: string,
): Promise<void> {
  const lockKey = `${recovery.stakingProxyAddress.toLowerCase()}:${recovery.serviceId}`;

  await withRestakeLock(lockKey, async () => {
    const latestState = await readStakingState(publicClient, recovery);
    if (latestState !== EVICTED_STAKING_STATE) {
      console.error(
        `[staking-recovery] ${label}: service ${recovery.serviceId} no longer evicted ` +
        `(state=${latestState}); retrying original action`,
      );
      return;
    }

    const account = recovery.masterWalletClient.account;
    if (!account) {
      throw new Error('Eviction recovery cannot reStake: master wallet client has no account');
    }

    const data = encodeFunctionData({
      abi: STOLAS_DISTRIBUTOR_ABI,
      functionName: 'reStake',
      args: [recovery.stakingProxyAddress, BigInt(recovery.serviceId)],
    });

    console.error(
      `[staking-recovery] ${label}: service ${recovery.serviceId} is evicted; ` +
      `calling distributor.reStake()`,
    );

    let txHash: Hex;
    try {
      txHash = await viemSendTransactionWithRetry(recovery.masterWalletClient, publicClient, {
        account,
        to: recovery.distributorAddress,
        data,
        gas: 1_500_000n,
      });
    } catch (err) {
      const message = flattenErrorMessage(err);
      if (isUnauthorizedAccountError(message)) {
        throw new Error(
          `Service ${recovery.serviceId} is evicted, but the configured master EOA is not authorized to reStake it. ` +
          `Verify JINN_EARNING_DIR and JINN_PASSWORD derive the original master EOA for this service; otherwise request owner / managing-agent recovery. ` +
          `reStake revert: ${message}`,
        );
      }
      throw err;
    }

    const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
      onRetry: ({ attempt, message }) => {
        console.error(`[staking-recovery] wait reStake receipt retry ${attempt}: ${message}`);
      },
    });
    if (receipt.status !== 'success') {
      throw new Error(`reStake failed for service ${recovery.serviceId}: ${txHash}`);
    }

    console.error(
      `[staking-recovery] ${label}: reStake confirmed for service ${recovery.serviceId} ` +
      `(tx=${txHash}); retrying original action`,
    );
  });
}

export async function withEvictionRecovery<T>(
  publicClient: PublicClient,
  recovery: EvictionRecoveryConfig | undefined,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!recovery) throw err;

    let stakingState: number;
    try {
      stakingState = await readStakingState(publicClient, recovery);
    } catch (stateErr) {
      console.error(
        `[staking-recovery] ${label}: could not check staking state after failed action; ` +
        `preserving original error. state check error: ${flattenErrorMessage(stateErr)}`,
      );
      throw err;
    }
    if (stakingState !== EVICTED_STAKING_STATE) {
      throw err;
    }

    await restakeEvictedService(publicClient, recovery, label);
    return action();
  }
}

export async function submitRestorationJob(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  mechAddress: Address,
  requestDataHex: Hex,
  priceWei: bigint,
  responseTimeout: bigint,
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<{ requestIds: string[]; txHash: Hex; receiptLogCount: number }> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'createRestorationJob',
    args: [requestDataHex, mechAddress, priceWei, responseTimeout, NATIVE_PAYMENT_TYPE, '0x' as Hex],
  });

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'createRestorationJob',
    () => executeSafeTransaction(publicClient, walletClient, {
      safeAddress,
      to: routerAddress,
      value: priceWei,
      data: calldata,
    }),
  );

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
    onRetry: ({ attempt, message }) => {
      console.error(`[router] wait restoration receipt retry ${attempt}: ${message}`);
    },
  });

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

  return { requestIds, txHash, receiptLogCount: receipt.logs.length };
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
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<string[]> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'createEvaluationJob',
    args: [restorationRequestId, requestDataHex, mechAddress, priceWei, responseTimeout, NATIVE_PAYMENT_TYPE, '0x' as Hex],
  });

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'createEvaluationJob',
    () => executeSafeTransaction(publicClient, walletClient, {
      safeAddress,
      to: routerAddress,
      value: priceWei,
      data: calldata,
    }),
  );

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
    onRetry: ({ attempt, message }) => {
      console.error(`[router] wait evaluation receipt retry ${attempt}: ${message}`);
    },
  });

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

const CLAIM_RETRY_ATTEMPTS = 6;
const CLAIM_RETRY_DELAY_MS = 2000;

const ZERO_EVIDENCE: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
const JINN_ROUTER_CLAIMED_ABI = [
  {
    name: 'claimed',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface ClaimDeliveryOptions {
  variant: 'v1' | 'v2';
  /** V2 only; ignored for V1. */
  evidenceHash?: Hex;
}

async function isDeliveryAlreadyClaimed(
  publicClient: PublicClient,
  routerAddress: Address,
  requestId: Hex,
): Promise<boolean> {
  return Boolean(await publicClient.readContract({
    address: routerAddress,
    abi: JINN_ROUTER_CLAIMED_ABI,
    functionName: 'claimed',
    args: [requestId],
  }));
}

export async function claimDelivery(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  requestId: Hex,
  options: ClaimDeliveryOptions,
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<Hex> {
  if (await isDeliveryAlreadyClaimed(publicClient, routerAddress, requestId)) {
    console.error(`[router] claimDelivery: already claimed ${requestId}`);
    return '0x' as Hex;
  }

  if (options.variant === 'v2' && !options.evidenceHash) {
    throw new Error(
      `claimDelivery(v2): evidenceHash is required for V2 claim — refusing to write ZERO_EVIDENCE for requestId ${requestId}`,
    );
  }

  const calldata =
    options.variant === 'v2'
      ? encodeFunctionData({
          abi: JINN_ROUTER_CLAIM_DELIVERY_V2_ABI,
          functionName: 'claimDelivery',
          args: [requestId, options.evidenceHash!],
        })
      : encodeFunctionData({
          abi: JINN_ROUTER_CLAIM_DELIVERY_V1_ABI,
          functionName: 'claimDelivery',
          args: [requestId],
        });

  for (let attempt = 1; attempt <= CLAIM_RETRY_ATTEMPTS; attempt++) {
    try {
      return await withEvictionRecovery(
        publicClient,
        evictionRecovery,
        'claimDelivery',
        () => executeSafeTransaction(publicClient, walletClient, {
          safeAddress,
          to: routerAddress,
          value: 0n,
          data: calldata,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // AlreadyClaimed — idempotent, treat as success
      if (message.includes('AlreadyClaimed')) {
        console.error(`[router] claimDelivery: already claimed ${requestId}`);
        return '0x' as Hex;
      }

      if (await isDeliveryAlreadyClaimed(publicClient, routerAddress, requestId)) {
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

      if (isRecoverableTransactionError(err) && attempt < CLAIM_RETRY_ATTEMPTS) {
        console.error(`[router] claimDelivery: transient error, retry ${attempt}/${CLAIM_RETRY_ATTEMPTS}`);
        await backoffDelay(attempt - 1, CLAIM_RETRY_DELAY_MS, 10_000);
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
    await waitForTransactionReceiptWithRetry(publicClient, txHash as Hex, {
      onRetry: ({ attempt, message }) => {
        console.error(`[claim-registry] wait receipt retry ${attempt}: ${message}`);
      },
    });
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
  transactionHash?: `0x${string}`;
  blockNumber?: number;
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
          requestIds: readonly Hex[] | undefined;
          requestDatas: readonly Hex[] | undefined;
        };
        if (!args.requestIds?.length || !args.requestDatas?.length) {
          console.error('[mech] MarketplaceRequest decode missing requestIds/requestDatas', {
            hasRequestIds: args.requestIds != null,
            hasRequestDatas: args.requestDatas != null,
          });
          continue;
        }
        for (let i = 0; i < args.requestIds.length; i++) {
          results.push({
            requestId: String(args.requestIds[i]),
            requestDataHex: String(args.requestDatas[i]),
            priorityMech: String(args.priorityMech),
            transactionHash: log.transactionHash ?? undefined,
            blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
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

const LOG_SCAN_CHUNK = 9999n;

export async function scanLatestRequestDataByRid(
  publicClient: PublicClient,
  marketplaceAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, Hex>> {
  const results = new Map<string, Hex>();
  for (let start = fromBlock; start <= toBlock; start += LOG_SCAN_CHUNK + 1n) {
    const end = start + LOG_SCAN_CHUNK > toBlock ? toBlock : start + LOG_SCAN_CHUNK;
    const logs = await publicClient.getLogs({
      address: marketplaceAddress,
      fromBlock: start,
      toBlock: end,
    });
    for (const decoded of decodeMarketplaceRequestLogs(logs)) {
      results.set(decoded.requestId.toLowerCase(), decoded.requestDataHex as Hex);
    }
  }
  return results;
}

export async function scanLatestDeliveryDataByRid(
  publicClient: PublicClient,
  mechContractAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Map<string, Hex>> {
  const results = new Map<string, Hex>();
  for (let start = fromBlock; start <= toBlock; start += LOG_SCAN_CHUNK + 1n) {
    const end = start + LOG_SCAN_CHUNK > toBlock ? toBlock : start + LOG_SCAN_CHUNK;
    const logs = await publicClient.getLogs({
      address: mechContractAddress,
      fromBlock: start,
      toBlock: end,
    });
    for (const decoded of decodeDeliverLogs(logs)) {
      results.set(decoded.requestId.toLowerCase(), decoded.deliveryDataHex as Hex);
    }
  }
  return results;
}

/**
 * Most recent `requestData` for `requestId` from MarketplaceRequest events on
 * `marketplaceAddress` in [fromBlock, toBlock] (inclusive), by block then log index.
 */
export async function findLatestRequestDataHexForMarketplaceRequest(
  publicClient: PublicClient,
  marketplaceAddress: Address,
  requestId: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Hex | null> {
  const dataByRid = await scanLatestRequestDataByRid(
    publicClient,
    marketplaceAddress,
    fromBlock,
    toBlock,
  );
  return dataByRid.get(requestId.toLowerCase()) ?? null;
}

/**
 * `data` field of the most recent Deliver event for `requestId` on the mech contract
 * in [fromBlock, toBlock] (inclusive).
 */
export async function findLatestDeliveryDataHexForRequest(
  publicClient: PublicClient,
  mechContractAddress: Address,
  requestId: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Hex | null> {
  const dataByRid = await scanLatestDeliveryDataByRid(
    publicClient,
    mechContractAddress,
    fromBlock,
    toBlock,
  );
  return dataByRid.get(requestId.toLowerCase()) ?? null;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

// Error names reported by the Mech Marketplace contract for duplicate delivery.
// The exact name varies across contract versions; we match all known variants.
const ALREADY_DELIVERED_PATTERNS = [
  'AlreadyDelivered',
  'DeliveryAlreadyCompleted',
  'JobAlreadyDelivered',
  'RequestAlreadyDelivered',
];

export async function callDeliverToMarketplace(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  mechContractAddress: Address,
  requestIds: Hex[],
  datas: Hex[],
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: MECH_ABI,
    functionName: 'deliverToMarketplace',
    args: [requestIds, datas],
  });

  try {
    return await withEvictionRecovery(
      publicClient,
      evictionRecovery,
      'deliverToMarketplace',
      () => executeSafeTransaction(publicClient, walletClient, {
        safeAddress,
        to: mechContractAddress,
        value: 0n,
        data: calldata,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Idempotent: if the mech already recorded this delivery (e.g. crash
    // recovery re-entered this path), treat it as success. The tx hash is
    // unavailable at this point, but the engine's deliveryTxHash column would
    // have been set by the previous attempt's onDeliveryTxLanded callback.
    if (ALREADY_DELIVERED_PATTERNS.some(p => message.includes(p))) {
      console.error(`[mech] callDeliverToMarketplace: already delivered (idempotent), requestIds=${requestIds.join(',')}`);
      return '0x' as Hex;
    }
    throw err;
  }
}
