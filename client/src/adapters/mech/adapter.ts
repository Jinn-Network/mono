import { getAddress, zeroAddress, type Address, type Hex, type Log, type PublicClient, type WalletClient } from 'viem';
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
import { normalizeEnvelopeRole, SignedEnvelopeSchema } from '../../types/envelope.js';
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
  canClaimTask,
  canClaimEvaluation,
  type RouterTaskPolicy,
} from './contracts.js';
import { type MechAdapterConfig } from './types.js';
import { isNonRecoverableInnerRevert } from './safe-revert.js';
import { VerdictCode, verdictCodeFromValue } from './verdict-code.js';
import { manifestDigestForCid } from './digest.js';
import type { DiscoveryAPI } from '../../discovery/types.js';
import type { Store } from '../../store/store.js';
import { emitStructured } from '../../events/emitter.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import { formatRpcError } from '../../rpc-error-context.js';
import {
  SOLUTION_ENVELOPE_CID_CONTEXT_KEY,
  SOLUTION_TASK_CID_CONTEXT_KEY,
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
const DEFAULT_MECH_DELIVER_BACKFILL_LOOKBACK_BLOCKS = 100_000n;

/** Yield to the event loop every N evaluation opportunities so a large retry
 *  backlog can't starve the HTTP API mid-cycle. */
const EVALUATION_RETRY_YIELD_EVERY = 10;

/**
 * Decide whether a `canClaimEvaluation` failure means the opportunity can NEVER
 * become claimable (terminal, prune it) versus one that could still clear later
 * (transient, keep retrying).
 *
 * Classification is done on the *structured* `revertName` decoded straight from
 * the inner revert data — not by regex-unformatting the operator-facing `reason`
 * string. The format→regex round-trip was fragile: an arg value containing a
 * `(` corrupted the strip, and the `flattenErrorMessage` fallback produced
 * arbitrary text the regex mangled, silently mis-classifying opportunities.
 *
 * A false-keep (re-checking a dead opportunity) only costs one more RPC; a
 * false-prune (dropping a still-claimable opportunity) loses real work — so
 * when in doubt we keep. Anything without a known non-recoverable revert name
 * is treated as transient.
 */
function isTerminalEvaluationReason(revertName: string | null | undefined): boolean {
  return isNonRecoverableInnerRevert(revertName);
}
const DEFAULT_ROUTER_LOG_CHUNK_BLOCKS = 9_999n;
/**
 * Floor block for the on-chain TaskCreated backlog scan, per chain.
 *
 * A daemon with no joined-SolverNet store cursor (fresh bootstrap) will scan
 * from this block forward. Existing operators with a persisted cursor are
 * unaffected — their cursor is used as long as it's already past this floor.
 *
 * Base Sepolia (84532): 41_510_000 lands at 2026-05-14T19:51Z, ~2h after the
 * fufn validated-pool was rebuilt to `EVAL_SEMANTICS_VERSION='3'` (2026-05-14
 * T17:28Z). Everything created before that rebuild is a "ghost" — admitted
 * under a prior semantics regime that the current evaluators can't score —
 * so a fresh operator should not waste compute claiming them.
 * See gh #300 for the proper fix (symmetric solver-side admission filter and
 * generalised scan-age window).
 *
 * Base mainnet (8453): unchanged at 25_000_000 — Phase 0 era, no v3-rebuild
 * equivalent on mainnet.
 */
export const DEFAULT_TASK_DISCOVERY_FROM_BLOCK: Record<number, bigint> = {
  84532: 41_510_000n,
  8453: 25_000_000n,
};
const DEFAULT_MECH_CLAIM_POLICY: TaskClaimPolicy = {
  mode: 'exclusive',
  maxClaims: 1,
  maxClaimsPerOperator: 1,
  claimLeaseTtlSeconds: 30 * 60,
};

/**
 * Spec §14 (Task 24): a Task carries `contractId` + `contractVersion` (BINDING)
 * and a derivable `solverType = `${contractId}.${contractVersion}``. When the
 * caller only supplies a legacy `solverType`, derive the BINDING fields from
 * its `<id>.<version>` shape; fall back to `('legacy', 'v0')` so signing never
 * produces an empty BINDING field.
 */
function deriveSolverType(state: Task): string {
  if (state.contractId && state.contractVersion) {
    return `${state.contractId}.${state.contractVersion}`;
  }
  return 'legacy';
}

function deriveContractIdVersion(
  state: Task,
  solverType: string,
): { contractId: string; contractVersion: string } {
  if (state.contractId && state.contractVersion) {
    return { contractId: state.contractId, contractVersion: state.contractVersion };
  }
  const dot = solverType.lastIndexOf('.');
  if (dot > 0 && dot < solverType.length - 1) {
    return {
      contractId: solverType.slice(0, dot),
      contractVersion: solverType.slice(dot + 1),
    };
  }
  return { contractId: solverType || 'legacy', contractVersion: 'v0' };
}

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
  /**
   * Read-through cache for `restorationAnnouncementForTaskId` — the restoration
   * task body looked up *while building an evaluation opportunity*. Kept
   * SEPARATE from `observedTasks` (the `watchForTasks` discovery dedup set) on
   * purpose: writing the restoration body into `observedTasks` made the
   * TaskCreated scan skip that taskId as a *restoration* opportunity just
   * because the daemon had built an *evaluation* opportunity for someone
   * else's attempt on it. That blocked the creator's own daemon from claiming
   * its own attempt on a multi-attempt (`maxClaims > 1`) task it posted.
   */
  private restorationBodyCache = new Map<string, TaskAnnouncement>();
  private requestKinds = new Map<string, 'solution' | 'verdict'>();
  private claimedRestorationTaskIds = new Set<string>();
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
    } else {
      const fromBlock = this.onchainTaskDiscoveryFromBlock();
      if (fromBlock && fromBlock <= blockNumber) {
        this.requestBlockCursor = fromBlock - 1n;
      }
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

    const scanFromBlock = this.onchainTaskDiscoveryFromBlock();
    if (scanFromBlock && scanFromBlock <= currentBlock) {
      const canonicalCursor = scanFromBlock - 1n;
      if (canonicalCursor < this.requestBlockCursor) {
        this.requestBlockCursor = canonicalCursor;
      }
      console.error(
        `[mech] TaskCreated canonical backlog scan enabled from block ${scanFromBlock}; ` +
        'subgraph discovery is optional acceleration only',
      );
    }
  }

  private onchainTaskDiscoveryFromBlock(): bigint | undefined {
    const discovery = this.config.taskDiscovery;
    const hasJoinedSolverNet = (discovery?.solverNetManifestCids?.length ?? 0) > 0;
    if (!hasJoinedSolverNet) return undefined;
    if (discovery?.onchainFromBlock !== undefined) {
      const raw = discovery.onchainFromBlock;
      const value = typeof raw === 'bigint' ? raw : BigInt(Math.max(0, Math.floor(raw)));
      return value > 0n ? value : undefined;
    }
    return DEFAULT_TASK_DISCOVERY_FROM_BLOCK[this.config.chainId];
  }

  private joinedManifestDigestSet(): Set<string> {
    const cids = this.config.taskDiscovery?.solverNetManifestCids ?? [];
    return new Set(
      cids
        .filter(Boolean)
        .map((cid) => manifestDigestForCid(cid).toLowerCase()),
    );
  }

  private allowedDiscoveryTaskIds(): Set<string> | null {
    const raw = this.config.taskDiscovery?.allowedTaskIds ?? [];
    const ids = raw.map((id) => id.trim()).filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  }

  private isDiscoveryTaskAllowed(taskId: string): boolean {
    const allowed = this.allowedDiscoveryTaskIds();
    return allowed === null || allowed.has(taskId);
  }

  private async getRouterLogsInChunks(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    const logs: Log[] = [];
    for (let start = fromBlock; start <= toBlock; start += DEFAULT_ROUTER_LOG_CHUNK_BLOCKS + 1n) {
      const end = start + DEFAULT_ROUTER_LOG_CHUNK_BLOCKS > toBlock
        ? toBlock
        : start + DEFAULT_ROUTER_LOG_CHUNK_BLOCKS;
      logs.push(...await this.publicClient.getLogs({
        address: this.config.routerAddress,
        fromBlock: start,
        toBlock: end,
      }));
    }
    return logs;
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

  private clearPendingDeliveryRecoveryState(requestId: string): void {
    this.originalStates.delete(requestId);
    this.pendingEvaluations.delete(requestId);
    this.requestKinds.delete(requestId);
  }

  private recoveryDeliveryExpirySeconds(requestId: string): number | undefined {
    const task = this.originalStates.get(requestId) ?? this.pendingEvaluations.get(requestId);
    const claimPolicy = task?.claimPolicy ?? DEFAULT_MECH_CLAIM_POLICY;
    const normalizeTsToSeconds = (value: number | undefined): number | undefined => {
      if (value == null) return undefined;
      return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
    };
    const submissionDeadlineSeconds = normalizeTsToSeconds(claimPolicy.submissionDeadlineTs);
    if (submissionDeadlineSeconds != null) return submissionDeadlineSeconds;

    const claimWindowEndSeconds = normalizeTsToSeconds(
      claimPolicy.claimWindowEndTs ?? task?.window?.endTs,
    );
    if (claimWindowEndSeconds == null) return undefined;
    return claimWindowEndSeconds + claimPolicy.claimLeaseTtlSeconds;
  }

  private shouldSkipExpiredRecoveryDelivery(
    requestId: string,
    currentChainTimestampSeconds: number,
    recoveryExpirySeconds: number,
  ): boolean {
    if (currentChainTimestampSeconds <= recoveryExpirySeconds) return false;

    console.error(
      `[mech] skipping recovery delivery for ${requestId}: ` +
      `submission deadline expired at ${new Date(recoveryExpirySeconds * 1000).toISOString()}`,
    );
    this.clearPendingDeliveryRecoveryState(requestId);
    return true;
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
    // Task 24 (spec/2026-05-05-solvernet-creation-and-launch.md §14): the
    // on-chain digest is now manifest-bound — `keccak256(manifestCid)` —
    // replacing the prior `keccak256(solverType)` derivation. This makes
    // operator eligibility per-launch, not per-protocol.
    if (!signedTask.solverNetManifestCid) {
      throw new PermanentError(
        `Cannot post task ${signedTask.id}: signed task is missing solverNetManifestCid ` +
        `(BINDING — required for keccak256(manifestCid) digest derivation).`,
      );
    }
    const manifestDigest = keccak256(toBytes(signedTask.solverNetManifestCid));
    const policy = this.contractPolicyForTask(restorationState);

    const taskSubmission = await submitTask(
      this.publicClient,
      this.walletClient,
      this.config.safeAddress,
      this.config.routerAddress,
      restorationDataHex,
      manifestDigest,
      policy,
      deliveryRate,
      deliveryRate,
      maxTimeout,
      this.config.evictionRecovery,
    );

    // Deliberately do NOT seed `observedTasks` with the task we just posted.
    // `observedTasks` is the dedup set for `watchForTasks`: the on-chain
    // TaskCreated scan skips any taskId already in it (so a task is announced
    // to the engine-watcher at most once). Seeding it here marked the
    // creator's own task as "already announced" before it was ever yielded —
    // which permanently prevented the *creator's own daemon* from discovering,
    // claiming, and solving a task it posted. On a multi-attempt task
    // (`maxClaims > 1`) the creator running the solver role is legitimate
    // (the protocol forbids only self-*evaluation*, and that on a per-attempt
    // basis), and on testnet it is the intended single-operator dogfood path
    // — post → claim → solve → grade → settle from one daemon. The dedup is
    // still correct: it now keys only on tasks `watchForTasks` actually
    // yielded. `restorationAnnouncementForTaskId` re-hydrates from chain/IPFS
    // on a cache miss, so dropping the pre-seed costs at most one redundant
    // fetch if the creator later claims its own task.
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

    // Task 24: BINDING SolverNet manifest CID + contract id/version.
    // The runtime Task may be missing them when the daemon falls back to
    // ad-hoc posting paths (legacy / tests). For those we derive the
    // contract id/version from solverType and require the caller to surface
    // the missing manifest cid downstream — postTask() throws on missing
    // solverNetManifestCid before submitTask is invoked.
    if (!state.solverNetManifestCid) {
      throw new PermanentError(
        `Cannot sign task ${state.id}: missing solverNetManifestCid ` +
        `(BINDING — spec/2026-05-05-solvernet-creation-and-launch.md §14).`,
      );
    }
    const solverType = state.solverType ?? deriveSolverType(state);
    const { contractId, contractVersion } = deriveContractIdVersion(state, solverType);

    const taskDoc = {
      schemaVersion: 'task.v1',
      id: state.id,
      solverType,
      contractId,
      contractVersion,
      solverNetManifestCid: state.solverNetManifestCid,
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
        // `requiredVerdicts` defaults to 1 but is overridable via the task's
        // claim policy. A value > 1 opens additional verdict claim slots per
        // attempt; combined with the per-evaluator cap below (1), it
        // guarantees an honest evaluator can still claim and deliver a slot
        // even when other evaluators have squatted some — the structural fix
        // for a shared/adversarial testnet where a non-delivering claimer
        // would otherwise permanently lock a single-slot attempt.
        requiredVerdicts: claimPolicy.requiredVerdicts ?? 1,
        passThreshold: 1,
        evaluationDeadline: submissionDeadline + BigInt(claimPolicy.claimLeaseTtlSeconds),
        maxVerdictsPerEvaluator: 1,
        // Allow the same operator to evaluate its own Solution on Base Sepolia
        // (84532) so a single dogfood daemon can close the full
        // post→claim→solve→grade→settle loop without standing up a second
        // operator. Mainnet (8453) keeps the protocol-level protection.
        // TODO: revert to unconditional `true` before mainnet launch, OR move
        // this to a per-SolverNet manifest field so individual launchers can
        // opt in to single-operator dogfood while the protocol default stays
        // strict.
        disallowSolverSelfEvaluation: this.config.chainId !== 84532,
      },
    };
  }

  private buildEvaluationTask(params: {
    task: Task;
    solutionRequestId: string;
    attemptIndex: number;
    resultData: string;
    solutionEnvelopeCid: string;
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
        [SOLUTION_TASK_CID_CONTEXT_KEY]:
          params.task.context?.[SOLUTION_TASK_CID_CONTEXT_KEY] ?? params.task.context?.[RESTORATION_TASK_CID_CONTEXT_KEY] ?? params.taskCid,
        [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: params.solutionEnvelopeCid,
      },
    };
  }

  private async restorationAnnouncementForTaskId(taskId: string): Promise<TaskAnnouncement> {
    // Read-through `restorationBodyCache` — NOT `observedTasks`. This helper is
    // an evaluation-path lookup of a task's restoration body; caching it into
    // the `watchForTasks` discovery dedup set would suppress the creator's own
    // restoration-claim discovery for the same taskId (see field comment).
    const cached =
      this.restorationBodyCache.get(taskId) ?? this.observedTasks.get(taskId);
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
    this.restorationBodyCache.set(taskId, announcement);
    return announcement;
  }

  private async restorationAnnouncementFromDigest(params: {
    taskId: string;
    taskCidDigest: string;
    transactionHash?: Hex;
    blockNumber?: number;
  }): Promise<TaskAnnouncement> {
    const digest = params.taskCidDigest.startsWith('0x')
      ? params.taskCidDigest.slice(2)
      : params.taskCidDigest;
    const taskCid = `f01551220${digest}`;
    const signed = await fetchSignedTaskFromIpfs(this.config.ipfsGatewayUrl, taskCid);
    const task = parseTask({ signedTask: signed });
    const announcement: TaskAnnouncement = {
      taskId: params.taskId,
      task,
      taskCid,
      onchainCreationTx: params.transactionHash,
      onchainCreationBlock: params.blockNumber,
    };
    this.observedTasks.set(params.taskId, announcement);
    return announcement;
  }

  private async *discoverSubgraphRestorationTasks(): AsyncIterable<TaskAnnouncement> {
    const discovery = this.config.taskDiscovery;
    const discoveryApi: DiscoveryAPI | undefined = discovery?.discoveryApi;
    const solverNetManifestCids = discovery?.solverNetManifestCids ?? [];

    // Without a DiscoveryAPI or SolverNet manifest CIDs there is nothing to
    // discover via this path. A DiscoveryAPI is injected by the daemon from
    // the shared discovery client (Ponder HTTP or onchain floor).
    if (!discoveryApi || solverNetManifestCids.length === 0) return;

    let candidates;
    try {
      candidates = await discoveryApi.findClaimableTasks({
        solverNetManifestCids,
        operatorAddress: this.config.safeAddress,
        pageSize: discovery?.pageSize,
        maxPages: discovery?.maxPages,
      });
    } catch (err) {
      console.error(
        '[mech] task discovery (DiscoveryAPI) failed:',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const discoveryFloorBlock = this.onchainTaskDiscoveryFromBlock();

    for (const candidate of candidates) {
      if (!this.isDiscoveryTaskAllowed(candidate.taskId)) continue;
      if (this.claimedRestorationTaskIds.has(candidate.taskId)) continue;

      // gh #300 ghost-task floor — same floor as the on-chain TaskCreated
      // backlog scan, applied to the DiscoveryAPI path too. Without this,
      // the Ponder indexer (or onchain floor's listClaimableTasks) returns
      // pre-floor tasks that are still claimable on-chain but unscorable
      // under the current admission regime, defeating the floor's
      // intent. Candidates without `createdAtBlock` are passed through
      // (DiscoveryAPI is allowed to omit that field; we can't filter
      // without it).
      if (
        discoveryFloorBlock != null &&
        candidate.createdAtBlock != null &&
        BigInt(candidate.createdAtBlock) < discoveryFloorBlock
      ) {
        continue;
      }

      // Verify claimability per backend: HttpSubgraphDiscoveryAPI cannot run
      // canClaimTask (no on-chain simulation), so this check is load-bearing
      // for that path. OnchainDiscoveryAPI already filters internally; this
      // is redundant there. TODO: add a DiscoveryAPI capability flag so the
      // onchain path can skip the extra simulateContract round-trip.
      const claimable = await canClaimTask(
        this.publicClient,
        this.config.safeAddress,
        this.config.routerAddress,
        candidate.taskId,
        this.config.mechContractAddress,
      );
      if (!claimable.ok) {
        continue;
      }

      try {
        // Yield every hydrated candidate per cycle rather than returning after
        // the first. The engine-watcher (daemon._runEngineWatcherLoop) is the
        // single point of skip-state truth — when its in-flight admission gate
        // fast-skips a candidate (~30s TTL), that skip state never flows back
        // into the adapter's iteration cursor. Yielding only the first
        // candidate per cycle meant a fast-skipped slot starved every
        // subsequent candidate in the round-robin (`fc05f686`) ordering for
        // the duration of the TTL. By driving the full candidate list per
        // cycle we let the engine apply its gate to each one, preserving the
        // round-robin fairness across joined SolverNets. See task 212 live
        // verification in the fix's commit body.
        yield await this.restorationAnnouncementFromDigest({
          taskId: candidate.taskId,
          taskCidDigest: candidate.taskCidDigest,
          transactionHash: candidate.createdAtTx,
          blockNumber: candidate.createdAtBlock,
        });
      } catch (err) {
        console.error(
          `[mech] failed to hydrate subgraph task ${candidate.taskId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /**
   * Look up the Deliver-event envelope CID for a pending evaluation solution.
   *
   * Returns `null` when the Deliver event is not present in the configured
   * lookback window. This is a terminal signal for the caller — re-running the
   * same lookup later is deterministically futile when `solution.blockNumber`
   * is set (toBlock is fixed at the SolutionDeliveryClaimed block), and is
   * monotonically less likely to find the event when toBlock follows chain head
   * (the window slides forward, away from any older Deliver event). Callers
   * should prune the pending solution on `null` rather than retry — see #553.
   */
  private async deliveryEnvelopeCidForSolution(solution: {
    requestId: string;
    blockNumber?: number;
  }): Promise<string | null> {
    const deliveryMech = await getMarketplaceRequestDeliveryMech(
      this.publicClient,
      this.config.mechMarketplaceAddress,
      solution.requestId,
    );
    const toBlock = solution.blockNumber != null
      ? BigInt(solution.blockNumber)
      : await this.publicClient.getBlockNumber();
    const lookback =
      this.config.mechDeliverBackfillLookbackBlocks ??
      DEFAULT_MECH_DELIVER_BACKFILL_LOOKBACK_BLOCKS;
    const fromBlock = toBlock > lookback ? toBlock - lookback : 0n;
    const deliveryDataHex = await findLatestDeliveryDataHexForRequest(
      this.publicClient,
      deliveryMech,
      solution.requestId,
      fromBlock,
      toBlock,
    );
    if (!deliveryDataHex) {
      return null;
    }
    const digest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
    return `f01551220${digest}`;
  }

  private async evaluationAnnouncementForSolution(
    solution: PendingEvaluationSolution,
  ): Promise<TaskAnnouncement | undefined> {
    if (!this.isDiscoveryTaskAllowed(solution.taskId)) {
      console.log(
        `[mech] skipping evaluation opportunity ${solution.requestId} for task ${solution.taskId}/${solution.attemptIndex}: outside configured task discovery scope`,
      );
      this.forgetPendingEvaluationSolution(solution.requestId);
      return undefined;
    }

    // Cheap claimability gate FIRST — before the restoration lookup + IPFS
    // fetch. A backlog of terminal opportunities (finalized / evaluation
    // deadline passed / max verdicts reached) must not pay the expensive
    // restoration-announcement cost on every poll cycle. Terminal reasons are
    // pruned from the working set so the loop never re-scans on-chain history;
    // transient reasons are left in place to be retried next cycle.
    const claimable = await canClaimEvaluation(
      this.publicClient,
      this.config.safeAddress,
      this.config.routerAddress,
      solution.taskId,
      solution.attemptIndex,
      this.config.mechContractAddress,
    );
    if (!claimable.ok) {
      const terminal = isTerminalEvaluationReason(claimable.revertName);
      console.log(
        `[mech] skipping evaluation opportunity ${solution.requestId} for task ${solution.taskId}/${solution.attemptIndex}: ${claimable.reason}` +
          (terminal ? ' (terminal — pruned)' : ' (transient — will retry)'),
      );
      if (terminal) {
        this.forgetPendingEvaluationSolution(solution.requestId);
      }
      return undefined;
    }

    const restoration = await this.restorationAnnouncementForTaskId(solution.taskId);
    const solutionEnvelopeCid = await this.deliveryEnvelopeCidForSolution(solution);
    if (solutionEnvelopeCid == null) {
      // #553: Deliver event is not within the configured lookback window. A
      // retry with the same toBlock cannot reach an older event, so this is
      // terminal — prune so the loop never re-pays the canClaimEvaluation +
      // restoration lookup cost on a deterministically-failing opportunity.
      console.log(
        `[mech] pruning evaluation opportunity ${solution.requestId} for task ${solution.taskId}/${solution.attemptIndex}: ` +
          `no Deliver event found within configured lookback (terminal — pruned)`,
      );
      this.forgetPendingEvaluationSolution(solution.requestId);
      return undefined;
    }
    const resultPayload = await fetchFromIpfs(
      this.config.ipfsGatewayUrl,
      solutionEnvelopeCid,
    ) as Record<string, unknown>;
    const resultData = (resultPayload.data as string) ?? JSON.stringify(resultPayload);
    const evaluationTask = this.buildEvaluationTask({
      task: restoration.task,
      solutionRequestId: solution.requestId,
      attemptIndex: solution.attemptIndex,
      resultData,
      solutionEnvelopeCid,
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
    let processed = 0;
    for (const [requestId, solution] of Array.from(this.pendingEvaluationSolutions)) {
      // Yield to the event loop periodically so a large backlog of pending
      // evaluation solutions can't starve the HTTP API mid-cycle.
      if (processed > 0 && processed % EVALUATION_RETRY_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      processed++;
      try {
        const announcement = await this.evaluationAnnouncementForSolution(solution);
        if (announcement) {
          yield announcement;
        }
        // No announcement does NOT mean "forget" — pruning is owned by
        // evaluationAnnouncementForSolution, which only removes terminal cases.
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

        for await (const announcement of this.discoverSubgraphRestorationTasks()) {
          yield announcement;
        }

        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > this.requestBlockCursor) {
          const fromBlock = this.requestBlockCursor + 1n;
          const logs = await this.getRouterLogsInChunks(fromBlock, currentBlock);

          const submittedSolutions = decodeSolutionDeliveryClaimedLogs(logs);
          for (const solution of submittedSolutions) {
            this.rememberPendingEvaluationSolution(solution);
          }
          this.requestBlockCursor = currentBlock;
          if (this.store) {
            this.store.setConfigValue(ROUTER_REQUEST_CURSOR_CONFIG_KEY, currentBlock.toString());
          }

          const joinedManifestDigests = this.joinedManifestDigestSet();
          const createdTasks = decodeTaskCreatedLogs(logs);
          for (const { taskId, taskCidDigest, manifestDigest, transactionHash, blockNumber } of createdTasks) {
            if (!this.isDiscoveryTaskAllowed(taskId)) continue;
            if (this.claimedRestorationTaskIds.has(taskId) || this.observedTasks.has(taskId)) continue;
            if (joinedManifestDigests.size > 0 && !joinedManifestDigests.has(manifestDigest.toLowerCase())) continue;
            try {
              const claimable = await canClaimTask(
                this.publicClient,
                this.config.safeAddress,
                this.config.routerAddress,
                taskId,
                this.config.mechContractAddress,
              );
              if (!claimable.ok) continue;
              const announcement = await this.restorationAnnouncementFromDigest({
                taskId,
                taskCidDigest,
                transactionHash,
                blockNumber,
              });
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
    this.claimedRestorationTaskIds.add(claimed.taskId);
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

  async submitVerdictDelivery(requestId: RequestId, verdictDigest: Hex, verdictCode: VerdictCode): Promise<void> {
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

  private async deliveryClaimForDelivery(requestId: string, deliveryDataHex: string): Promise<{
    evidenceHash: Hex | undefined;
    kind: 'solution' | 'verdict';
    verdictCode?: VerdictCode;
  }> {
    const fallbackKind = this.requestKinds.get(requestId) ?? 'solution';
    if (this.config.routerClaimDeliveryVariant !== 'v2' && this.config.routerClaimDeliveryVariant !== 'v3') {
      return {
        evidenceHash: undefined,
        kind: fallbackKind,
      };
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
    const rawSigned = rawEnvelope as Record<string, unknown>;
    const { signature: _rawSignature, ...unsignedBody } = rawSigned;
    const signature = parsed.signature;
    const jcsBytes = new TextEncoder().encode(canonicalJson(unsignedBody));
    const recomputed = keccak256(jcsBytes);
    if (recomputed !== signature.hash) {
      throw new Error(
        `recomputed hash ${recomputed} !== envelope.signature.hash ${signature.hash}`,
      );
    }

    const role = normalizeEnvelopeRole(parsed.role);
    if (role === 'capture') {
      throw new Error(`unsupported delivery envelope role=capture for requestId ${requestId}`);
    }
    const kind = role === 'verdict' ? 'verdict' : 'solution';
    const payload = rawSigned['payload'];
    const rawVerdict = payload != null && typeof payload === 'object'
      ? (payload as Record<string, unknown>)['verdict']
      : undefined;

    return {
      evidenceHash: recomputed as Hex,
      kind,
      verdictCode: kind === 'verdict' ? verdictCodeFromValue(rawVerdict) : undefined,
    };
  }

  private async ensureDeliveryClaimed(
    requestId: string,
    deliveryDataHex: string,
  ): Promise<'claimed' | 'already-claimed' | 'skipped' | 'retry'> {
    let claimOptions: {
      evidenceHash: Hex | undefined;
      kind: 'solution' | 'verdict';
      verdictCode?: VerdictCode;
    };
    try {
      claimOptions = await this.deliveryClaimForDelivery(requestId, deliveryDataHex);
    } catch (err) {
      console.error(
        `[mech] delivery claim metadata derivation failed for ${requestId} — skipping claim, will retry on next loop:`,
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
          kind: claimOptions.kind,
          evidenceHash: claimOptions.evidenceHash,
          verdictCode: claimOptions.verdictCode,
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
      // Paired SSE signal for the operator-app `claim_failed` notification
      // (OPERATOR-APP-SPEC §2.10). The early-return branches above
      // (`skipped` / `already-claimed`) are not failures and intentionally
      // do not emit. See spec 2026-05-26-issue-442-claim-failed-notification-design.md.
      emitStructured({
        kind: 'intent',
        message: 'Delivery claim failed',
        requestId,
        errorCode: 'claim_failed',
        details: {
          kind: claimOptions.kind,
          source: 'mech.claimDelivery',
          error: message,
        },
      });
      return 'retry';
    }
  }

  /**
   * Paginate `getLogs` over `[deliveryBlockCursor+1, currentBlock]` chunked by
   * `DEFAULT_ROUTER_LOG_CHUNK_BLOCKS` to honor RPC provider block-range limits
   * (Tenderly base-sepolia caps at 100k; sepolia.base.org ~1k). Advances +
   * persists `deliveryBlockCursor` per chunk so a mid-scan RPC failure on a
   * later chunk does not strand the cursor at the pre-poll value (#552).
   *
   * Yields each chunk's decoded Deliver entries so the consumer can process
   * them with the live "current block" context (needed for the recovery-
   * delivery timestamp cache).
   */
  private async *scanDeliveryLogChunks(
    currentBlock: bigint,
  ): AsyncIterable<ReturnType<typeof decodeDeliverLogs>> {
    while (currentBlock > this.deliveryBlockCursor) {
      const chunkStart = this.deliveryBlockCursor + 1n;
      const chunkEnd = chunkStart + DEFAULT_ROUTER_LOG_CHUNK_BLOCKS > currentBlock
        ? currentBlock
        : chunkStart + DEFAULT_ROUTER_LOG_CHUNK_BLOCKS;
      const logs = await this.publicClient.getLogs({
        address: this.config.mechContractAddress,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      // Advance + persist BEFORE yielding so partial progress is durable even
      // if a downstream throw escapes back through the for-await consumer.
      this.deliveryBlockCursor = chunkEnd;
      if (this.store) {
        this.store.setLastProcessedBlock(this.deliveryBlockCursor);
      }
      yield decodeDeliverLogs(logs);
    }
  }

  async *watchForDeliveries(): AsyncIterable<DeliveredResult> {
    while (!this.stopped) {
      try {
        const currentBlock = await this.publicClient.getBlockNumber();
        // Caches scoped to the whole poll iteration: the "current block"
        // reference does not change across chunks.
        const blockTimestampSecondsByNumber = new Map<bigint, number>();
        let currentBlockTimestampSeconds: number | undefined;

        for await (const decoded of this.scanDeliveryLogChunks(currentBlock)) {
          if (this.stopped) break;
          for (const { requestId, deliveryDataHex, mechAddress, blockNumber } of decoded) {
            // Two concerns, independent:
            //   (a) Did this Safe DELIVER this? → claim it (counter credit goes to msg.sender)
            //       The Deliver event's mechAddress is mechServiceMultisig (the Safe that owns
            //       the mech), so we compare against this.config.safeAddress.
            //   (b) Did this Safe claim the underlying Task? → act on the delivery.
            const iDelivered = mechAddress.toLowerCase() === this.config.safeAddress.toLowerCase();
            const iCreatedRestoration = this.pendingEvaluations.has(requestId);
            if (!iDelivered && !iCreatedRestoration) continue;
            if (iCreatedRestoration) {
              const recoveryExpirySeconds = this.recoveryDeliveryExpirySeconds(requestId);
              if (recoveryExpirySeconds != null) {
                let deliveryTimestampSeconds: number | undefined;
                if (blockNumber != null) {
                  deliveryTimestampSeconds = blockTimestampSecondsByNumber.get(blockNumber);
                  if (deliveryTimestampSeconds == null) {
                    const deliveryBlockData = await this.publicClient.getBlock({ blockNumber });
                    deliveryTimestampSeconds = Number(deliveryBlockData.timestamp);
                    blockTimestampSecondsByNumber.set(blockNumber, deliveryTimestampSeconds);
                  }
                } else {
                  if (currentBlockTimestampSeconds == null) {
                    const currentBlockData = await this.publicClient.getBlock({ blockNumber: currentBlock });
                    currentBlockTimestampSeconds = Number(currentBlockData.timestamp);
                  }
                  deliveryTimestampSeconds = currentBlockTimestampSeconds;
                }
                if (
                  this.shouldSkipExpiredRecoveryDelivery(
                    requestId,
                    deliveryTimestampSeconds,
                    recoveryExpirySeconds,
                  )
                ) {
                  continue;
                }
              }
            }

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
              this.clearPendingDeliveryRecoveryState(requestId);
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

      // Cursor persistence is per-chunk inside the loop above (#552). A poll
      // that did no chunked work has no progress to persist.

      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
