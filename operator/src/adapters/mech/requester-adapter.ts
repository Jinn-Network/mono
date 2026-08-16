import { getAddress, keccak256, toBytes, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type {
  ExecutionAdapter,
  PostTaskOptions,
  RecoverTaskPostInput,
} from '../adapter.js';
import type {
  Task,
  RequestId,
  PostedTask,
  TaskAnnouncement,
  TaskRequest,
  TaskResult,
  DeliveredResult,
} from '../../types/index.js';
import { PermanentError } from '../../types/index.js';
import { createClients } from './safe.js';
import { uploadToIpfs, cidToDigestHex } from './ipfs.js';
import {
  submitTask,
  getMechDeliveryRate,
  getTimeoutBounds,
  scanTasks,
  PendingTaskSubmissionError,
  type RouterTaskPolicy,
} from './contracts.js';
import { manifestDigestForCid } from './digest.js';
import { signTaskV1 } from '../../tasks/signing.js';
import { type MechAdapterConfig } from './types.js';
import type { SignedTaskV1, TaskClaimPolicy, TaskV1 } from '../../types/task-document.js';
import { withRecoverableRetry } from '../../tx-retry.js';
import { formatRpcError } from '../../rpc-error-context.js';

/**
 * The requester slice of the legacy mech `ExecutionAdapter` — the ONLY surface
 * `jinn tasks submit` (via `cli/execution-context.ts` → `TaskPostingService`)
 * needs from the mech adapter. It is carved out of `adapters/mech/adapter.ts`
 * so that file — the legacy operator/harness/evaluation machinery — can be
 * deleted in the Phase D one-swap without breaking the CLI posting path
 * (one-swap R4, part of #2461). The posting logic here is behavior-identical to
 * the extracted `MechAdapter.postTask` / `recoverTaskPost`; it drops only the
 * `canonicalTaskCreationProvenance` write, which the full adapter used solely to
 * feed its own watch/evaluation loops (never exercised by a one-shot CLI post).
 *
 * The harness / evaluation / delivery half of `ExecutionAdapter` is intentionally
 * unimplemented (throwing stubs): a requester never claims, solves, or evaluates.
 */

/**
 * Coalesce a string-or-array RPC input down to the head URL for error context
 * (`formatRpcError` expects a single host).
 */
function rpcUrlForDisplay(rpcUrl: string | readonly string[]): string {
  return Array.isArray(rpcUrl) ? rpcUrl[0]! : (rpcUrl as string);
}

/**
 * Floor block for the on-chain TaskCreated backlog scan used by
 * `recoverTaskPost`, per chain. Mirrors the constant in `adapters/mech/adapter.ts`
 * (kept local so this keeper carries no dependency on the retiring file).
 */
const DEFAULT_TASK_DISCOVERY_FROM_BLOCK: Record<number, bigint> = {
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
 * caller only supplies a legacy `solverType`, derive the BINDING fields from its
 * `<id>.<version>` shape; fall back to `('legacy', 'v0')` so signing never
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

export class MechRequesterAdapter implements ExecutionAdapter {
  readonly name = 'mech-requester';

  private publicClient!: PublicClient;
  private walletClient!: WalletClient;
  private readonly config: MechAdapterConfig;

  constructor(config: MechAdapterConfig) {
    this.config = config;
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

    // Probe the RPC once so a dead endpoint surfaces here (the CLI wraps this in
    // a `transient_error` envelope), rather than deep inside the first posting
    // call. Mirrors the head read `MechAdapter.initialize` performs.
    await withRecoverableRetry(
      async () => this.publicClient.getBlockNumber(),
      {
        onRetry: ({ attempt, message }) => {
          console.error(
            `[mech-requester] getBlockNumber retry ${attempt}: ` +
            formatRpcError(message, {
              operation: 'getBlockNumber',
              chain: this.config.chainId === 84532 ? 'base-sepolia' : 'base',
              rpcUrl: rpcUrlForDisplay(this.config.rpcUrl),
            }),
          );
        },
      },
    );
  }

  async postTask(state: Task, options?: PostTaskOptions): Promise<PostedTask> {
    const restorationState: Task = {
      ...state,
      role: state.role ?? 'restoration',
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
    };
    const signedTask = state.signedTask ?? await this.signTaskDocument(restorationState);
    // Upload the canonical signed Task document so watchers can verify and parse
    // the same task.v1 shape the creator signed.
    const restorationCid = await uploadToIpfs(this.config.ipfsRegistryUrl, signedTask);
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
    // on-chain digest is manifest-bound — `keccak256(manifestCid)`.
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

    return {
      taskId: taskSubmission.taskId,
      taskCid: restorationTaskCid,
      txHash: taskSubmission.txHash,
      blockNumber: taskSubmission.blockNumber,
    };
  }

  async recoverTaskPost(input: RecoverTaskPostInput): Promise<PostedTask | null> {
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
    // (`allowSolverSelfEvaluation`). `allowSolverSelfEvaluation` comes from the
    // off-chain `claimPolicy` when set explicitly; when absent the default is
    // network-keyed: TRUE on testnet (84532) for solo dogfooding, FALSE on
    // mainnet to preserve the independent-evaluation invariant.
    const claimPolicy = state.claimPolicy ?? DEFAULT_MECH_CLAIM_POLICY;
    const isTestnet = this.config.chainId === 84532;
    return {
      maxClaims: claimPolicy.maxClaims,
      allowSolverSelfEvaluation: claimPolicy.allowSolverSelfEvaluation ?? isTestnet,
    };
  }

  // ---------------------------------------------------------------------------
  // Requester-only: the harness / evaluation / delivery surface of
  // ExecutionAdapter is never reached from a posting flow. Implemented as loud
  // stubs so a mis-wire fails fast rather than silently no-op'ing.
  // ---------------------------------------------------------------------------

  private unsupported(method: string): PermanentError {
    return new PermanentError(
      `MechRequesterAdapter is a requester-only adapter; ${method} is not supported.`,
    );
  }

  // eslint-disable-next-line require-yield
  async *watchForTasks(): AsyncGenerator<TaskAnnouncement> {
    throw this.unsupported('watchForTasks');
  }

  async claimTask(_taskId: string): Promise<TaskRequest> {
    throw this.unsupported('claimTask');
  }

  async submitResult(_requestId: RequestId, _result: TaskResult): Promise<void> {
    throw this.unsupported('submitResult');
  }

  // eslint-disable-next-line require-yield
  async *watchForDeliveries(): AsyncGenerator<DeliveredResult> {
    throw this.unsupported('watchForDeliveries');
  }

  async stop(): Promise<void> {
    // No long-running resources to release — nothing to do.
  }
}
