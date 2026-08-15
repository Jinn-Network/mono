import { getAddress, type Hex, type PublicClient, type WalletClient } from 'viem';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { ExecutionAdapter, PostTaskOptions } from '../adapter.js';
import type {
  Task,
  RequestId,
  PostedTask,
  TaskAnnouncement,
  TaskRequest,
  TaskResult,
  DeliveredResult,
} from '../../types/index.js';
import { PermanentError, parseTask } from '../../types/index.js';
import { createClients, type VenueBroadcaster } from './safe.js';

/**
 * Coalesce a string-or-array RPC input down to the head URL for display in
 * error contexts (`formatRpcError` expects a single host). The adapter
 * accepts the full fallback chain at the type level; this helper exists so
 * the error-formatting call sites can keep their old signature.
 */
function rpcUrlForDisplay(rpcUrl: string | readonly string[]): string {
  return Array.isArray(rpcUrl) ? rpcUrl[0]! : (rpcUrl as string);
}
import {
  buildResultPayload,
  uploadToIpfs,
  cidToDigestHex,
  fetchFromIpfs,
  fetchSignedTaskFromIpfs,
  fetchRawBytesFromIpfs,
} from './ipfs.js';
import { normalizeEnvelopeRole, SignedEnvelopeSchema } from '../../types/envelope.js';
import {
  deliveryClaimEvidenceHash,
  signedEnvelopeJsonFromDeliveryOrRaw,
} from '../../daemon/bridge-legacy-delivery.js';
import {
  submitTask,
  claimTask as claimTaskOnchain,
  claimDelivery,
  getMechDeliveryRate,
  getTimeoutBounds,
  decodeDeliverLogs,
  MECH_DELIVER_EVENT,
  callDeliverToMarketplace,
  type RouterTaskPolicy,
  scanTasks,
  PendingTaskSubmissionError,
} from './contracts.js';
import { type MechAdapterConfig } from './types.js';
import { VerdictCode, verdictCodeFromValue } from './verdict-code.js';
import { manifestDigestForCid } from './digest.js';
import type { Store } from '../../store/store.js';
import { emitStructured } from '../../events/emitter.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import { formatRpcError } from '../../rpc-error-context.js';
import { signTaskV1 } from '../../tasks/signing.js';
import type { SignedTaskV1, TaskClaimPolicy, TaskV1 } from '../../types/task-document.js';

const ROUTER_REQUEST_CURSOR_CONFIG_KEY = 'mech_router_request_block_cursor_v1';
const DEFAULT_MECH_DELIVER_BACKFILL_LOOKBACK_BLOCKS = 100_000n;
const DEFAULT_ROUTER_LOG_CHUNK_BLOCKS = 9_999n;
/**
 * Default rolling-window size for the on-chain TaskCreated backlog scan (#801).
 *
 * The scan is a *backstop* behind `DiscoveryAPI.findClaimableTasks` (the indexer
 * on testnet, the newest-first RPC floor on mainnet), which is the primary
 * discovery path on every chain. Without a bound the scan replays from the fixed
 * admission floor to head on *every* restart, a range that grows monotonically
 * with the chain — the startup-stall regression #801 documents. Bounding it to
 * `head − N` makes restart cost fixed regardless of chain age while still
 * re-observing a generous recent window (~28h on Base at ~2s/block) for tasks
 * and SolutionDeliveryClaimed events the indexer might have lagged on. Operators
 * who want a wider net pin an absolute start via `taskDiscoveryOnchainFromBlock`.
 */
const DEFAULT_ONCHAIN_SCAN_WINDOW_BLOCKS = 50_000n;
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
  private requestKinds = new Map<string, 'solution' | 'verdict'>();
  // Original Tasks keyed by request ID (restoration and evaluation)
  // so we can yield accurate Task in DeliveredResult
  private originalStates = new Map<string, Task>();
  private store?: Store;

  constructor(config: MechAdapterConfig, store?: Store) {
    this.config = config;
    this.store = store;
  }

  /** Maps config pin → core `FetchFromIpfsOptions` (omit when unset = production ipfs.io). */
  private ipfsFetchOpts(): { fallbackGatewayBase?: string | false } | undefined {
    const fallback = this.config.ipfsFallbackGatewayUrl;
    if (fallback === undefined) return undefined;
    return { fallbackGatewayBase: fallback };
  }

  /**
   * Late-bind the Safe broadcaster this adapter's writes route through (finding E16 / the C2
   * ruling). Needed because `main.ts` constructs this adapter before the composition root that
   * owns the broadcaster; the daemon calls this once, before starting any loop that can write.
   */
  public setBroadcaster(broadcaster: VenueBroadcaster): void {
    this.config.broadcaster = broadcaster;
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
              rpcUrl: rpcUrlForDisplay(this.config.rpcUrl),
            }),
          );
        },
      },
    );
    this.requestBlockCursor = blockNumber;
    this.deliveryBlockCursor = blockNumber;

    // Recover pending state from on-chain events. The evaluation-opportunity
    // rehydrate retired with Wave-4 D2; recoverPendingState recovers this
    // operator's own in-flight restoration claims (router cursor + TaskCreated
    // scan) only.
    if (this.store) {
      await this.recoverPendingState(blockNumber);
    } else {
      const fromBlock = this.onchainScanFromBlock(blockNumber);
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

    const scanFromBlock = this.onchainScanFromBlock(currentBlock);
    if (scanFromBlock && scanFromBlock <= currentBlock) {
      const canonicalCursor = scanFromBlock - 1n;
      if (canonicalCursor < this.requestBlockCursor) {
        this.requestBlockCursor = canonicalCursor;
      }
      console.error(
        `[mech] TaskCreated backlog scan (bounded backstop) enabled from block ${scanFromBlock}; ` +
        'DiscoveryAPI.findClaimableTasks is the primary discovery path',
      );
    }
  }

  /**
   * The gh #300 scorability admission floor: tasks created before this block are
   * "ghosts" from a prior eval-semantics regime and are rejected — including on
   * the `DiscoveryAPI` (indexer) path. Fixed per chain; an explicit operator
   * `onchainFromBlock` raises it. Returns `undefined` when no SolverNet is joined
   * (the daemon claims nothing, so there is no floor to apply).
   *
   * This is deliberately NOT the on-chain scan start — see `onchainScanFromBlock`.
   * Bounding the scan for RPC cost must never narrow which tasks are admitted.
   */
  private taskAdmissionFloorBlock(): bigint | undefined {
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

  /**
   * Start block for the on-chain TaskCreated backlog scan (the secondary backstop
   * behind `DiscoveryAPI.findClaimableTasks`). Defaults to a bounded rolling
   * window `head − DEFAULT_ONCHAIN_SCAN_WINDOW_BLOCKS`, never below the admission
   * floor (scanning pre-floor blocks only surfaces rejected ghosts). An explicit
   * `onchainFromBlock` override pins an absolute start, honored as the operator's
   * choice. Returns `undefined` when no SolverNet is joined.
   */
  private onchainScanFromBlock(head: bigint): bigint | undefined {
    const floor = this.taskAdmissionFloorBlock();
    if (floor === undefined) return undefined;
    // An explicit override is reflected verbatim in `floor`; honor it as the pin.
    if (this.config.taskDiscovery?.onchainFromBlock !== undefined) return floor;
    const window = head - DEFAULT_ONCHAIN_SCAN_WINDOW_BLOCKS;
    return window > floor ? window : floor;
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

  async postTask(state: Task, options?: PostTaskOptions): Promise<PostedTask> {
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

    const baseDeliveryRate = await getMechDeliveryRate(this.publicClient, this.config.mechContractAddress);
    const { resolveMintedTaskDeliveryRate } = await import('../../solver-types/_swe-rebench-v2-escrow.js');
    const deliveryRate = resolveMintedTaskDeliveryRate(
      baseDeliveryRate,
      signedTask.eligibility as Record<string, unknown> | undefined,
    );
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
      this.config.broadcaster,
      this.config.safeAddress,
      this.config.routerAddress,
      restorationDataHex,
      manifestDigest,
      policy,
      deliveryRate,
      deliveryRate,
      maxTimeout,
      this.config.evictionRecovery,
      options?.onTransactionHash,
      options?.beforeBroadcast,
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
    // yielded. `restorationAnnouncementFromDigest` re-hydrates from chain/IPFS
    // on a cache miss, so dropping the pre-seed costs at most one redundant
    // fetch if the creator later claims its own task.
    return {
      taskId: taskSubmission.taskId,
      taskCid: restorationTaskCid,
      txHash: taskSubmission.txHash,
      blockNumber: taskSubmission.blockNumber,
    };
  }

  async recoverTaskPost(input: {
    creatorSafeAddress: string;
    signedTask: SignedTaskV1;
    pendingTxHash?: Hex;
  }): Promise<PostedTask | null> {
    const cid = await uploadToIpfs(this.config.ipfsRegistryUrl, input.signedTask);
    const taskCidDigest = cidToDigestHex(cid);
    const manifestDigest = manifestDigestForCid(input.signedTask.solverNetManifestCid);
    const head = await this.publicClient.getBlockNumber();
    const fromBlock = DEFAULT_TASK_DISCOVERY_FROM_BLOCK[this.config.chainId] ?? 0n;
    const matches = await scanTasks(
      this.publicClient,
      this.config.routerAddress,
      getAddress(input.creatorSafeAddress),
      fromBlock,
      head,
    );
    const match = matches.find((event) =>
      event.taskCidDigest.toLowerCase() === taskCidDigest.toLowerCase()
      && event.manifestDigest?.toLowerCase() === manifestDigest.toLowerCase()
    );
    if (!match) {
      if (input.pendingTxHash) {
        throw new PendingTaskSubmissionError(input.pendingTxHash);
      }
      return null;
    }
    const digest = taskCidDigest.slice(2);
    return {
      taskId: match.taskId,
      taskCid: `f01551220${digest}`,
      txHash: match.transactionHash,
      blockNumber: match.blockNumber,
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
      ...(state.executionRequest ? { executionRequest: state.executionRequest } : {}),
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
    // Tokenless-OLAS pivot: the on-chain TaskCoordinator.TaskPolicy is the
    // launcher-funded attempt count (`maxClaims`) plus the self-evaluation gate
    // (`allowSolverSelfEvaluation`). Windows, lease, and quorum do NOT cross the
    // wire — that off-chain scheduling intent stays in the task.v1 `claimPolicy`
    // field (still carried on the signed task document and read by the local
    // scheduler).
    //
    // `allowSolverSelfEvaluation` comes from the off-chain `claimPolicy` when it
    // sets the flag explicitly; that explicit value always wins. When it is
    // absent (the common case — the auto-generators do not set it) the default
    // is network-keyed: TRUE on testnet (Base Sepolia, 84532) so a single
    // operator can solve + self-evaluate + close the loop solo for dogfooding,
    // and FALSE on mainnet to preserve the independent-evaluation invariant (the
    // coordinator rejects a verdict whose evaluator is the attempt's solver).
    const claimPolicy = state.claimPolicy ?? DEFAULT_MECH_CLAIM_POLICY;
    const isTestnet = this.config.chainId === 84532;
    return {
      maxClaims: claimPolicy.maxClaims,
      allowSolverSelfEvaluation: claimPolicy.allowSolverSelfEvaluation ?? isTestnet,
    };
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
    const signed = await fetchSignedTaskFromIpfs(
      this.config.ipfsGatewayUrl,
      taskCid,
      this.ipfsFetchOpts(),
    );
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

  /**
   * #1412: a task's execution window (task.window.endTs) is only known after
   * IPFS hydration, not from any on-chain/discovery candidate shape. The
   * engine kills the harness subprocess the instant this window is in the
   * past (engine.ts: setTimeout(abort, max(0, endTs - now)) fires at 0ms), so
   * claiming an already-expired task always fails with no chance of a real
   * solve. Both discovery paths (DiscoveryAPI and the on-chain TaskCreated
   * backlog scan) must skip these before spending a claim tx on a doomed run.
   */
  private hasExpiredExecutionWindow(announcement: TaskAnnouncement): boolean {
    let windowEndTs = announcement.task.window?.endTs;
    const spec = announcement.task.spec;
    if (
      spec?.['source'] === 'autopilot-session'
      && typeof spec['session'] === 'object'
      && spec['session'] !== null
      && typeof (spec['session'] as { deadline?: unknown }).deadline === 'string'
    ) {
      const sessionDeadline = Date.parse(
        (spec['session'] as { deadline: string }).deadline,
      );
      if (Number.isFinite(sessionDeadline)) {
        windowEndTs = windowEndTs === undefined
          ? sessionDeadline
          : Math.min(windowEndTs, sessionDeadline);
      }
    }
    return windowEndTs !== undefined && windowEndTs <= Date.now();
  }

  async *watchForTasks(): AsyncIterable<TaskAnnouncement> {
    // The solution path retired with cutover stage 1 (watchForTasks stopped calling
    // discoverSubgraphRestorationTasks) and the evaluation-opportunity path retired
    // with Wave-4 D2 (`legacy-evaluator-delivery-watcher`, DR-2026-08-05). Nothing
    // remains for this generator to announce: native discovery is the work loop's,
    // and native evaluation is the evaluator loop's. The method survives only to
    // satisfy `ExecutionAdapter` until `legacy-operator-composition` retires the
    // legacy composition; it deliberately performs NO chain reads, because a poll
    // that can never yield must not spend RPC quota.
    //
    // Scope note (Wave-4 D2): this generator has no caller. Wave-4 D1 removed
    // `_runEngineWatcherLoop`, the only production driver, so the whole
    // watchForTasks/claimTask/watchForDeliveries surface is orphaned. Retiring the
    // orphan is `legacy-operator-composition`'s door (stage 5), not this row's —
    // D2 removes the evaluation half and leaves the rest structurally intact.
    while (!this.stopped) {
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async claimTask(taskId: string): Promise<TaskRequest> {
    const announcement = this.observedTasks.get(taskId);
    if (!announcement) {
      throw new PermanentError(`Cannot claim unknown task ${taskId}`);
    }
    const claimed = await claimTaskOnchain(
      this.publicClient,
      this.walletClient,
      this.config.broadcaster,
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
      onchainCreationTx: announcement.onchainCreationTx,
      onchainCreationBlock: announcement.onchainCreationBlock,
      onchainClaimTx: claimed.txHash,
      onchainClaimBlock: claimed.blockNumber,
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
      this.config.broadcaster,
      this.config.safeAddress,
      this.config.mechContractAddress,
      [requestId as Hex],
      [deliveryDigest],
      this.config.evictionRecovery,
    );
  }

  async submitSolutionDelivery(requestId: RequestId, solutionDigest: Hex): Promise<void> {
    await claimDelivery(
      this.publicClient,
      this.walletClient,
      this.config.broadcaster,
      this.config.safeAddress,
      this.config.routerAddress,
      requestId as Hex,
      { variant: 'v3', kind: 'solution', evidenceHash: solutionDigest },
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
    const exactFetchedBytes = await fetchRawBytesFromIpfs(
      this.config.ipfsGatewayUrl,
      envelopeCid,
      this.ipfsFetchOpts(),
    );
    // E46: bridged TEP Deliveries settle on keccakEvidenceHash(exact bytes); bare envelopes
    // keep envelope JCS keccak (evaluation / legacy TaskEngine path).
    const recomputed = deliveryClaimEvidenceHash(exactFetchedBytes);
    let parsedDocument: unknown;
    try {
      parsedDocument = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exactFetchedBytes));
    } catch {
      throw new Error('delivery claim: IPFS payload is not valid JSON');
    }
    // E43: converged Deliveries pin a sealed TEP Delivery with the legacy envelope nested
    // under the bridge extension — unwrap before SignedEnvelopeSchema (same preference as
    // the evaluation read path above). Bare envelopes (pre-bridge fixtures) pass through.
    const envelopeSource = signedEnvelopeJsonFromDeliveryOrRaw(parsedDocument);
    const parsed = SignedEnvelopeSchema.parse(envelopeSource);

    const role = normalizeEnvelopeRole(parsed.role);
    if (role === 'capture') {
      throw new Error(`unsupported delivery envelope role=capture for requestId ${requestId}`);
    }
    const kind = role === 'verdict' ? 'verdict' : 'solution';
    const payload = (envelopeSource as Record<string, unknown>)['payload'];
    const verdictCode = kind === 'verdict'
      ? this.verdictCodeFromEnvelopePayload(parsed.solverType, payload)
      : undefined;

    return {
      evidenceHash: recomputed as Hex,
      kind,
      verdictCode,
    };
  }

  private verdictCodeFromEnvelopePayload(solverType: string, payload: unknown): VerdictCode {
    if (payload == null || typeof payload !== 'object') {
      throw new Error(
        `missing verdict payload for solverType=${solverType}; refusing to claim Invalid(3) without an explicit evaluator verdict`,
      );
    }
    const record = payload as Record<string, unknown>;
    const rawVerdict = record['verdict'];
    if (rawVerdict !== undefined) return verdictCodeFromValue(rawVerdict);

    if (solverType === 'swe-rebench-v2.v1') {
      const passedMatch = record['passed_match'];
      if (typeof passedMatch === 'boolean') {
        return passedMatch ? VerdictCode.Pass : VerdictCode.Fail;
      }
    }

    throw new Error(
      `missing verdict signal for solverType=${solverType}; refusing to claim Invalid(3) without an explicit evaluator verdict`,
    );
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
        this.config.broadcaster,
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
      // (`skipped` / `already-claimed`) are not failures and intentionally do not emit.
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

  private engineOwnsAutopilotSettlement(requestId: string): boolean {
    const live = this.originalStates.get(requestId) ?? this.pendingEvaluations.get(requestId);
    if (live !== undefined) {
      const spec = live.spec;
      return (
        live.solverType === 'jinn-repo.v1'
        && spec !== null
        && typeof spec === 'object'
        && (spec as Record<string, unknown>)['source'] === 'autopilot-session'
      );
    }
    if (this.store === undefined) return false;
    try {
      return this.store.engagementIsAutopilotSession(requestId);
    } catch (error) {
      console.error(
        `[mech] refusing legacy delivery settlement for ${requestId}: `
        + `Autopilot ownership lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
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
      // #116: pin the mech `Deliver` topic server-side rather than fetching the
      // whole address and decode-discarding. Range/chunking unchanged.
      const logs = await this.publicClient.getLogs({
        address: this.config.mechContractAddress,
        event: MECH_DELIVER_EVENT,
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
            const engineOwnsSettlement =
              this.engineOwnsAutopilotSettlement(requestId);
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
            if (iDelivered && !engineOwnsSettlement) {
              deliveryClaimStatus = await this.ensureDeliveryClaimed(requestId, deliveryDataHex);
              if (deliveryClaimStatus === 'retry') continue;
            }

            // (b) Task-side claim path: if this request came from our Task
            //     claim, make sure JinnRouterV3 records the Solution submission.
            if (
              iCreatedRestoration
              && !engineOwnsSettlement
              && deliveryClaimStatus !== 'claimed'
              && deliveryClaimStatus !== 'already-claimed'
            ) {
              const creatorClaimStatus = await this.ensureDeliveryClaimed(requestId, deliveryDataHex);
              if (creatorClaimStatus === 'retry') continue;
            }

            // (c) Yield the delivery result.
            try {
              const deliveryDigest = deliveryDataHex.startsWith('0x') ? deliveryDataHex.slice(2) : deliveryDataHex;
              const resultPayload = await fetchFromIpfs(
                this.config.ipfsGatewayUrl,
                `f01551220${deliveryDigest}`,
                this.ipfsFetchOpts(),
              ) as Record<string, unknown>;

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
          rpcUrl: rpcUrlForDisplay(this.config.rpcUrl),
          contract: this.config.mechContractAddress,
          fromBlock: this.deliveryBlockCursor + 1n,
        }));
      }

      // Cursor persistence is per-chunk inside the loop above (#552). A poll
      // that did no chunked work has no progress to persist.

      // Wave-4 D6 dropped the `delivery-watcher` LOOP_REGISTRY row. This
      // generator is still orphaned (stage 5 / `legacy-operator-composition`);
      // it no longer stamps a heartbeat the watchdog does not read.
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
