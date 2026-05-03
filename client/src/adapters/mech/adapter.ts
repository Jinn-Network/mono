import { getAddress, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { ExecutionAdapter } from '../adapter.js';
import type {
  Task,
  RequestId,
  PostedTask,
  TaskAnnouncement,
  TaskRequest,
  TaskResult,
  DeliveredResult,
} from '../../types/index.js';
import { TransientError, PermanentError, parseTask } from '../../types/index.js';
import { createClients } from './safe.js';
import {
  buildResultPayload,
  uploadToIpfs,
  cidToDigestHex,
  fetchFromIpfs,
  fetchSignedTaskFromIpfs,
  fetchSignedEnvelopeFromIpfs,
  digestHexToGatewayUrl,
} from './ipfs.js';
import { canonicalJson } from '../../harnesses/engine/canonical-json.js';
import { SignedEnvelopeSchema } from '../../types/envelope.js';
import {
  submitTask,
  claimTask as claimTaskOnchain,
  claimEvaluation as claimEvaluationOnchain,
  claimDelivery,
  getMechDeliveryRate,
  getTimeoutBounds,
  decodeTaskCreatedLogs,
  decodeSolutionDeliveryClaimedLogs,
  decodeDeliverLogs,
  findLatestDeliveryDataHexForRequest,
  getMarketplaceRequestDeliveryMech,
  getTaskCidDigest,
  callDeliverToMarketplace,
  type RouterTaskPolicy,
} from './contracts.js';
import { type MechAdapterConfig } from './types.js';
import type { Store } from '../../store/store.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import { formatRpcError } from '../../rpc-error-context.js';
import {
  RESTORATION_ENVELOPE_CID_CONTEXT_KEY,
  RESTORATION_TASK_CID_CONTEXT_KEY,
} from '../../harnesses/impls/evaluation-context.js';
import { signTaskV1 } from '../../tasks/signing.js';
import type { SignedTaskV1, TaskClaimPolicy, TaskV1 } from '../../types/task-document.js';

interface PendingEvaluationSolution {
  taskId: string;
  attemptIndex: number;
  requestId: string;
  operator: string;
  transactionHash?: Hex;
  blockNumber?: number;
}

const ROUTER_REQUEST_CURSOR_CONFIG_KEY = 'mech_router_request_block_cursor_v1';
const PENDING_EVALUATION_SOLUTIONS_CONFIG_KEY = 'mech_pending_evaluation_solutions_v1';
const DEFAULT_MECH_CLAIM_POLICY: TaskClaimPolicy = {
  mode: 'exclusive',
  maxClaims: 1,
  maxClaimsPerOperator: 1,
  claimLeaseTtlSeconds: 30 * 60,
};

export class MechAdapter implements ExecutionAdapter {
  readonly name = 'mech';

  private publicClient!: PublicClient;
  private walletClient!: WalletClient;
  private config: MechAdapterConfig;
  private stopped = false;
  private requestBlockCursor = 0n;
  private deliveryBlockCursor = 0n;
  private pendingEvaluations = new Map<string, import('../../types/index.js').Task>();
  private observedTasks = new Map<string, TaskAnnouncement>();
  private requestKinds = new Map<string, 'solution' | 'verdict'>();
  private evaluationOpportunities = new Map<string, {
    taskId: string;
    attemptIndex: number;
    task: Task;
  }>();
  private pendingEvaluationSolutions = new Map<string, PendingEvaluationSolution>();
  // Original Tasks keyed by request ID (restoration and evaluation)
  // so we can yield accurate Task in DeliveredResult
  private originalStates = new Map<string, Task>();
  private store?: Store;

  constructor(config: MechAdapterConfig, store?: Store) {
    this.config = config;
    this.store = store;
  }

  async initialize(): Promise<void> {
    const chain = this.config.chainId === 84532 ? baseSepolia : base;
    const clients = createClients(
      this.config.rpcUrl,
      this.config.agentEoaPrivateKey,
      chain,
    );
    this.publicClient = clients.publicClient;
    this.walletClient = clients.walletClient;

    const blockNumber = await withRecoverableRetry(
      async () => this.publicClient.getBlockNumber(),
      {
        onRetry: ({ attempt, message }) => {
          console.error(
            `[mech] getBlockNumber retry ${attempt}: ` +
            formatRpcError(message, {
              operation: 'getBlockNumber',
              chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
              rpcUrl: this.config.rpcUrl,
            }),
          );
        },
      },
    );
    this.requestBlockCursor = blockNumber;
    this.deliveryBlockCursor = blockNumber;

    // Recover pending state from on-chain events
    if (this.store) {
      this.loadPendingEvaluationSolutions();
      await this.recoverPendingState(blockNumber);
    }
  }

  private async recoverPendingState(currentBlock: bigint): Promise<void> {
    const fromBlock = this.store?.getLastProcessedBlock() ?? currentBlock;
    if (fromBlock < currentBlock) {
      console.error(
        `[mech] TaskCoordinator clean-break recovery starts at block ${fromBlock}; ` +
        'old request-first recovery is intentionally disabled',
      );
      this.deliveryBlockCursor = fromBlock;
    }

    const routerCursorRaw = this.store?.getConfigValue(ROUTER_REQUEST_CURSOR_CONFIG_KEY);
    const routerFromBlock = routerCursorRaw != null
      ? BigInt(routerCursorRaw)
      : fromBlock;
    if (routerFromBlock < currentBlock) {
      this.requestBlockCursor = routerFromBlock;
    }
  }

  private loadPendingEvaluationSolutions(): void {
    const raw = this.store?.getConfigValue(PENDING_EVALUATION_SOLUTIONS_CONFIG_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (value == null || typeof value !== 'object') continue;
        const item = value as Partial<PendingEvaluationSolution>;
        if (
          typeof item.taskId !== 'string' ||
          typeof item.requestId !== 'string' ||
          typeof item.operator !== 'string' ||
          typeof item.attemptIndex !== 'number'
        ) {
          continue;
        }
        const solution: PendingEvaluationSolution = {
          taskId: item.taskId,
          attemptIndex: item.attemptIndex,
          requestId: item.requestId,
          operator: item.operator,
          transactionHash: typeof item.transactionHash === 'string'
            ? item.transactionHash as Hex
            : undefined,
          blockNumber: typeof item.blockNumber === 'number' ? item.blockNumber : undefined,
        };
        this.pendingEvaluationSolutions.set(solution.requestId, solution);
      }
    } catch (err) {
      console.error('[mech] Failed to load pending evaluation solutions:', err);
    }
  }

  private persistPendingEvaluationSolutions(): void {
    if (!this.store) return;
    this.store.setConfigValue(
      PENDING_EVALUATION_SOLUTIONS_CONFIG_KEY,
      JSON.stringify(Array.from(this.pendingEvaluationSolutions.values())),
    );
  }

  private rememberPendingEvaluationSolution(solution: PendingEvaluationSolution): void {
    this.pendingEvaluationSolutions.set(solution.requestId, solution);
    this.persistPendingEvaluationSolutions();
  }

  private forgetPendingEvaluationSolution(requestId: string): void {
    if (!this.pendingEvaluationSolutions.delete(requestId)) return;
    this.persistPendingEvaluationSolutions();
  }

  async postTask(state: Task): Promise<PostedTask> {
    const restorationState: Task = {
      ...state,
      role: state.role ?? 'restoration',
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
    };
    const signedTask = state.signedTask ?? await this.signTaskDocument(restorationState);
    // Upload the canonical signed Task document so watchers can verify and
    // parse the same task.v1 shape the creator signed.
    const ipfsDoc: unknown = signedTask;
    const restorationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, ipfsDoc);
    const restorationDataHex = cidToDigestHex(restorationCid);
    const digestNo0x = restorationDataHex.startsWith('0x') ? restorationDataHex.slice(2) : restorationDataHex;
    const restorationTaskCid = `f01551220${digestNo0x}`;

    const deliveryRate = await getMechDeliveryRate(this.publicClient, this.config.mechContractAddress);
    const { max: maxTimeout } = await getTimeoutBounds(this.publicClient, this.config.mechMarketplaceAddress);
    const solverTypeDigest = keccak256(toBytes(signedTask.solverType));
    const policy = this.contractPolicyForTask(restorationState);

    const taskSubmission = await submitTask(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      restorationDataHex,
      solverTypeDigest,
      policy,
      deliveryRate,
      deliveryRate,
      maxTimeout,
      this.config.evictionRecovery,
    );

    const announcement: TaskAnnouncement = {
      taskId: taskSubmission.taskId,
      task: {
        ...restorationState,
        signedTask,
        context: { ...(restorationState.context ?? {}), [RESTORATION_TASK_CID_CONTEXT_KEY]: restorationTaskCid },
      },
      taskCid: restorationTaskCid,
      onchainCreationTx: taskSubmission.txHash,
      onchainCreationBlock: taskSubmission.blockNumber,
    };
    this.observedTasks.set(taskSubmission.taskId, announcement);

    return {
      taskId: taskSubmission.taskId,
      taskCid: restorationTaskCid,
      txHash: taskSubmission.txHash,
      blockNumber: taskSubmission.blockNumber,
    };
  }

  private async signTaskDocument(state: Task): Promise<SignedTaskV1> {
    const now = Date.now();
    const account = privateKeyToAccount(this.config.agentEoaPrivateKey);
    const extras: Record<string, unknown> = {};
    if (state.context) extras['context'] = state.context;
    if (state.attemptId) extras['attemptId'] = state.attemptId;
    if (state.attemptNumber !== undefined) extras['attemptNumber'] = state.attemptNumber;
    if (state.restorationRequestId) extras['restorationRequestId'] = state.restorationRequestId;

    const taskDoc = {
      schemaVersion: 'task.v1',
      id: state.id,
      solverType: state.solverType ?? 'legacy',
      role: state.role ?? 'restoration',
      description: state.description,
      window: state.window ?? { startTs: now, endTs: now + 86_400_000 },
      spec: state.spec ?? {},
      eligibility: state.eligibility ?? {},
      claimPolicy: state.claimPolicy ?? DEFAULT_MECH_CLAIM_POLICY,
      creator: {
        safeAddress: getAddress(this.config.safeAddress),
        agentEoa: account.address,
      },
      createdAt: now,
      ...extras,
    } as TaskV1;
    return signTaskV1(taskDoc, this.config.agentEoaPrivateKey);
  }

  private contractPolicyForTask(state: Task): RouterTaskPolicy {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claimPolicy = state.claimPolicy ?? DEFAULT_MECH_CLAIM_POLICY;
    const normalizeTs = (value: number | undefined, fallback: number): bigint => {
      const raw = value ?? fallback;
      return BigInt(raw > 10_000_000_000 ? Math.floor(raw / 1000) : raw);
    };
    const claimWindowStart = normalizeTs(
      claimPolicy.claimWindowStartTs ?? state.window?.startTs,
      nowSeconds,
    );
    const claimWindowEnd = normalizeTs(
      claimPolicy.claimWindowEndTs ?? state.window?.endTs,
      nowSeconds + 30 * 60,
    );
    const submissionDeadline = normalizeTs(
      claimPolicy.submissionDeadlineTs,
      Number(claimWindowEnd) + claimPolicy.claimLeaseTtlSeconds,
    );

    return {
      claimWindowStart,
      claimWindowEnd,
      submissionDeadline,
      claimLeaseTtlSeconds: claimPolicy.claimLeaseTtlSeconds,
      maxClaims: claimPolicy.maxClaims,
      maxClaimsPerOperator: claimPolicy.maxClaimsPerOperator,
      policyHook: (claimPolicy.policyHook ?? zeroAddress) as Address,
      evaluationPolicy: {
        requiredVerdicts: 1,
        passThreshold: 1,
        evaluationDeadline: submissionDeadline + BigInt(claimPolicy.claimLeaseTtlSeconds),
        maxVerdictsPerEvaluator: 1,
        disallowSolverSelfEvaluation: true,
      },
    };
  }

  private buildEvaluationTask(params: {
    task: Task;
    solutionRequestId: string;
    attemptIndex: number;
    resultData: string;
    restorationEnvelopeCid: string;
    taskCid?: string;
  }): Task {
    return {
      ...params.task,
      id: `${params.task.id}:evaluation:${params.attemptIndex}`,
      role: 'evaluation',
      restorationRequestId: params.solutionRequestId,
      attemptId: params.solutionRequestId,
      attemptNumber: params.attemptIndex,
      context: {
        ...(params.task.context ?? {}),
        restorationResult: params.resultData,
        [RESTORATION_TASK_CID_CONTEXT_KEY]:
          params.task.context?.[RESTORATION_TASK_CID_CONTEXT_KEY] ?? params.taskCid,
        [RESTORATION_ENVELOPE_CID_CONTEXT_KEY]: params.restorationEnvelopeCid,
      },
    };
  }

  private async restorationAnnouncementForTaskId(taskId: string): Promise<TaskAnnouncement> {
    const cached = this.observedTasks.get(taskId);
    if (cached) return cached;

    const taskCidDigest = await getTaskCidDigest(
      this.publicClient,
      this.config.routerAddress,
      taskId,
    );
    const digest = taskCidDigest.startsWith('0x') ? taskCidDigest.slice(2) : taskCidDigest;
    const taskCid = `f01551220${digest}`;
    const signed = await fetchSignedTaskFromIpfs(this.config.ipfsGatewayUrl, taskCid);
    const task = parseTask({ signedTask: signed });
    const announcement: TaskAnnouncement = {
      taskId,
      task,
      taskCid,
    };
    this.observedTasks.set(taskId, announcement);
    return announcement;
  }

  private async deliveryEnvelopeCidForSolution(solution: {
    requestId: string;
    blockNumber?: number;
  }): Promise<string> {
    const deliveryMech = await getMarketplaceRequestDeliveryMech(
      this.publicClient,
      this.config.mechMarketplaceAddress,
      solution.requestId,
    );
    const toBlock = solution.blockNumber != null
      ? BigInt(solution.blockNumber)
      : await this.publicClient.getBlockNumber();
    const configuredLookback = this.config.mechDeliverBackfillLookbackBlocks;
    const fromBlock = configuredLookback == null
      ? 0n
      : toBlock > configuredLookback
      ? toBlock - configuredLookback
      : 0n;
    const deliveryDataHex = await findLatestDeliveryDataHexForRequest(
      this.publicClient,
      deliveryMech,
      solution.requestId,
      fromBlock,
      toBlock,
    );
    if (!deliveryDataHex) {
      throw new Error(
        `No Deliver event data found for solution ${solution.requestId} on mech ${deliveryMech} ` +
        `between blocks ${fromBlock} and ${toBlock}`,
      );
    }
    const digest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
    return `f01551220${digest}`;
  }

  private async evaluationAnnouncementForSolution(
    solution: PendingEvaluationSolution,
  ): Promise<TaskAnnouncement | undefined> {
    if (solution.operator.toLowerCase() === this.config.safeAddress.toLowerCase()) {
      return undefined;
    }

    const restoration = await this.restorationAnnouncementForTaskId(solution.taskId);
    const restorationEnvelopeCid = await this.deliveryEnvelopeCidForSolution(solution);
    const resultPayload = await fetchFromIpfs(
      this.config.ipfsGatewayUrl,
      restorationEnvelopeCid,
    ) as Record<string, unknown>;
    const resultData = (resultPayload.data as string) ?? JSON.stringify(resultPayload);
    const evaluationTask = this.buildEvaluationTask({
      task: restoration.task,
      solutionRequestId: solution.requestId,
      attemptIndex: solution.attemptIndex,
      resultData,
      restorationEnvelopeCid,
      taskCid: restoration.taskCid,
    });
    const opportunityId = `evaluation:${solution.taskId}:${solution.attemptIndex}:${solution.requestId}`;
    const announcement: TaskAnnouncement = {
      taskId: opportunityId,
      task: evaluationTask,
      taskCid: restoration.taskCid,
      onchainCreationTx: solution.transactionHash,
      onchainCreationBlock: solution.blockNumber,
    };
    this.evaluationOpportunities.set(opportunityId, {
      taskId: solution.taskId,
      attemptIndex: solution.attemptIndex,
      task: evaluationTask,
    });
    this.observedTasks.set(opportunityId, announcement);
    return announcement;
  }

  private async *retryPendingEvaluationSolutions(): AsyncIterable<TaskAnnouncement> {
    for (const [requestId, solution] of Array.from(this.pendingEvaluationSolutions)) {
      try {
        const announcement = await this.evaluationAnnouncementForSolution(solution);
        if (announcement) {
          yield announcement;
        } else {
          this.forgetPendingEvaluationSolution(requestId);
        }
      } catch (err) {
        console.error(
          `[mech] evaluation opportunity retry failed for ${requestId}:`,
          err,
        );
      }
    }
  }

  async *watchForTasks(): AsyncIterable<TaskAnnouncement> {
    while (!this.stopped) {
      try {
        for await (const announcement of this.retryPendingEvaluationSolutions()) {
          yield announcement;
        }

        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > this.requestBlockCursor) {
          const fromBlock = this.requestBlockCursor + 1n;
          const logs = await this.publicClient.getLogs({
            address: this.config.routerAddress,
            fromBlock,
            toBlock: currentBlock,
          });

          const submittedSolutions = decodeSolutionDeliveryClaimedLogs(logs);
          for (const solution of submittedSolutions) {
            this.rememberPendingEvaluationSolution(solution);
          }
          this.requestBlockCursor = currentBlock;
          if (this.store) {
            this.store.setConfigValue(ROUTER_REQUEST_CURSOR_CONFIG_KEY, currentBlock.toString());
          }

          const createdTasks = decodeTaskCreatedLogs(logs);
          for (const { taskId, taskCidDigest, transactionHash, blockNumber } of createdTasks) {
            try {
              const digest = taskCidDigest.startsWith('0x') ? taskCidDigest.slice(2) : taskCidDigest;
              // CIDv1 hex with raw codec (0x55) + sha2-256 (0x12) + 32-byte length (0x20).
              // The Autonolas registry returns raw-codec CIDs when uploading files with
              // cid-version=1 (Kubo default for files). This is confirmed by the existing
              // IPFS_GATEWAY_PREFIX constant (f01551220) which has worked in production.
              // If the gateway ever switches to dag-pb (0x70) the prefix would be f01701220.
              const taskCid = `f01551220${digest}`;
              const signed = await fetchSignedTaskFromIpfs(this.config.ipfsGatewayUrl, taskCid);
              const task = parseTask({ signedTask: signed });
              const announcement: TaskAnnouncement = {
                taskId,
                task,
                taskCid,
                onchainCreationTx: transactionHash,
                onchainCreationBlock: blockNumber,
              };
              this.observedTasks.set(taskId, announcement);
              yield announcement;
            } catch (err) {
              console.error(`[mech] Failed to parse task ${taskId}:`, err);
            }
          }

          for await (const announcement of this.retryPendingEvaluationSolutions()) {
            yield announcement;
          }
        }
      } catch (err) {
        console.error('[mech] Error polling for tasks:', formatRpcError(err, {
          operation: 'pollTaskCreated',
          chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
          rpcUrl: this.config.rpcUrl,
          contract: this.config.routerAddress,
          fromBlock: this.requestBlockCursor + 1n,
        }));
      }

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async claimTask(taskId: string): Promise<TaskRequest> {
    const evaluationOpportunity = this.evaluationOpportunities.get(taskId);
    if (evaluationOpportunity) {
      const signedEvaluationTask = await this.signTaskDocument(evaluationOpportunity.task);
      const evaluationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, signedEvaluationTask);
      const evaluationTaskCidDigest = cidToDigestHex(evaluationCid);
      const claimed = await this.claimEvaluation(
        evaluationOpportunity.taskId,
        evaluationOpportunity.attemptIndex,
        evaluationTaskCidDigest,
      );

      this.pendingEvaluations.set(claimed.requestId, evaluationOpportunity.task);
      this.originalStates.set(claimed.requestId, evaluationOpportunity.task);
      this.requestKinds.set(claimed.requestId, 'verdict');
      this.evaluationOpportunities.delete(taskId);
      const solutionRequestId = evaluationOpportunity.task.restorationRequestId;
      if (solutionRequestId) {
        this.forgetPendingEvaluationSolution(solutionRequestId);
      }

      return {
        requestId: claimed.requestId,
        taskId: claimed.taskId,
        attemptIndex: claimed.attemptIndex,
        task: evaluationOpportunity.task,
        taskCid: evaluationCid,
        onchainCreationTx: claimed.txHash,
        onchainCreationBlock: claimed.blockNumber,
      };
    }

    const announcement = this.observedTasks.get(taskId);
    if (!announcement) {
      throw new PermanentError(`Cannot claim unknown task ${taskId}`);
    }
    const claimed = await claimTaskOnchain(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      taskId,
      this.config.mechContractAddress,
      this.config.evictionRecovery,
    );

    const task = announcement.task;
    this.pendingEvaluations.set(claimed.requestId, task);
    this.originalStates.set(claimed.requestId, { ...task, role: task.role ?? 'restoration' });
    this.requestKinds.set(claimed.requestId, 'solution');

    return {
      requestId: claimed.requestId,
      taskId: claimed.taskId,
      attemptIndex: claimed.attemptIndex,
      task,
      taskCid: announcement.taskCid,
      onchainCreationTx: claimed.txHash,
      onchainCreationBlock: claimed.blockNumber,
    };
  }

  async submitResult(requestId: RequestId, result: TaskResult): Promise<void> {
    const payload = buildResultPayload(requestId, result);
    const cid = await uploadToIpfs(this.config.ipfsRegistryUrl, payload);
    const deliveryDigest = cidToDigestHex(cid);

    // Safe → AgentMech.deliverToMarketplace() → Marketplace.deliverMarketplace()
    await callDeliverToMarketplace(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.mechContractAddress,
      [requestId as Hex],
      [deliveryDigest],
      this.config.evictionRecovery,
    );
  }

  async claimEvaluation(taskId: string, attemptIndex: number, evaluationTaskCidDigest: Hex): Promise<{
    taskId: string;
    attemptIndex: number;
    verdictIndex: number;
    requestId: string;
    txHash: Hex;
    blockNumber?: number;
  }> {
    const claimed = await claimEvaluationOnchain(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      taskId,
      attemptIndex,
      this.config.mechContractAddress,
      evaluationTaskCidDigest,
      this.config.evictionRecovery,
    );
    this.requestKinds.set(claimed.requestId, 'verdict');
    return claimed;
  }

  async submitSolutionDelivery(requestId: RequestId, solutionDigest: Hex): Promise<void> {
    await claimDelivery(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      requestId as Hex,
      { variant: 'v3', kind: 'solution', evidenceHash: solutionDigest },
      this.config.evictionRecovery,
    );
  }

  async submitVerdictDelivery(requestId: RequestId, verdictDigest: Hex, verdictCode = 1): Promise<void> {
    await claimDelivery(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      requestId as Hex,
      { variant: 'v3', kind: 'verdict', evidenceHash: verdictDigest, verdictCode },
      this.config.evictionRecovery,
    );
  }

  private async evidenceHashForDelivery(requestId: string, deliveryDataHex: string): Promise<Hex | undefined> {
    if (this.config.routerClaimDeliveryVariant !== 'v2' && this.config.routerClaimDeliveryVariant !== 'v3') {
      return undefined;
    }

    const deliveryDigest = deliveryDataHex.startsWith('0x')
      ? deliveryDataHex.slice(2)
      : deliveryDataHex;
    const envelopeCid = `f01551220${deliveryDigest}`;
    const rawEnvelope = await fetchSignedEnvelopeFromIpfs(
      this.config.ipfsGatewayUrl,
      envelopeCid,
    );
    const parsed = SignedEnvelopeSchema.parse(rawEnvelope);
    // Strip signature to recompute the hash over the unsigned body.
    const { signature, ...unsignedBody } = parsed;
    const jcsBytes = new TextEncoder().encode(canonicalJson(unsignedBody));
    const recomputed = keccak256(jcsBytes);
    if (recomputed !== signature.hash) {
      throw new Error(
        `recomputed hash ${recomputed} !== envelope.signature.hash ${signature.hash}`,
      );
    }
    return recomputed as Hex;
  }

  private async ensureDeliveryClaimed(
    requestId: string,
    deliveryDataHex: string,
  ): Promise<'claimed' | 'already-claimed' | 'skipped' | 'retry'> {
    let evidenceHash: Hex | undefined;
    try {
      evidenceHash = await this.evidenceHashForDelivery(requestId, deliveryDataHex);
    } catch (err) {
      console.error(
        `[mech] evidenceHash derivation failed for ${requestId} — skipping claim, will retry on next loop:`,
        err,
      );
      return 'retry';
    }

    try {
      await claimDelivery(
        this.publicClient,
        this.walletClient,
        this.config.safeAddress,
        this.config.routerAddress,
        requestId as Hex,
        {
          variant: this.config.routerClaimDeliveryVariant,
          kind: this.requestKinds.get(requestId) ?? 'solution',
          evidenceHash,
        },
        this.config.evictionRecovery,
      );
      return 'claimed';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('RequestNotFound')) {
        console.error(`[mech] claimDelivery skipped (not a router request): ${requestId}`);
        return 'skipped';
      }
      if (/already.*claimed|alreadyClaimed/i.test(message)) {
        return 'already-claimed';
      }
      console.error(`[mech] claimDelivery failed for ${requestId}:`, err);
      return 'retry';
    }
  }

  async *watchForDeliveries(): AsyncIterable<DeliveredResult> {
    while (!this.stopped) {
      try {
        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > this.deliveryBlockCursor) {
          const logs = await this.publicClient.getLogs({
            address: this.config.mechContractAddress,
            fromBlock: this.deliveryBlockCursor + 1n,
            toBlock: currentBlock,
          });
          this.deliveryBlockCursor = currentBlock;

          const decoded = decodeDeliverLogs(logs);
          for (const { requestId, deliveryDataHex, mechAddress } of decoded) {
            // Two concerns, independent:
            //   (a) Did this Safe DELIVER this? → claim it (counter credit goes to msg.sender)
            //       The Deliver event's mechAddress is mechServiceMultisig (the Safe that owns
            //       the mech), so we compare against this.config.safeAddress.
            //   (b) Did this Safe claim the underlying Task? → act on the delivery.
            const iDelivered = mechAddress.toLowerCase() === this.config.safeAddress.toLowerCase();
            const iCreatedRestoration = this.pendingEvaluations.has(requestId);
            if (!iDelivered && !iCreatedRestoration) continue;

            // (a) Deliverer-side claim path: if this Safe delivered the request,
            //     claim it first so router counters credit the deliverer.
            let deliveryClaimStatus: Awaited<ReturnType<MechAdapter['ensureDeliveryClaimed']>> | undefined;
            if (iDelivered) {
              deliveryClaimStatus = await this.ensureDeliveryClaimed(requestId, deliveryDataHex);
              if (deliveryClaimStatus === 'retry') continue;
            }

            // (b) Task-side claim path: if this request came from our Task
            //     claim, make sure JinnRouterV3 records the Solution submission.
            if (iCreatedRestoration && deliveryClaimStatus !== 'claimed' && deliveryClaimStatus !== 'already-claimed') {
              const creatorClaimStatus = await this.ensureDeliveryClaimed(requestId, deliveryDataHex);
              if (creatorClaimStatus === 'retry') continue;
            }

            // (c) Yield the delivery result.
            try {
              const deliveryDigest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
              const resultPayload = await fetchFromIpfs(this.config.ipfsGatewayUrl, `f01551220${deliveryDigest}`) as Record<string, unknown>;

              const restorationResult: TaskResult = {
                data: (resultPayload.data as string) ?? JSON.stringify(resultPayload),
                artifacts: resultPayload.artifacts as string[] | undefined,
              };

              // Use the original Task, not the result payload.
              const task = this.originalStates.get(requestId) ?? {
                id: requestId,
                description: '',
              };

              yield {
                requestId,
                task,
                result: restorationResult,
                deliveryMechAddress: mechAddress,
              };

              // Clean up after yielding
              this.originalStates.delete(requestId);
              this.pendingEvaluations.delete(requestId);
              this.requestKinds.delete(requestId);
            } catch (err) {
              console.error(`[mech] Failed to parse delivery ${requestId}:`, err);
            }
          }
        }
      } catch (err) {
        console.error('[mech] Error polling for deliveries:', formatRpcError(err, {
          operation: 'pollDeliveries',
          chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
          rpcUrl: this.config.rpcUrl,
          contract: this.config.mechContractAddress,
          fromBlock: this.deliveryBlockCursor + 1n,
        }));
      }

      // Persist block cursor for crash recovery
      if (this.store && this.deliveryBlockCursor > 0n) {
        this.store.setLastProcessedBlock(this.deliveryBlockCursor);
      }

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
