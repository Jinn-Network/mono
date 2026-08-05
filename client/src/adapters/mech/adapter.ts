import { getAddress, type Address, type Hex, type Log, type PublicClient, type WalletClient } from 'viem';
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
import { TransientError, PermanentError, parseTask } from '../../types/index.js';
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
  fetchSignedEnvelopeFromIpfs,
  fetchRawBytesFromIpfs,
  digestHexToGatewayUrl,
} from './ipfs.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { normalizeEnvelopeRole, SignedEnvelopeSchema } from '../../types/envelope.js';
import {
  deliveryClaimEvidenceHash,
  legacyRestorationResultFromDelivery,
  signedEnvelopeJsonFromDeliveryOrRaw,
} from '../../daemon/bridge-legacy-delivery.js';
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
  ROUTER_DISCOVERY_EVENTS,
  MECH_DELIVER_EVENT,
  findLatestDeliveryDataHexForRequest,
  getMarketplaceRequestDeliveryMech,
  getTaskCidDigest,
  callDeliverToMarketplace,
  canClaimTask,
  canClaimEvaluation,
  type RouterTaskPolicy,
  type DecodedTaskCreated,
  scanTasks,
  PendingTaskSubmissionError,
} from './contracts.js';
import { type MechAdapterConfig } from './types.js';
import {
  SafeInnerRevertError,
  formatDecodedRevert,
  isNonRecoverableInnerRevert,
} from './safe-revert.js';
import { VerdictCode, verdictCodeFromValue } from './verdict-code.js';
import { manifestDigestForCid } from './digest.js';
import type { DiscoveryAPI } from '../../discovery/types.js';
import type { Store } from '../../store/store.js';
import { TaskRunPersistence } from '../../harnesses/engine/persistence.js';
import { recordLoopTick } from '../../daemon/loop-heartbeat.js';
import { emitStructured } from '../../events/emitter.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import { formatRpcError } from '../../rpc-error-context.js';
import {
  SOLUTION_ENVELOPE_CID_CONTEXT_KEY,
  SOLUTION_TASK_CID_CONTEXT_KEY,
  RESTORATION_TASK_CID_CONTEXT_KEY,
  AUTOPILOT_EVALUATION_CONTEXT_KEY,
} from '../../harnesses/impls/evaluation-context.js';
import {
  JinnRepoAutopilotSessionTaskSchema,
  JinnRepoAutopilotSolutionPayloadSchema,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  admitAutopilotEvaluationOpportunity,
} from '../../harnesses/impls/jinn-repo-evaluator/autopilot-evaluation-context.js';
import { signTaskV1 } from '../../tasks/signing.js';
import type { SignedTaskV1, TaskClaimPolicy, TaskV1 } from '../../types/task-document.js';

interface PendingEvaluationSolution {
  taskId: string;
  attemptIndex: number;
  requestId: string;
  operator: string;
  transactionHash?: Hex;
  blockNumber?: number;
  /**
   * Defense-in-depth backstop for #645: count of consecutive failures (catch-arm
   * throws or transient `canClaimEvaluation` reverts) for this requestId.
   * Persisted across restarts so a wedge can't re-spam the log after every
   * daemon bounce. Pruned once it exceeds MAX_EVALUATION_RETRY_ATTEMPTS.
   */
  failedAttempts?: number;
}

interface CanonicalTaskCreationProvenance {
  onchainCreationTx: `0x${string}`;
  onchainCreationBlock: number;
}

function taskCreationProvenanceFromSolutionEnvelope(
  value: unknown,
): CanonicalTaskCreationProvenance | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const task = (value as Record<string, unknown>)['task'];
  if (typeof task !== 'object' || task === null) return undefined;
  const record = task as Record<string, unknown>;
  const tx = record['onchainCreationTx'];
  const block = record['onchainCreationBlock'];
  if (
    typeof tx !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(tx)
    || typeof block !== 'number'
    || !Number.isSafeInteger(block)
    || block < 0
  ) {
    return undefined;
  }
  return {
    onchainCreationTx: tx as `0x${string}`,
    onchainCreationBlock: block,
  };
}

const ROUTER_REQUEST_CURSOR_CONFIG_KEY = 'mech_router_request_block_cursor_v1';
const PENDING_EVALUATION_SOLUTIONS_CONFIG_KEY = 'mech_pending_evaluation_solutions_v1';
const DEFAULT_MECH_DELIVER_BACKFILL_LOOKBACK_BLOCKS = 100_000n;

/** Yield to the event loop every N evaluation opportunities so a large retry
 *  backlog can't starve the HTTP API mid-cycle. */
const EVALUATION_RETRY_YIELD_EVERY = 10;

/**
 * Bound the number of consecutive transient/uncaught failures for a single
 * pending evaluation solution. Once exceeded, the solution is pruned from
 * `pendingEvaluationSolutions` to stop unbounded log spam (#645). At default
 * pollIntervalMs=5000, twenty cycles ≈ 100 s — comfortably above a normal
 * transient RPC outage window, well below "spamming the log forever".
 *
 * The signal-driven prunes (terminal claimability, `null` delivery-envelope
 * CID per #553, !isDiscoveryTaskAllowed) still fire on their own conditions;
 * this counter is the backstop for failure modes that don't surface a clean
 * terminal signal.
 */
const MAX_EVALUATION_RETRY_ATTEMPTS = 20;

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
  /**
   * TaskCreated anchors observed directly from router logs (or our own
   * confirmed createTask receipt). Evaluator envelopes are solver-controlled,
   * so their embedded anchors are only claims until they match this chain
   * source.
   */
  private canonicalTaskCreationProvenance = new Map<string, CanonicalTaskCreationProvenance>();
  private requestKinds = new Map<string, 'solution' | 'verdict'>();
  private evaluationOpportunities = new Map<string, {
    taskId: string;
    attemptIndex: number;
    task: Task;
    onchainCreationTx?: `0x${string}`;
    onchainCreationBlock?: number;
  }>();
  private pendingEvaluationSolutions = new Map<string, PendingEvaluationSolution>();
  // Original Tasks keyed by request ID (restoration and evaluation)
  // so we can yield accurate Task in DeliveredResult
  private originalStates = new Map<string, Task>();
  private store?: Store;
  private taskRuns: TaskRunPersistence | undefined;

  constructor(config: MechAdapterConfig, store?: Store) {
    this.config = config;
    this.store = store;
  }

  /**
   * Whether this operator participates as an evaluator. Undefined ⇒ enabled
   * (opt-out default). Gates evaluation-opportunity ingest, boot rehydrate, and
   * per-cycle scan (#547).
   */
  private get evaluatorEnabled(): boolean {
    return this.config.evaluatorEnabled !== false;
  }

  /** Maps config pin → core `FetchFromIpfsOptions` (omit when unset = production ipfs.io). */
  private ipfsFetchOpts(): { fallbackGatewayBase?: string | false } | undefined {
    const fallback = this.config.ipfsFallbackGatewayUrl;
    if (fallback === undefined) return undefined;
    return { fallbackGatewayBase: fallback };
  }

  /**
   * Enable the evaluator role at runtime after a live SolverNet join (a join
   * never removes a role, so turning it back off is never needed). #547.
   */
  public setEvaluatorEnabled(enabled: boolean): void {
    this.config.evaluatorEnabled = enabled;
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

    // Recover pending state from on-chain events
    if (this.store) {
      // #547: only rehydrate the evaluation-opportunity set for evaluators.
      // recoverPendingState recovers this operator's own in-flight restoration
      // claims (router cursor + TaskCreated scan), not the evaluation set, so it
      // stays unguarded.
      if (this.evaluatorEnabled) {
        this.loadPendingEvaluationSolutions();
      }
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

  private async getRouterLogsInChunks(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    const logs: Log[] = [];
    for (let start = fromBlock; start <= toBlock; start += DEFAULT_ROUTER_LOG_CHUNK_BLOCKS + 1n) {
      const end = start + DEFAULT_ROUTER_LOG_CHUNK_BLOCKS > toBlock
        ? toBlock
        : start + DEFAULT_ROUTER_LOG_CHUNK_BLOCKS;
      // #116: filter server-side to the two router events the poll loop decodes
      // (TaskCreated + SolutionDeliveryClaimed) via an OR-of-topic0, instead of an
      // address-only scan that decode-discards the rest. Chunking is unchanged —
      // a topic filter shrinks the result set, not the permitted block range.
      logs.push(...await this.publicClient.getLogs({
        address: this.config.routerAddress,
        events: ROUTER_DISCOVERY_EVENTS,
        fromBlock: start,
        toBlock: end,
      }) as Log[]);
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
          // #645: clamp to a non-negative integer. A tampered or corrupted
          // store row carrying a negative or fractional failedAttempts could
          // otherwise underflow the prune budget (e.g. -1_000_000_000 would
          // defeat the bound for ~10^9 cycles).
          failedAttempts:
            typeof item.failedAttempts === 'number' && Number.isFinite(item.failedAttempts)
              ? Math.max(0, Math.floor(item.failedAttempts))
              : 0,
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

  /**
   * Increment the per-solution failure counter and prune when it exceeds the
   * MAX_EVALUATION_RETRY_ATTEMPTS budget. Persistence runs on every increment
   * so a crash mid-cycle does not lose the count (and let a wedge resume
   * log-spamming after a restart).
   *
   * Call sites: ONLY the two paths that fail to make progress on this specific
   * solution — the transient `canClaimEvaluation` branch in
   * evaluationAnnouncementForSolution, and the `catch (err)` arm of
   * retryPendingEvaluationSolutions. Do NOT call from the signal-driven prune
   * paths (terminal claimability, null delivery-envelope CID,
   * !isDiscoveryTaskAllowed) — those already prune cleanly.
   *
   * Returns true when the solution was pruned (caller should stop work on it).
   */
  private recordEvaluationFailureAndMaybePrune(
    solution: PendingEvaluationSolution,
  ): boolean {
    const next = (solution.failedAttempts ?? 0) + 1;
    solution.failedAttempts = next;
    if (next > MAX_EVALUATION_RETRY_ATTEMPTS) {
      console.log(
        `[mech] pruning evaluation opportunity ${solution.requestId} for task ${solution.taskId}/${solution.attemptIndex}: ` +
          `exceeded retry budget (${MAX_EVALUATION_RETRY_ATTEMPTS}) — pruned`,
      );
      this.forgetPendingEvaluationSolution(solution.requestId);
      return true;
    }
    this.persistPendingEvaluationSolutions();
    return false;
  }

  /** Prune terminal evaluation state so the poll loop stops retrying (#512). */
  private pruneTerminalEvaluationOpportunity(params: {
    opportunityId?: string;
    solutionRequestId?: string;
    reason: string;
  }): void {
    const { opportunityId, solutionRequestId, reason } = params;
    const target = opportunityId ?? solutionRequestId ?? 'unknown';
    console.log(
      `[mech] pruning evaluation opportunity ${target}: ${reason} (terminal — pruned)`,
    );
    if (opportunityId) {
      this.evaluationOpportunities.delete(opportunityId);
      this.observedTasks.delete(opportunityId);
    }
    if (solutionRequestId) {
      this.forgetPendingEvaluationSolution(solutionRequestId);
    }
  }

  private async claimEvaluationWithTerminalPrune(
    opportunityId: string,
    evaluationOpportunity: {
      taskId: string;
      attemptIndex: number;
      task: Task;
    },
    evaluationTaskCidDigest: Hex,
  ): Promise<{
    taskId: string;
    attemptIndex: number;
    verdictIndex: number;
    requestId: string;
    txHash: Hex;
    blockNumber?: number;
  }> {
    try {
      return await this.claimEvaluation(
        evaluationOpportunity.taskId,
        evaluationOpportunity.attemptIndex,
        evaluationTaskCidDigest,
      );
    } catch (err) {
      if (err instanceof SafeInnerRevertError && isNonRecoverableInnerRevert(err.decodedName)) {
        this.pruneTerminalEvaluationOpportunity({
          opportunityId,
          solutionRequestId: evaluationOpportunity.task.restorationRequestId,
          reason: formatDecodedRevert(err.decodedName!, err.decodedArgs),
        });
      }
      throw err;
    }
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
    if (
      taskSubmission.txHash
      && taskSubmission.blockNumber !== undefined
    ) {
      this.canonicalTaskCreationProvenance.set(taskSubmission.taskId, {
        onchainCreationTx: taskSubmission.txHash,
        onchainCreationBlock: taskSubmission.blockNumber,
      });
    }

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

  private buildEvaluationTask(params: {
    task: Task;
    solutionRequestId: string;
    attemptIndex: number;
    resultData: string;
    solutionEnvelopeCid: string;
    taskCid?: string;
    autopilotEvaluationContext?: Record<string, unknown>;
  }): Task {
    // Strip the restoration execution-profile pin. It asserts against the
    // solver harness/model/version; evaluation resolves a different Harness
    // (issue #2165 / PR #2081). Leaving it would false-reject the evaluator.
    // Also strip nested signedTask.executionRequest so parseTask cannot
    // rehydrate the solver pin (issue #2169).
    const {
      executionRequest: _solverProfile,
      signedTask: restorationSignedTask,
      ...restorationTask
    } = params.task;
    let signedTask = restorationSignedTask;
    if (signedTask?.executionRequest !== undefined) {
      const { executionRequest: _nestedProfile, ...signedWithoutProfile } = signedTask;
      signedTask = signedWithoutProfile;
    }
    return {
      ...restorationTask,
      ...(signedTask !== undefined ? { signedTask } : {}),
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
        ...(params.autopilotEvaluationContext
          ? {
              [AUTOPILOT_EVALUATION_CONTEXT_KEY]:
                params.autopilotEvaluationContext,
            }
          : {}),
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
    const signed = await fetchSignedTaskFromIpfs(
      this.config.ipfsGatewayUrl,
      taskCid,
      this.ipfsFetchOpts(),
    );
    const task = parseTask({ signedTask: signed });
    const announcement: TaskAnnouncement = {
      taskId,
      task,
      taskCid,
    };
    this.restorationBodyCache.set(taskId, announcement);
    return announcement;
  }

  private rememberCanonicalTaskCreated(event: DecodedTaskCreated): void {
    if (
      event.transactionHash === undefined
      || !/^0x[0-9a-fA-F]{64}$/.test(event.transactionHash)
      || event.blockNumber === undefined
      || !Number.isSafeInteger(event.blockNumber)
      || event.blockNumber < 0
    ) {
      return;
    }
    this.canonicalTaskCreationProvenance.set(event.taskId, {
      onchainCreationTx: event.transactionHash,
      onchainCreationBlock: event.blockNumber,
    });
  }

  private async canonicalTaskCreationForEvaluation(
    taskId: string,
    opportunityBlock?: number,
  ): Promise<CanonicalTaskCreationProvenance> {
    const cached = this.canonicalTaskCreationProvenance.get(taskId);
    if (cached) return cached;

    const toBlock = opportunityBlock !== undefined
      ? BigInt(opportunityBlock)
      : await this.publicClient.getBlockNumber();
    const fromBlock = this.taskAdmissionFloorBlock() ?? 0n;
    if (fromBlock <= toBlock) {
      const logs = await this.getRouterLogsInChunks(fromBlock, toBlock);
      for (const event of decodeTaskCreatedLogs(logs)) {
        this.rememberCanonicalTaskCreated(event);
      }
    }

    const resolved = this.canonicalTaskCreationProvenance.get(taskId);
    if (!resolved) {
      throw new Error(
        `evaluation task ${taskId} has no canonical TaskCreated provenance in router logs`,
      );
    }
    return resolved;
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

    const discoveryFloorBlock = this.taskAdmissionFloorBlock();

    for (const candidate of candidates) {
      if (!this.isDiscoveryTaskAllowed(candidate.taskId)) continue;

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
        const announcement = await this.restorationAnnouncementFromDigest({
          taskId: candidate.taskId,
          taskCidDigest: candidate.taskCidDigest,
          transactionHash: candidate.createdAtTx,
          blockNumber: candidate.createdAtBlock,
        });

        if (this.hasExpiredExecutionWindow(announcement)) continue;

        yield announcement;
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
        this.pruneTerminalEvaluationOpportunity({
          solutionRequestId: solution.requestId,
          reason: claimable.reason,
        });
      } else {
        // #645 backstop: bound retries on transient/unclassified claimability
        // failures so a wedged opportunity can't log-spam forever.
        this.recordEvaluationFailureAndMaybePrune(solution);
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
      this.pruneTerminalEvaluationOpportunity({
        solutionRequestId: solution.requestId,
        reason:
          `no Deliver event found within configured lookback for task ${solution.taskId}/${solution.attemptIndex}`,
      });
      return undefined;
    }
    const resultPayload = await fetchFromIpfs(
      this.config.ipfsGatewayUrl,
      solutionEnvelopeCid,
      this.ipfsFetchOpts(),
    ) as Record<string, unknown>;
    // E43/E44: IPFS may hold a sealed TEP Delivery with the bridge envelope nested. Unwrap
    // before reading provenance / result data (same preference as deliveryClaimForDelivery).
    const envelopeDocument = signedEnvelopeJsonFromDeliveryOrRaw(resultPayload) as Record<string, unknown>;
    let creationProvenance = taskCreationProvenanceFromSolutionEnvelope(envelopeDocument);
    if (!creationProvenance && typeof envelopeDocument.data === 'string') {
      try {
        creationProvenance = taskCreationProvenanceFromSolutionEnvelope(
          JSON.parse(envelopeDocument.data),
        );
      } catch {
        // Legacy non-envelope result payload. The fail-closed check below
        // keeps it out of the new provenance-bearing writer path.
      }
    }
    const canonicalCreationProvenance =
      await this.canonicalTaskCreationForEvaluation(
        solution.taskId,
        solution.blockNumber,
      );
    // Bridge-era envelopes (buildLegacyExecutionEnvelope) carry placeholder creation tx/block;
    // when the nested envelope lacks valid provenance, trust the on-chain TaskCreated SoT.
    if (!creationProvenance) {
      creationProvenance = canonicalCreationProvenance;
    } else if (
      creationProvenance.onchainCreationTx.toLowerCase()
        !== canonicalCreationProvenance.onchainCreationTx.toLowerCase()
      || creationProvenance.onchainCreationBlock
        !== canonicalCreationProvenance.onchainCreationBlock
    ) {
      throw new Error(
        `evaluation opportunity ${solution.requestId} solution-envelope provenance `
        + `does not match canonical TaskCreated provenance for task ${solution.taskId}`,
      );
    }
    // Bridge read path (cutover stage 1, Task 15, coordinator amendment 4 / D3): prefer the
    // `deliveryExtensions` bridge annotation when the converged Delivery carries one. Read-path
    // preference only — no state-machine change, no schema change, no new transaction.
    const bridgedResultData = legacyRestorationResultFromDelivery(
      new TextEncoder().encode(JSON.stringify(resultPayload)),
    );
    const resultData =
      bridgedResultData
      ?? (typeof envelopeDocument.data === 'string' ? envelopeDocument.data : undefined)
      ?? JSON.stringify(envelopeDocument);
    let autopilotEvaluationContext: Record<string, unknown> | undefined;
    if (
      restoration.task.spec?.['source'] === 'autopilot-session'
    ) {
      const parsedTask = JinnRepoAutopilotSessionTaskSchema.safeParse(
        restoration.task.spec,
      );
      if (!parsedTask.success) {
        console.log(
          `[mech] keeping Autopilot evaluation opportunity ${solution.requestId} pending: malformed source Task`,
        );
        return undefined;
      }

      let parsedEnvelope: ReturnType<typeof SignedEnvelopeSchema.safeParse>;
      try {
        parsedEnvelope = SignedEnvelopeSchema.safeParse(JSON.parse(resultData));
      } catch {
        console.log(
          `[mech] keeping Autopilot evaluation opportunity ${solution.requestId} pending: malformed Solution envelope`,
        );
        return undefined;
      }
      if (
        !parsedEnvelope.success
        || parsedEnvelope.data.solverType !== 'jinn-repo.v1'
        || normalizeEnvelopeRole(parsedEnvelope.data.role) !== 'solution'
      ) {
        console.log(
          `[mech] keeping Autopilot evaluation opportunity ${solution.requestId} pending: invalid Solution envelope`,
        );
        return undefined;
      }
      const parsedSolution = JinnRepoAutopilotSolutionPayloadSchema.safeParse(
        parsedEnvelope.data.payload,
      );
      if (!parsedSolution.success) {
        console.log(
          `[mech] keeping Autopilot evaluation opportunity ${solution.requestId} pending: invalid mutation result`,
        );
        return undefined;
      }

      const observation =
        await this.config.autopilotEvaluationContextResolver?.resolve({
          task: parsedTask.data,
          solution: parsedSolution.data,
          taskId: solution.taskId,
          attemptIndex: solution.attemptIndex,
          requestId: solution.requestId,
          solutionEnvelopeCid,
          solutionOperatorSafe: solution.operator,
          evaluatorOperatorSafe: this.config.safeAddress,
        });
      const admission = admitAutopilotEvaluationOpportunity({
        task: parsedTask.data,
        solution: parsedSolution.data,
        taskId: solution.taskId,
        attemptIndex: solution.attemptIndex,
        requestId: solution.requestId,
        solutionEnvelopeCid,
        solutionOperatorSafe: solution.operator,
        evaluatorOperatorSafe: this.config.safeAddress,
        observation,
      });
      if (admission.kind !== 'accepted') {
        console.log(
          `[mech] keeping Autopilot evaluation opportunity ${solution.requestId} pending: ${admission.reason}`,
        );
        return undefined;
      }
      autopilotEvaluationContext =
        admission.context as unknown as Record<string, unknown>;
    }
    const evaluationTask = this.buildEvaluationTask({
      task: restoration.task,
      solutionRequestId: solution.requestId,
      attemptIndex: solution.attemptIndex,
      resultData,
      solutionEnvelopeCid,
      taskCid: restoration.taskCid,
      autopilotEvaluationContext,
    });
    const opportunityId = `evaluation:${solution.taskId}:${solution.attemptIndex}:${solution.requestId}`;
    const announcement: TaskAnnouncement = {
      taskId: opportunityId,
      task: evaluationTask,
      taskCid: restoration.taskCid,
      onchainCreationTx: canonicalCreationProvenance.onchainCreationTx,
      onchainCreationBlock: canonicalCreationProvenance.onchainCreationBlock,
      onchainOpportunityTx: solution.transactionHash,
      onchainOpportunityBlock: solution.blockNumber,
    };
    this.evaluationOpportunities.set(opportunityId, {
      taskId: solution.taskId,
      attemptIndex: solution.attemptIndex,
      task: evaluationTask,
      onchainCreationTx: canonicalCreationProvenance.onchainCreationTx,
      onchainCreationBlock: canonicalCreationProvenance.onchainCreationBlock,
    });
    this.observedTasks.set(opportunityId, announcement);
    // #645: a successful announcement means the candidate has made progress;
    // reset the transient-failure counter so that subsequent transient errors
    // (e.g. IPFS hiccups in the announce → claim window) don't accumulate
    // across the candidate's lifetime and silently false-prune legitimate work.
    if (solution.failedAttempts) {
      solution.failedAttempts = 0;
      this.persistPendingEvaluationSolutions();
    }
    return announcement;
  }

  private async *retryPendingEvaluationSolutions(): AsyncIterable<TaskAnnouncement> {
    if (!this.evaluatorEnabled) return; // #547: non-evaluators never scan.
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
        // #645 backstop: bound retries on any uncaught failure so a wedged
        // requestId (e.g. an RPC failure path that re-throws every cycle)
        // can't log-spam forever.
        this.recordEvaluationFailureAndMaybePrune(solution);
      }
    }
  }

  async *watchForTasks(): AsyncIterable<TaskAnnouncement> {
    while (!this.stopped) {
      try {
        for await (const announcement of this.retryPendingEvaluationSolutions()) {
          yield announcement;
        }

        // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
        // Task 16): the solution path retires — watchForTasks yields only evaluation
        // announcements now. discoverSubgraphRestorationTasks() and the joined-manifest-digest
        // filter below (the joinedSolverNets claim gate the retirement table names) are no
        // longer called from here.

        const currentBlock = await this.publicClient.getBlockNumber();
        if (currentBlock > this.requestBlockCursor) {
          const fromBlock = this.requestBlockCursor + 1n;
          const logs = await this.getRouterLogsInChunks(fromBlock, currentBlock);

          // #547: only evaluators ingest delivery-claimed logs into the
          // pending-evaluation set.
          if (this.evaluatorEnabled) {
            const submittedSolutions = decodeSolutionDeliveryClaimedLogs(logs);
            for (const solution of submittedSolutions) {
              this.rememberPendingEvaluationSolution(solution);
            }
          }

          // Retained: the evaluation provenance cross-check
          // (canonicalTaskCreationForEvaluation) reads canonicalTaskCreationProvenance.
          const createdTasks = decodeTaskCreatedLogs(logs);
          for (const event of createdTasks) {
            this.rememberCanonicalTaskCreated(event);
          }
          for await (const announcement of this.retryPendingEvaluationSolutions()) {
            yield announcement;
          }
          this.requestBlockCursor = currentBlock;
          if (this.store) {
            this.store.setConfigValue(ROUTER_REQUEST_CURSOR_CONFIG_KEY, currentBlock.toString());
          }
        }
      } catch (err) {
        console.error('[mech] Error polling for tasks:', formatRpcError(err, {
          operation: 'pollTaskCreated',
          chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
          rpcUrl: rpcUrlForDisplay(this.config.rpcUrl),
          contract: this.config.routerAddress,
          fromBlock: this.requestBlockCursor + 1n,
        }));
      }

      // #1043/#1038: heartbeat at the poll-cycle tail (every poll, even when
      // nothing was yielded) so an idle-but-polling loop never looks stale.
      // #2407 caveat (i): this for-await driver never routes through
      // `daemon/loop-heartbeat.ts`'s `runLoop`, so it doesn't consult
      // per-loop admission — but `engine-watcher` is registered
      // `admission: 'always'` (spec §5), so the omission is inert today. If
      // this loop is ever reclassified `ready-only`, gate the poll body on
      // `getDaemonReadiness() === 'ready'` here, the same way `engine-tick`
      // does in `harnesses/engine/engine.ts`'s `runTickLoop`.
      if (this.store) recordLoopTick(this.store, 'engine-watcher');
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async claimTask(taskId: string): Promise<TaskRequest> {
    const evaluationOpportunity = this.evaluationOpportunities.get(taskId);
    if (evaluationOpportunity) {
      const signedEvaluationTask = await this.signTaskDocument(evaluationOpportunity.task);
      const evaluationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, signedEvaluationTask);
      const evaluationTaskCidDigest = cidToDigestHex(evaluationCid);
      const claimed = await this.claimEvaluationWithTerminalPrune(
        taskId,
        evaluationOpportunity,
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
        onchainCreationTx: evaluationOpportunity.onchainCreationTx,
        onchainCreationBlock: evaluationOpportunity.onchainCreationBlock,
        onchainClaimTx: claimed.txHash,
        onchainClaimBlock: claimed.blockNumber,
      };
    }

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
      this.config.broadcaster,
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
      this.config.broadcaster,
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
      this.config.broadcaster,
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
    if (this.store === undefined) return false;
    try {
      this.taskRuns ??= new TaskRunPersistence(this.store.db);
      const run = this.taskRuns.getByRequestId(requestId);
      const spec = run?.task?.spec;
      return (
        run?.solverType === 'jinn-repo.v1'
        && spec !== null
        && typeof spec === 'object'
        && (spec as Record<string, unknown>)['source']
          === 'autopilot-session'
      );
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

      // #1043/#1038: heartbeat at the poll-cycle tail (every poll, even when
      // nothing was yielded) so an idle-but-polling loop never looks stale.
      // #2407 caveat (i): see the matching comment at engine-watcher's
      // heartbeat above — `delivery-watcher` is also `admission: 'always'`,
      // so not consulting admission here is inert today.
      if (this.store) recordLoopTick(this.store, 'delivery-watcher');
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
