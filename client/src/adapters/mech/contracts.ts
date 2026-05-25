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
import { VerdictCode } from './verdict-code.js';
import { STAKING_ABI, STOLAS_DISTRIBUTOR_ABI } from '../../earning/contracts.js';
import { isUnauthorizedAccountError } from '../../errors/unauthorized-account.js';
import { executeSafeTransaction } from './safe.js';
import { formatKnownRevert, formatKnownRevertDetail } from './safe-revert.js';
import {
  flattenErrorMessage,
  isRecoverableTransactionError,
  viemSendTransactionWithRetry,
  waitForTransactionReceiptWithRetry,
  backoffDelay,
} from '../../tx-retry.js';

const EVICTED_STAKING_STATE = 2;
const restakeLocks = new Map<string, Promise<void>>();

const TASK_COORDINATOR_ABI = [
  {
    name: 'getTask',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [
      {
        name: 'record',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'taskCidDigest', type: 'bytes32' },
          { name: 'manifestDigest', type: 'bytes32' },
          { name: 'status', type: 'uint8' },
          {
            name: 'policy',
            type: 'tuple',
            components: [
              { name: 'claimWindowStart', type: 'uint64' },
              { name: 'claimWindowEnd', type: 'uint64' },
              { name: 'submissionDeadline', type: 'uint64' },
              { name: 'claimLeaseTtlSeconds', type: 'uint32' },
              { name: 'maxClaims', type: 'uint16' },
              { name: 'maxClaimsPerOperator', type: 'uint16' },
              { name: 'policyHook', type: 'address' },
              {
                name: 'evaluationPolicy',
                type: 'tuple',
                components: [
                  { name: 'requiredVerdicts', type: 'uint16' },
                  { name: 'passThreshold', type: 'uint16' },
                  { name: 'evaluationDeadline', type: 'uint64' },
                  { name: 'maxVerdictsPerEvaluator', type: 'uint16' },
                  { name: 'disallowSolverSelfEvaluation', type: 'bool' },
                ],
              },
            ],
          },
          { name: 'claimCount', type: 'uint32' },
          { name: 'submittedCount', type: 'uint32' },
          { name: 'finalizedAttemptCount', type: 'uint32' },
          { name: 'taskCreationCredited', type: 'bool' },
        ],
      },
    ],
  },
] as const;

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

export async function submitTask(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  taskCidDigest: Hex,
  manifestDigest: Hex,
  policy: RouterTaskPolicy,
  solutionMaxDeliveryRateWei: bigint,
  verdictMaxDeliveryRateWei: bigint,
  responseTimeout: bigint,
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<{ taskId: string; txHash: Hex; receiptLogCount: number; blockNumber?: number }> {
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'createTask',
    args: [
      taskCidDigest,
      manifestDigest,
      policy,
      solutionMaxDeliveryRateWei,
      verdictMaxDeliveryRateWei,
      responseTimeout,
    ],
  });
  const taskBudget =
    solutionMaxDeliveryRateWei * BigInt(policy.maxClaims) +
    verdictMaxDeliveryRateWei * BigInt(policy.maxClaims) * BigInt(policy.evaluationPolicy.requiredVerdicts || 1);

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'createTask',
    () => executeSafeTransaction(publicClient, walletClient, {
      safeAddress,
      to: routerAddress,
      value: taskBudget,
      data: calldata,
    }),
  );

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
    onRetry: ({ attempt, message }) => {
      console.error(`[router] wait restoration receipt retry ${attempt}: ${message}`);
    },
  });

  let taskId: string | undefined;
  let blockNumber: number | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'TaskCreated') {
        const args = decoded.args as { taskId: bigint };
        taskId = String(args.taskId);
        blockNumber = log.blockNumber != null ? Number(log.blockNumber) : undefined;
      }
    } catch {
      // Not our event
    }
  }

  if (!taskId) {
    throw new Error(`No TaskCreated event returned from router tx=${txHash}`);
  }

  return { taskId, txHash, receiptLogCount: receipt.logs.length, blockNumber };
}

export interface RouterTaskPolicy {
  claimWindowStart: bigint;
  claimWindowEnd: bigint;
  submissionDeadline: bigint;
  claimLeaseTtlSeconds: number;
  maxClaims: number;
  maxClaimsPerOperator: number;
  policyHook: Address;
  evaluationPolicy: {
    requiredVerdicts: number;
    passThreshold: number;
    evaluationDeadline: bigint;
    maxVerdictsPerEvaluator: number;
    disallowSolverSelfEvaluation: boolean;
  };
}

export async function claimTask(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  taskId: string | bigint,
  priorityMech: Address,
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<{ taskId: string; attemptIndex: number; requestId: string; txHash: Hex; blockNumber?: number }> {
  const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId);
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'claimTask',
    args: [taskIdBigInt, priorityMech],
  });

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'claimTask',
    () => executeSafeTransaction(publicClient, walletClient, {
      safeAddress,
      to: routerAddress,
      value: 0n,
      data: calldata,
    }),
  );

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
    onRetry: ({ attempt, message }) => {
      console.error(`[router] wait claim task receipt retry ${attempt}: ${message}`);
    },
  });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'TaskAttemptCreated') {
        const args = decoded.args as { taskId: bigint; attemptIndex: number; requestId: Hex };
        return {
          taskId: String(args.taskId),
          attemptIndex: Number(args.attemptIndex),
          requestId: String(args.requestId),
          txHash,
          blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
        };
      }
    } catch {
      // Not our event
    }
  }

  throw new Error(`No TaskAttemptCreated event returned from router tx=${txHash}`);
}

export async function canClaimTask(
  publicClient: PublicClient,
  safeAddress: Address,
  routerAddress: Address,
  taskId: string | bigint,
  priorityMech: Address,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId);
  try {
    await publicClient.simulateContract({
      account: safeAddress,
      address: routerAddress,
      abi: JINN_ROUTER_ABI,
      functionName: 'claimTask',
      args: [taskIdBigInt, priorityMech],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: formatKnownRevert(err) ?? flattenErrorMessage(err) };
  }
}

const DUMMY_EVALUATION_TASK_CID_DIGEST =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex;

/**
 * Result of a failed `canClaimEvaluation` simulation.
 *
 * `reason` is the operator-facing formatted revert string (kept for log lines).
 * `revertName` is the *structured* bare revert name decoded straight from the
 * inner revert data — `null` when no known selector could be extracted. Callers
 * deciding whether an opportunity is permanently unclaimable should classify on
 * `revertName` (via `isNonRecoverableInnerRevert`), never by regex-unformatting
 * `reason`.
 */
export interface CanClaimEvaluationFailure {
  ok: false;
  reason: string;
  revertName: string | null;
}

export async function canClaimEvaluation(
  publicClient: PublicClient,
  safeAddress: Address,
  routerAddress: Address,
  taskId: string | bigint,
  attemptIndex: number,
  evaluatorMech: Address,
  evaluationTaskCidDigest: Hex = DUMMY_EVALUATION_TASK_CID_DIGEST,
): Promise<{ ok: true } | CanClaimEvaluationFailure> {
  const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId);
  try {
    await publicClient.simulateContract({
      account: safeAddress,
      address: routerAddress,
      abi: JINN_ROUTER_ABI,
      functionName: 'claimEvaluation',
      args: [taskIdBigInt, attemptIndex, evaluatorMech, evaluationTaskCidDigest],
    });
    return { ok: true };
  } catch (err) {
    const detail = formatKnownRevertDetail(err);
    return {
      ok: false,
      reason: detail?.reason ?? flattenErrorMessage(err),
      revertName: detail?.name ?? null,
    };
  }
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
  variant: 'v1' | 'v2' | 'v3';
  /** V2/V3 only; ignored for V1. */
  evidenceHash?: Hex;
  /** V3 only. Defaults to solution for Task-native V3. */
  kind?: 'solution' | 'verdict';
  /** V3 verdict only. 1=Pass, 2=Fail, 3=Invalid, 4=Unresolved. See VerdictCode. */
  verdictCode?: VerdictCode;
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

  if ((options.variant === 'v2' || options.variant === 'v3') && !options.evidenceHash) {
    throw new Error(
      `claimDelivery(${options.variant}): evidenceHash is required — refusing to write ZERO_EVIDENCE for requestId ${requestId}`,
    );
  }

  const calldata =
    options.variant === 'v3'
      ? encodeFunctionData({
          abi: JINN_ROUTER_ABI,
          functionName: options.kind === 'verdict' ? 'claimVerdictDelivery' : 'claimSolutionDelivery',
          args: options.kind === 'verdict'
            ? (() => {
                if (options.verdictCode === undefined) {
                  throw new Error(
                    `claimDelivery(v3/verdict): verdictCode is required — refusing to write Pass(1) by default for requestId ${requestId}`,
                  );
                }
                return [requestId, options.evidenceHash!, options.verdictCode] as const;
              })()
            : [requestId, options.evidenceHash!],
        })
      : options.variant === 'v2'
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

export async function claimEvaluation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  safeAddress: Address,
  routerAddress: Address,
  taskId: string | bigint,
  attemptIndex: number,
  evaluatorMech: Address,
  evaluationTaskCidDigest: Hex,
  evictionRecovery?: EvictionRecoveryConfig,
): Promise<{ taskId: string; attemptIndex: number; verdictIndex: number; requestId: string; txHash: Hex; blockNumber?: number }> {
  const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId);
  const calldata = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'claimEvaluation',
    args: [taskIdBigInt, attemptIndex, evaluatorMech, evaluationTaskCidDigest],
  });

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'claimEvaluation',
    () => executeSafeTransaction(publicClient, walletClient, {
      safeAddress,
      to: routerAddress,
      value: 0n,
      data: calldata,
    }),
  );

  const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
    onRetry: ({ attempt, message }) => {
      console.error(`[router] wait claim evaluation receipt retry ${attempt}: ${message}`);
    },
  });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'EvaluationAttemptCreated') {
        const args = decoded.args as {
          taskId: bigint;
          attemptIndex: number;
          verdictIndex: number;
          requestId: Hex;
        };
        return {
          taskId: String(args.taskId),
          attemptIndex: Number(args.attemptIndex),
          verdictIndex: Number(args.verdictIndex),
          requestId: String(args.requestId),
          txHash,
          blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
        };
      }
    } catch {
      // Not our event
    }
  }

  throw new Error(`No EvaluationAttemptCreated event returned from router tx=${txHash}`);
}

export async function getTaskCidDigest(
  publicClient: PublicClient,
  routerAddress: Address,
  taskId: string | bigint,
): Promise<Hex> {
  const coordinatorAddress = await publicClient.readContract({
    address: routerAddress,
    abi: JINN_ROUTER_ABI,
    functionName: 'taskCoordinator',
  }) as Address;
  const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId);
  const task = await publicClient.readContract({
    address: coordinatorAddress,
    abi: TASK_COORDINATOR_ABI,
    functionName: 'getTask',
    args: [taskIdBigInt],
  }) as { taskCidDigest: Hex } | readonly unknown[];

  if (Array.isArray(task)) {
    return task[1] as Hex;
  }
  return (task as { taskCidDigest: Hex }).taskCidDigest;
}

export async function getMarketplaceRequestDeliveryMech(
  publicClient: PublicClient,
  marketplaceAddress: Address,
  requestId: string,
): Promise<Address> {
  const info = await publicClient.readContract({
    address: marketplaceAddress,
    abi: MECH_MARKETPLACE_ABI,
    functionName: 'mapRequestIdInfos',
    args: [requestId as Hex],
  }) as { deliveryMech: Address } | readonly unknown[];

  if (Array.isArray(info)) {
    return info[1] as Address;
  }
  return (info as { deliveryMech: Address }).deliveryMech;
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

export interface TaskRecord {
  taskId: string;
  taskCidDigest: string;
  manifestDigest?: string;
  creator: string;
  transactionHash?: `0x${string}`;
  blockNumber?: number;
}

export async function scanTasks(
  publicClient: PublicClient,
  routerAddress: Address,
  creator: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TaskRecord[]> {
  const results: TaskRecord[] = [];
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
        if (decoded.eventName === 'TaskCreated') {
          const args = decoded.args as {
            creator: Address;
            taskId: bigint;
            manifestDigest: Hex;
            taskCidDigest: Hex;
          };
          if (args.creator.toLowerCase() === creator.toLowerCase()) {
            results.push({
              taskId: String(args.taskId),
              taskCidDigest: String(args.taskCidDigest),
              manifestDigest: String(args.manifestDigest),
              creator: String(args.creator),
              transactionHash: log.transactionHash ?? undefined,
              blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
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

export interface DecodedTaskCreated {
  taskId: string;
  taskCidDigest: string;
  manifestDigest: string;
  creator: string;
  transactionHash?: `0x${string}`;
  blockNumber?: number;
}

export interface DecodedSolutionDeliveryClaimed {
  taskId: string;
  attemptIndex: number;
  requestId: string;
  operator: string;
  transactionHash?: `0x${string}`;
  blockNumber?: number;
}

export function decodeTaskCreatedLogs(logs: Log[]): DecodedTaskCreated[] {
  const results: DecodedTaskCreated[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'TaskCreated') {
        const args = decoded.args as {
          creator: Address;
          taskId: bigint;
          manifestDigest: Hex;
          taskCidDigest: Hex;
        };
        results.push({
          taskId: String(args.taskId),
          taskCidDigest: String(args.taskCidDigest),
          manifestDigest: String(args.manifestDigest),
          creator: String(args.creator),
          transactionHash: log.transactionHash ?? undefined,
          blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
        });
      }
    } catch {
      // Not a TaskCreated event — skip
    }
  }
  return results;
}

export function decodeSolutionDeliveryClaimedLogs(logs: Log[]): DecodedSolutionDeliveryClaimed[] {
  const results: DecodedSolutionDeliveryClaimed[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'SolutionDeliveryClaimed') {
        const args = decoded.args as {
          operator: Address;
          requestId: Hex;
          taskId: bigint;
          attemptIndex: number;
        };
        results.push({
          taskId: String(args.taskId),
          attemptIndex: Number(args.attemptIndex),
          requestId: String(args.requestId),
          operator: String(args.operator),
          transactionHash: log.transactionHash ?? undefined,
          blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
        });
      }
    } catch {
      // Not a SolutionDeliveryClaimed event — skip
    }
  }
  return results;
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
  blockNumber?: bigint;
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
          blockNumber: log.blockNumber ?? undefined,
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
