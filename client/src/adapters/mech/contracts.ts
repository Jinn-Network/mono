import {
  encodeFunctionData,
  decodeEventLog,
  getAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Log,
  type TransactionReceipt,
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
import { executeSafeTransaction, type VenueBroadcaster } from './safe.js';
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
const TASK_CREATED_RECOVERY_WINDOW_BLOCKS = 64n;
const TASK_CREATED_RECONCILE_ATTEMPTS = 3;

export class PendingTaskSubmissionError extends Error {
  readonly name = 'PendingTaskSubmissionError';

  constructor(
    readonly txHash: Hex,
    cause?: unknown,
  ) {
    super(
      `Task submission ${txHash} is pending reconciliation; refusing to broadcast another Safe transaction`,
      { cause },
    );
  }
}

const TASK_COORDINATOR_ABI = [
  {
    name: 'getTask',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [
      {
        // Tokenless-OLAS pivot: TaskCoordinator.TaskRecord trimmed — policy is
        // `maxClaims` + `allowSolverSelfEvaluation`; the window/lease/quorum/
        // EvaluationPolicy fields are gone and the final flag is `creatorCredited`
        // (was `taskCreationCredited`). `creator` then `taskCidDigest` MUST stay
        // components 0/1 — getTaskCidDigest decodes positionally.
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
              { name: 'maxClaims', type: 'uint32' },
              { name: 'allowSolverSelfEvaluation', type: 'bool' },
            ],
          },
          { name: 'claimCount', type: 'uint32' },
          { name: 'submittedCount', type: 'uint32' },
          { name: 'finalizedAttemptCount', type: 'uint32' },
          { name: 'creatorCredited', type: 'bool' },
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

/**
 * Run a protocol-loop action (createTask / claim* / deliver). Staking is
 * ORTHOGONAL to this loop: JinnRouterV3 has no staking gate on these calls, so
 * an evicted service can still post, claim and deliver. The former
 * eviction-recovery behaviour — on any action failure, read staking state and,
 * if evicted, fire an inline `distributor.reStake()` then retry — was not just
 * unnecessary, it was actively HARMFUL: when the reStake itself reverts (these
 * services re-evict faster than `minStakingDuration`, so reStake routinely
 * reverts on-chain), `restakeEvictedService` throws `reStake failed for service
 * N`, which REPLACES the action's real error and propagates up as the failure.
 * That broke the solve/deliver tick in T3.1 — op-b completed zero solves while
 * its delivery path turned every transient hiccup into a fatal `reStake failed
 * for service 56`. Reward-eligibility re-staking is handled out-of-band by the
 * background EvictionLoop (daemon.ts); the protocol loop must never depend on
 * it. (#773 — completes the eviction removal that dropped the UI/API surface
 * but missed this hot-path coupling.)
 *
 * `_publicClient`/`_recovery`/`_label` are retained in the signature so the many
 * call sites and their `evictionRecovery` plumbing stay unchanged; they are
 * intentionally unused.
 */
export async function withEvictionRecovery<T>(
  _publicClient: PublicClient,
  _recovery: EvictionRecoveryConfig | undefined,
  _label: string,
  action: () => Promise<T>,
): Promise<T> {
  return action();
}

export async function submitTask(
  publicClient: PublicClient,
  walletClient: WalletClient,
  broadcaster: VenueBroadcaster | undefined,
  safeAddress: Address,
  routerAddress: Address,
  taskCidDigest: Hex,
  manifestDigest: Hex,
  policy: RouterTaskPolicy,
  solutionMaxDeliveryRateWei: bigint,
  verdictMaxDeliveryRateWei: bigint,
  responseTimeout: bigint,
  evictionRecovery?: EvictionRecoveryConfig,
  onTransactionHash?: (txHash: Hex) => void | Promise<void>,
  beforeBroadcast?: () => void | Promise<void>,
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
  // Tokenless-OLAS pivot: the trimmed JinnRouterV3.createTask escrows
  // `solutionBudget + verdictBudget` where each side = rate * maxClaims (the
  // per-verdict `requiredVerdicts` multiplier is gone). msg.value must match
  // exactly or createTask reverts with RouterInsufficientTaskBudget.
  const taskBudget =
    solutionMaxDeliveryRateWei * BigInt(policy.maxClaims) +
    verdictMaxDeliveryRateWei * BigInt(policy.maxClaims);

  const txHash = await withEvictionRecovery(
    publicClient,
    evictionRecovery,
    'createTask',
    () => executeSafeTransaction(
      publicClient,
      walletClient,
      {
        safeAddress,
        to: routerAddress,
        value: taskBudget,
        data: calldata,
      },
      broadcaster,
      {
        beforeBroadcast,
        onBroadcast: onTransactionHash,
      },
    ),
  );

  let lastError: unknown;
  for (let attempt = 0; attempt < TASK_CREATED_RECONCILE_ATTEMPTS; attempt++) {
    let receipt: TransactionReceipt | undefined;
    try {
      receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash, {
        onRetry: ({ attempt: waitAttempt, message }) => {
          console.error(`[router] wait restoration receipt retry ${waitAttempt}: ${message}`);
        },
      });
      if (receipt.status === 'reverted') {
        const error = new Error(`Task submission reverted: ${txHash}`);
        Object.assign(error, { txHash });
        throw error;
      }
    } catch (err) {
      lastError = err;
      if (receipt?.status === 'reverted') {
        throw err;
      }
    }

    let created = receipt
      ? taskCreatedFromLogs(receipt.logs, safeAddress, taskCidDigest, manifestDigest)
      : null;
    try {
      created ??= receipt
        ? await findTaskCreatedNearReceipt(
          publicClient,
          routerAddress,
          safeAddress,
          taskCidDigest,
          manifestDigest,
          receipt,
        )
        : await findTaskCreatedNearHead(
          publicClient,
          routerAddress,
          safeAddress,
          taskCidDigest,
          manifestDigest,
        );
    } catch (err) {
      lastError = err;
    }
    if (created) {
      return {
        taskId: created.taskId,
        txHash: (created.transactionHash ?? txHash) as Hex,
        receiptLogCount: receipt?.logs.length ?? 0,
        blockNumber: created.blockNumber,
      };
    }
    if (attempt < TASK_CREATED_RECONCILE_ATTEMPTS - 1) {
      console.error(
        `[router] reconcile createTask tx=${txHash} attempt ${attempt + 1}: ` +
        `${lastError ? flattenErrorMessage(lastError) : 'TaskCreated not observed yet'}`,
      );
      await backoffDelay(attempt, 1_000, 12_000);
    }
  }

  throw new PendingTaskSubmissionError(txHash, lastError);
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function taskCreatedFromLogs(
  logs: Log[],
  creator: Address,
  taskCidDigest: Hex,
  manifestDigest: Hex,
): DecodedTaskCreated | null {
  return decodeTaskCreatedLogs(logs).find((event) =>
    sameHex(event.creator, creator) &&
    sameHex(event.taskCidDigest, taskCidDigest) &&
    sameHex(event.manifestDigest, manifestDigest)
  ) ?? null;
}

async function findTaskCreatedNearReceipt(
  publicClient: PublicClient,
  routerAddress: Address,
  creator: Address,
  taskCidDigest: Hex,
  manifestDigest: Hex,
  receipt: TransactionReceipt,
): Promise<DecodedTaskCreated | null> {
  const receiptBlock = receipt.blockNumber ?? await publicClient.getBlockNumber();
  const toBlock = await publicClient.getBlockNumber();
  const fromBlock = receiptBlock > TASK_CREATED_RECOVERY_WINDOW_BLOCKS
    ? receiptBlock - TASK_CREATED_RECOVERY_WINDOW_BLOCKS
    : 0n;
  const logs = await publicClient.getLogs({
    address: routerAddress,
    fromBlock,
    toBlock,
  });

  return taskCreatedFromLogs(logs, creator, taskCidDigest, manifestDigest);
}

async function findTaskCreatedNearHead(
  publicClient: PublicClient,
  routerAddress: Address,
  creator: Address,
  taskCidDigest: Hex,
  manifestDigest: Hex,
): Promise<DecodedTaskCreated | null> {
  const toBlock = await publicClient.getBlockNumber();
  const fromBlock = toBlock > TASK_CREATED_RECOVERY_WINDOW_BLOCKS
    ? toBlock - TASK_CREATED_RECOVERY_WINDOW_BLOCKS
    : 0n;
  const logs = await publicClient.getLogs({
    address: routerAddress,
    fromBlock,
    toBlock,
  });
  return taskCreatedFromLogs(logs, creator, taskCidDigest, manifestDigest);
}

/**
 * On-chain `TaskCoordinator.TaskPolicy` as it crosses the wire to
 * `JinnRouterV3.createTask`. Tokenless-OLAS pivot: the launcher-funded attempt
 * count plus the self-evaluation gate. Off-chain scheduling intent (windows,
 * lease, quorum) lives in the task.v1 `claimPolicy` field, not here.
 *
 * `allowSolverSelfEvaluation` defaults false → the coordinator rejects a verdict
 * whose evaluator is the attempt's solver (the independent-evaluation invariant).
 * A testnet SolverNet sets it true so a single operator can solve + self-evaluate
 * + close the loop solo (dogfooding); mainnet leaves it false.
 */
export interface RouterTaskPolicy {
  maxClaims: number;
  allowSolverSelfEvaluation: boolean;
}

export async function claimTask(
  publicClient: PublicClient,
  walletClient: WalletClient,
  broadcaster: VenueBroadcaster | undefined,
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
    }, broadcaster),
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

export async function isDeliveryAlreadyClaimed(
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
  broadcaster: VenueBroadcaster | undefined,
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
        }, broadcaster),
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

// ── Event-specific log filters (#116) ───────────────────────────────────────
// The Task-native polling path fetches only the router/mech events it actually
// decodes, instead of scanning the address and decode-discarding the rest. These
// ABI event items are passed as viem `getLogs({ event })` / `getLogs({ events })`
// so the provider filters by topic0 server-side. `getAbiItem` throws if a name is
// absent, so a future ABI rename fails loud rather than silently emptying a filter.
export const ROUTER_TASK_CREATED_EVENT = getAbiItem({ abi: JINN_ROUTER_ABI, name: 'TaskCreated' });
export const ROUTER_TASK_ATTEMPT_CREATED_EVENT = getAbiItem({
  abi: JINN_ROUTER_ABI,
  name: 'TaskAttemptCreated',
});
export const ROUTER_EVALUATION_ATTEMPT_CREATED_EVENT = getAbiItem({
  abi: JINN_ROUTER_ABI,
  name: 'EvaluationAttemptCreated',
});
export const ROUTER_VERDICT_DELIVERY_CLAIMED_EVENT = getAbiItem({
  abi: JINN_ROUTER_ABI,
  name: 'VerdictDeliveryClaimed',
});
export const ROUTER_TASK_BUDGET_REFUNDED_EVENT = getAbiItem({
  abi: JINN_ROUTER_ABI,
  name: 'TaskBudgetRefunded',
});
export const ROUTER_SOLUTION_DELIVERY_CLAIMED_EVENT = getAbiItem({
  abi: JINN_ROUTER_ABI,
  name: 'SolutionDeliveryClaimed',
});
export const MECH_DELIVER_EVENT = getAbiItem({ abi: MECH_ABI, name: 'Deliver' });
/** The two router events the Task-native poll loop needs per pass. */
export const ROUTER_DISCOVERY_EVENTS = [
  ROUTER_TASK_CREATED_EVENT,
  ROUTER_SOLUTION_DELIVERY_CLAIMED_EVENT,
] as const;

export type RouterAttemptProvenanceRole = 'solution' | 'verdict';

export type RouterAttemptProvenanceVerification =
  | 'verified'
  | 'missing'
  | 'multiple'
  | 'mismatch';

/**
 * Verify that exactly one Router attempt event binds a request to its expected
 * Task, role-specific attempt index, and operator. The caller supplies the
 * persisted observation lower bound so indexer rows remain acceleration data
 * only.
 */
export async function verifyRouterAttemptProvenance(
  publicClient: PublicClient,
  routerAddress: Address,
  expected: {
    role: RouterAttemptProvenanceRole;
    taskId: string;
    attemptIndex: number;
    requestId: string;
    operator: string;
  },
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RouterAttemptProvenanceVerification> {
  let exactMatches = 0;
  let relatedMismatches = 0;
  const event = expected.role === 'solution'
    ? ROUTER_TASK_ATTEMPT_CREATED_EVENT
    : ROUTER_EVALUATION_ATTEMPT_CREATED_EVENT;

  for (let start = fromBlock; start <= toBlock; start += LOG_SCAN_CHUNK + 1n) {
    const end = start + LOG_SCAN_CHUNK > toBlock ? toBlock : start + LOG_SCAN_CHUNK;
    const logs = await publicClient.getLogs({
      address: routerAddress,
      event,
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
        if (
          (expected.role === 'solution' && decoded.eventName !== 'TaskAttemptCreated')
          || (expected.role === 'verdict' && decoded.eventName !== 'EvaluationAttemptCreated')
        ) {
          continue;
        }
        const args = decoded.args as {
          taskId: bigint;
          attemptIndex: number;
          requestId: Hex;
          operator?: Address;
          evaluator?: Address;
        };
        const taskId = String(args.taskId);
        const attemptIndex = Number(args.attemptIndex);
        const requestId = String(args.requestId);
        const operator = expected.role === 'solution'
          ? String(args.operator)
          : String(args.evaluator);
        const sameTaskAttempt = taskId === expected.taskId
          && attemptIndex === expected.attemptIndex;
        const sameRequest = requestId.toLowerCase() === expected.requestId.toLowerCase();
        if (
          (expected.role === 'verdict' && !sameRequest)
          || (expected.role === 'solution' && !sameTaskAttempt && !sameRequest)
        ) {
          continue;
        }

        if (
          sameTaskAttempt
          && sameRequest
          && operator.toLowerCase() === expected.operator.toLowerCase()
        ) {
          exactMatches += 1;
        } else {
          relatedMismatches += 1;
        }
      } catch {
        // The topic filter already selects the role event; skip malformed logs.
      }
    }
  }

  if (exactMatches === 1 && relatedMismatches === 0) return 'verified';
  if (exactMatches > 1) return 'multiple';
  return relatedMismatches > 0 ? 'mismatch' : 'missing';
}

export async function scanTasks(
  publicClient: PublicClient,
  routerAddress: Address,
  creator: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TaskRecord[]> {
  const results: TaskRecord[] = [];
  const chunkSize = 1000n; // see LOG_SCAN_CHUNK rationale (#807): small chunks fit every provider's getLogs cap + keep responses small

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    const logs = await publicClient.getLogs({
      address: routerAddress,
      event: ROUTER_TASK_CREATED_EVENT,
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
  transactionHash?: Hex;
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
          transactionHash: log.transactionHash ?? undefined,
          blockNumber: log.blockNumber ?? undefined,
        });
      }
    } catch {
      // Not a Deliver event — skip
    }
  }
  return results;
}

// 1000-block chunks (was 9999): a 9999-block getLogs over a delivery-dense
// region (e.g. after a posting burst) returns responses large enough that
// publicnode/Tenderly reject or time out, AND exceeds the 2k getLogs range cap
// of the sepolia.base.org fallback — so every provider in the fallback chain
// fails and the per-chunk delivery cursor never advances (it gets stuck
// re-scanning the same failing chunk forever, starving evaluator discovery and
// spamming rpc-fallback errors). 1000 blocks fits every provider's range cap
// and keeps response sizes small so the cursor advances through dense regions.
// See #807 (delivery-path) and #801/#803 (same large-getLogs class, startup path).
const LOG_SCAN_CHUNK = 1000n;

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
      event: MECH_DELIVER_EVENT,
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

/**
 * Most recent exact Deliver event for one request, including the originating
 * transaction hash needed to close the engine's post-delivery crash window.
 */
export async function findLatestDeliveryForRequest(
  publicClient: PublicClient,
  mechContractAddress: Address,
  requestId: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DecodedDeliverEvent | null> {
  let latest: DecodedDeliverEvent | null = null;
  const normalizedRequestId = requestId.toLowerCase();
  for (let start = fromBlock; start <= toBlock; start += LOG_SCAN_CHUNK + 1n) {
    const end = start + LOG_SCAN_CHUNK > toBlock ? toBlock : start + LOG_SCAN_CHUNK;
    const logs = await publicClient.getLogs({
      address: mechContractAddress,
      event: MECH_DELIVER_EVENT,
      fromBlock: start,
      toBlock: end,
    });
    for (const decoded of decodeDeliverLogs(logs)) {
      if (decoded.requestId.toLowerCase() === normalizedRequestId) {
        latest = decoded;
      }
    }
  }
  return latest;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

// Legacy immediate-settlement callers historically accept these duplicate
// reverts as idempotent. Adoption-aware callers opt into exact recovery and
// must re-resolve the Deliver event instead of trusting revert text.
const ALREADY_DELIVERED_PATTERNS = [
  'AlreadyDelivered',
  'DeliveryAlreadyCompleted',
  'JobAlreadyDelivered',
  'RequestAlreadyDelivered',
];

export async function callDeliverToMarketplace(
  publicClient: PublicClient,
  walletClient: WalletClient,
  broadcaster: VenueBroadcaster | undefined,
  safeAddress: Address,
  mechContractAddress: Address,
  requestIds: Hex[],
  datas: Hex[],
  evictionRecovery?: EvictionRecoveryConfig,
  requireExactRecovery = false,
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
      }, broadcaster),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      !requireExactRecovery
      && ALREADY_DELIVERED_PATTERNS.some(pattern => message.includes(pattern))
    ) {
      console.error(
        `[mech] callDeliverToMarketplace: already delivered (legacy idempotent), requestIds=${requestIds.join(',')}`,
      );
      return '0x' as Hex;
    }
    throw err;
  }
}
