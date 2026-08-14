import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type Chain,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import {
  callDeliverToMarketplace,
  claimDelivery,
  claimTask,
  getMechDeliveryRate,
  getTimeoutBounds,
} from '../../src/adapters/mech/contracts.js';
// Wave-4 D2 retired the mech adapter's evaluation half, and with it
// `contracts.ts`'s `claimEvaluation`. The surviving verdict transaction path is
// venue-base's verdict port (`packages/marketplace/venue-base/src/verdict.ts`) —
// Task 15's "exactly one verdict transaction path".
import { createVerdictPorts } from '@jinn-network/marketplace-venue-base';
import { createDirectSafeBroadcaster } from '../../src/adapters/mech/direct-safe-broadcaster.js';
import { JINN_ROUTER_ABI, MECH_ABI } from '../../src/adapters/mech/types.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from '../../src/earning/wallet.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../src/harnesses/engine/state.js';
import { PredictionV1Evaluator } from '../../src/harnesses/impls/prediction-v1-evaluator/index.js';
import { SOLUTION_ENVELOPE_CID_CONTEXT_KEY, SOLUTION_TASK_CID_CONTEXT_KEY } from '../../src/harnesses/impls/evaluation-context.js';
import type { Harness, HarnessContext, Solution } from '../../src/harnesses/types.js';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import { Store } from '../../src/store/store.js';
import { TaskPostingService } from '../../src/tasks/posting-service.js';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../../src/types/envelope.js';
import type { DeliveredResult, Task, TaskRequest } from '../../src/types/index.js';
import { PredictionV1TaskSchema } from '../../src/types/prediction-v1.js';
import { validatePayload } from '../../src/types/payloads/index.js';
import { TrajectoryCollector } from '../../src/trajectory/index.js';
import { allocateAnvilPort } from '../_support/chain/port-allocator.js';
import { jsonRpc as anvilJsonRpc, spawnAnvilFork } from '../_support/chain/anvil.js';
import { LaunchAction } from '../../src/solvernets/launch-state-machine.js';
import {
  IdentityRegistryBackedSolverNetRegistryClient,
} from '../../src/solvernets/registry-client-erc8004.js';
import { createSolverNetStore } from '../../src/solvernets/store.js';
import {
  buildSignedSolverNetManifestV1,
  createForkMetadataPublisher,
  createInMemoryIpfsClient,
  createInMemorySubgraphClient,
  manifestDigestForCid,
} from './_solvernet-helpers.js';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(E2E_DIR, '../../..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts');
const BASE_SEPOLIA_V3_DEPLOYMENT = join(
  CONTRACTS_DIR,
  'deployment-task-coordinator-router-v3-baseSepolia-fast.json',
);
const BASE_SEPOLIA_MECH_DEPLOYMENT = join(
  CONTRACTS_DIR,
  'deployment-phase1b-mech-baseSepolia-fast.json',
);
const BASE_SEPOLIA_ROUTER_CHECKER_DEPLOYMENT = join(
  CONTRACTS_DIR,
  'deployment-phase1b-router-checker-baseSepolia-fast.json',
);
const CLIENT_DEPLOYMENTS_DIR = join(REPO_ROOT, 'client', 'deployments');
const BASE_SEPOLIA_TOKEN_DEPLOYMENT = join(
  CLIENT_DEPLOYMENTS_DIR,
  'deployment-phase1a-token-baseSepolia-fast.json',
);
const BASE_SEPOLIA_STOLAS_DEPLOYMENT = join(
  CLIENT_DEPLOYMENTS_DIR,
  'deployment-stolas-l2-baseSepolia-fast.json',
);
const NATIVE_PAYMENT_TYPE =
  '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as const;
const ZERO_HASH = `0x${'00'.repeat(32)}` as const;
const BASE_SEPOLIA_E2E_FUNDING_WEI = 100n * 10n ** 18n;
const BASE_SEPOLIA_E2E_PASSWORD = 'jinn-task-first-fork-e2e';
const BASE_SEPOLIA_DISTRIBUTOR_STAKE_FLOAT = 1_000n * 10n ** 18n;

export const ANVIL_PRIVATE_KEYS = [
  '0x0000000000000000000000000000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000000000000000000000000000003',
  '0x0000000000000000000000000000000000000000000000000000000000000004',
] as const satisfies readonly Hex[];

export const JINN_ROUTER_V3_E2E_ABI = [
  ...JINN_ROUTER_ABI,
  {
    name: 'taskCoordinator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'mechMarketplace',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'activityChecker',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'refundUnusedTaskBudget',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
 {
    name: 'taskPayments',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [
      { name: 'creator', type: 'address' },
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'manifestDigest', type: 'bytes32' },
      { name: 'solutionMaxDeliveryRate', type: 'uint256' },
      { name: 'verdictMaxDeliveryRate', type: 'uint256' },
      { name: 'responseTimeout', type: 'uint256' },
      { name: 'solutionBudgetRemaining', type: 'uint256' },
      { name: 'verdictBudgetRemaining', type: 'uint256' },
      { name: 'solutionBudgetRefunded', type: 'bool' },
      { name: 'verdictBudgetRefunded', type: 'bool' },
    ],
  },
] as const satisfies Abi;

export const TASK_COORDINATOR_E2E_ABI = [
  {
    name: 'authorizedRouter',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getTask',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [{
      // Tokenless-OLAS pivot: TaskRecord trimmed — policy is now just `maxClaims`
      // and the final flag is `creatorCredited`. Field order is otherwise
      // unchanged, so positional `tupleField` reads (manifestDigest@2,
      // submittedCount@6) still resolve.
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
          ],
        },
        { name: 'claimCount', type: 'uint32' },
        { name: 'submittedCount', type: 'uint32' },
        { name: 'finalizedAttemptCount', type: 'uint32' },
        { name: 'creatorCredited', type: 'bool' },
      ],
    }],
  },
  {
    name: 'getAttempt',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'taskId', type: 'uint256' },
      { name: 'attemptIndex', type: 'uint32' },
    ],
    outputs: [{
      name: 'attempt',
      type: 'tuple',
      components: [
        { name: 'taskId', type: 'uint256' },
        { name: 'attemptIndex', type: 'uint32' },
        { name: 'operator', type: 'address' },
        { name: 'requestId', type: 'bytes32' },
        { name: 'solutionCidDigest', type: 'bytes32' },
        { name: 'solutionWeight', type: 'uint256' },
        { name: 'claimedAt', type: 'uint64' },
        { name: 'claimExpiresAt', type: 'uint64' },
        { name: 'submittedAt', type: 'uint64' },
        { name: 'status', type: 'uint8' },
        { name: 'finalization', type: 'uint8' },
        { name: 'verdictClaimCount', type: 'uint16' },
        { name: 'validVerdictCount', type: 'uint16' },
        { name: 'passVerdictCount', type: 'uint16' },
      ],
    }],
  },
  {
    name: 'getVerdictRequestRef',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'verdictRequestId', type: 'bytes32' }],
    outputs: [
      { name: 'taskId', type: 'uint256' },
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'verdictIndex', type: 'uint32' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    name: 'getRequestRef',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    outputs: [
      { name: 'taskId', type: 'uint256' },
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'exists', type: 'bool' },
    ],
  },
] as const satisfies Abi;

const ACTIVITY_CHECKER_E2E_ABI = [
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'authorizedRouter',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'setAuthorizedRouter',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'authorizedRouter', type: 'address' }],
    outputs: [],
  },
  {
    name: 'changeImplementation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newImplementation', type: 'address' }],
    outputs: [],
  },
  {
    name: 'taskCreationWeight',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'solutionDeliveryWeight',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'verdictDeliveryWeight',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'eligibleActivityWeight',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const JINN_UPGRADEABLE_PROXY_E2E_ABI = [
  {
    name: 'getImplementation',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getAdmin',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'upgradeTo',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newImplementation', type: 'address' }],
    outputs: [],
  },
] as const satisfies Abi;

const MINTABLE_ERC20_E2E_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export interface PhaseResult {
  name: string;
  ok: boolean;
  ms: number;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runPhase(name: string, fn: () => Promise<void>): Promise<PhaseResult> {
  const started = Date.now();
  process.stdout.write(`\n--- ${name} ---\n`);
  try {
    await fn();
    const ms = Date.now() - started;
    process.stdout.write(`ok (${ms}ms)\n`);
    return { name, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - started;
    process.stderr.write(`failed (${ms}ms): ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return { name, ok: false, ms };
  }
}

export function summarize(results: PhaseResult[]): void {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n=== Task-first e2e summary ===\n');
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} (${result.ms}ms)\n`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length}/${results.length} phases failed`);
  }
}

async function takeOne<T>(iterable: AsyncIterable<T>, label: string, timeoutMs = 5_000): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    assert(!result.done, `${label} ended without yielding`);
    return result.value;
  } finally {
    await iterator.return?.();
  }
}

export function makePredictionV1Task(now = Date.now()): Task {
  const window = {
    startTs: now - 1_000,
    endTs: now + 60_000,
  };
  const sampledAt = new Date(now - 10_000).toISOString();
  const expectedResolutionTime = new Date(now + 120_000).toISOString();
  const core = {
    id: 'prediction-v1-e2e',
    description: 'Will the test prediction market resolve YES?',
    solverType: 'prediction.v1' as const,
    window,
    spec: {
      question: {
        kind: 'binary' as const,
        text: 'Will the test prediction market resolve YES?',
        yesLabel: 'YES' as const,
        noLabel: 'NO' as const,
      },
      source: {
        type: 'prediction-market' as const,
        venue: 'polymarket' as const,
        url: 'https://polymarket.com/event/jinn-task-first-e2e',
        identifiers: {
          marketId: 'jinn-task-first-e2e',
          conditionId: '0xcondition-task-first-e2e',
          yesTokenId: 'yes-token-task-first-e2e',
          noTokenId: 'no-token-task-first-e2e',
        },
      },
      resolution: {
        expectedResolutionTime,
        rulesText: 'Test fixture resolves YES.',
        rulesUrl: 'https://example.com/jinn-task-first-e2e-rules',
      },
      consensusSnapshot: {
        sampledAt,
        probabilityYes: '0.68',
        method: 'best-bid-ask-midpoint' as const,
        bestBidYes: '0.67',
        bestAskYes: '0.69',
        spread: '0.02',
        source: 'polymarket-clob' as const,
      },
      eligibilitySnapshot: {
        sampledAt,
        timeToResolutionHours: 24,
        liquidityUsd: '10000',
        volume24hUsd: '5000',
        orderbookAgeSeconds: 10,
        selectionReason: 'deterministic Task-first e2e fixture',
      },
    },
    eligibility: {},
    claimPolicy: {
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 600,
      claimWindowStartTs: Math.floor((now - 5_000) / 1000),
      claimWindowEndTs: Math.floor((now + 5 * 60_000) / 1000),
      submissionDeadlineTs: Math.floor((now + 10 * 60_000) / 1000),
    },
  };
  PredictionV1TaskSchema.parse(core);
  return core;
}

export function makePredictionV1SolutionPayload(
  now = Date.now(),
  overrides: Partial<{
    probabilityYes: string;
    submittedAt: string;
    format: string;
    modelId: string;
    confidence: string;
    methodology: string;
  }> = {},
): Record<string, unknown> {
  const payload = {
    probabilityYes: '0.72',
    submittedAt: new Date(now).toISOString(),
    format: 'decimal',
    modelId: 'task-first-e2e-baseline',
    confidence: 'medium',
    methodology: 'Deterministic Task-first e2e smoke payload.',
    ...overrides,
  };
  validatePayload('prediction.v1', 'solution', payload);
  return payload;
}

export function makePredictionV1VerdictPayload(now = Date.now()): Record<string, unknown> {
  const sampledAt = new Date(now - 10_000).toISOString();
  const payload = {
    verdict: 'SCORED',
    outcome: 'YES',
    resolvedAt: new Date(now).toISOString(),
    resolutionSource: {
      venue: 'polymarket',
      url: 'https://polymarket.com/event/jinn-task-first-e2e',
      marketId: 'jinn-task-first-e2e',
      conditionId: '0xcondition-task-first-e2e',
    },
    task: {
      cid: 'local-1',
      id: 'prediction-v1-e2e',
    },
    solutionEnvelope: {
      cid: 'bafy-solution-envelope',
      sha256: 'a'.repeat(64),
    },
    claimed: {
      probabilityYes: '0.72',
      submittedAt: new Date(now - 1_000).toISOString(),
      modelId: 'task-first-e2e-baseline',
    },
    benchmark: {
      probabilityYes: '0.68',
      sampledAt,
      method: 'best-bid-ask-midpoint',
    },
    scores: {
      scoreBasis: 'brier-loss.v1',
      solverBrier: '0.0784',
      consensusBrier: '0.1024',
      brierSpread: '0.024',
    },
    checks: [
      { name: 'solution.envelope', status: 'PASS' },
      { name: 'solution.schema', status: 'PASS' },
    ],
  };
  validatePayload('prediction.v1', 'verdict', payload);
  return payload;
}

function predictionHarness(): Harness {
  return {
    name: 'prediction-v1-e2e-harness',
    version: '1.0.0',
    supports: ({ solverType, role }) => solverType === 'prediction.v1' && role !== 'evaluation',
    run: async (): Promise<Solution> => ({
      venueRef: { name: 'polymarket' },
      gating: { accepted: true },
      solutionPayload: makePredictionV1SolutionPayload(),
    }),
  };
}

function makeResolvedPolymarketSnapshot(task: Task) {
  const parsed = PredictionV1TaskSchema.parse(task);
  return {
    venue: 'polymarket' as const,
    marketId: parsed.spec.source.identifiers.marketId,
    conditionId: parsed.spec.source.identifiers.conditionId,
    status: 'resolved' as const,
    outcome: 'YES' as const,
    resolvedAt: parsed.spec.resolution.expectedResolutionTime,
    sourceUrl: parsed.spec.source.url,
  };
}

function verdictScoreSummary(payload: Record<string, unknown>): string {
  const scores = payload['scores'];
  if (scores && typeof scores === 'object' && !Array.isArray(scores)) {
    const record = scores as Record<string, unknown>;
    return String(record['solverBrier'] ?? record['brierSpread'] ?? '');
  }
  return String(payload['score'] ?? '');
}

export interface LocalTaskFirstAttemptResult {
  sharedTaskId: string;
  sharedTaskCid: string;
  conditionId: string;
  solverSafeAddress: Address;
  request: TaskRequest;
  solutionPayload: Record<string, unknown>;
  solutionEnvelope: SignedEnvelope;
  solutionDelivery: DeliveredResult;
  verdictRequest: TaskRequest;
  verdictPayload: Record<string, unknown>;
  verdictDelivery: DeliveredResult;
  verdict: string;
  score: string;
}

export interface ContractArtifact {
  abi: Abi;
  bytecode: Hex;
}

interface DeploymentArtifact {
  chainId?: number;
  contracts?: Record<string, string | undefined>;
  config?: Record<string, unknown>;
}

export interface AnvilHarness {
  rpcUrl: string;
  teardown(): Promise<void>;
}

export interface Deployment {
  coordinator: Address;
  router: Address;
  marketplace: Address;
  activity: Address;
  mechA: Address;
  mechB: Address;
  mechEvaluator: Address;
}

export interface AnvilTaskFirstFullLoopResult {
  taskId: string;
  attempts: Array<{ operator: Address; attemptIndex: number; requestId: string }>;
  verdict: string;
  score: string;
  submittedCount: number;
  refundedUnusedBudget: boolean;
}

export async function spawnPlainAnvil(): Promise<AnvilHarness> {
  const anvilCheck = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  if (anvilCheck.status !== 0) {
    throw new Error('anvil not in PATH; install Foundry to run the Task-first Anvil e2e');
  }

  const port = await allocateAnvilPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    'anvil',
    ['--port', String(port), '--chain-id', '8453', '--silent'],
    { stdio: 'ignore' },
  );

  const exitPromise = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new Error(`anvil failed to spawn: ${err.message}`)));
    child.once('exit', (code, signal) =>
      reject(new Error(`anvil exited before becoming ready (code=${code}, signal=${signal})`)),
    );
  });
  const readyPromise = (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await anvilJsonRpc(rpcUrl, 'eth_chainId', []);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`anvil did not become ready on ${rpcUrl}`);
  })();

  try {
    await Promise.race([readyPromise, exitPromise]);
  } catch (err) {
    if (!child.killed) child.kill('SIGKILL');
    throw err;
  }

  return {
    rpcUrl,
    async teardown() {
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}

async function runChild(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Pipe stderr (still tee'd to the parent for live logs) so a non-zero exit
    // carries its tail in the thrown error. The release-suite classifier
    // (scenario-types.classifyFailure) reads that message to tell a setup
    // failure — e.g. "node_modules state file - running an install might help"
    // when a workspace wasn't installed — apart from a genuine compile/test
    // failure: the former is infra-blocked, the latter product-red. #1018.
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['inherit', 'inherit', 'pipe'],
      env: options.env ?? process.env,
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk); // preserve live logging
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${command} ${args.join(' ')} failed with exit code ${code}` +
          (stderrTail.trim() ? `\n${stderrTail.trim()}` : ''),
      ));
    });
  });
}

/** Canary artifact — if present, `yarn compile` already ran for this tree. */
const CONTRACTS_COMPILE_CANARY = join(
  CONTRACTS_DIR,
  'artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json',
);

/** Serializes concurrent compile callers (T2.2 + T2.4 in run-tier-2). */
let compileContractsInFlight: Promise<void> | null = null;

async function contractsArtifactsPresent(): Promise<boolean> {
  try {
    await access(CONTRACTS_COMPILE_CANARY);
    return true;
  } catch {
    return false;
  }
}

export async function compileContracts(): Promise<void> {
  if (compileContractsInFlight) {
    await compileContractsInFlight;
    return;
  }

  compileContractsInFlight = (async () => {
    if (await contractsArtifactsPresent()) {
      return;
    }
    await runChild('yarn', ['compile'], { cwd: CONTRACTS_DIR });
  })().catch((err) => {
    compileContractsInFlight = null;
    throw err;
  });

  await compileContractsInFlight;
}

async function loadArtifact(pathFromContracts: string): Promise<ContractArtifact> {
  const raw = JSON.parse(await readFile(join(CONTRACTS_DIR, pathFromContracts), 'utf8')) as {
    abi: Abi;
    bytecode: Hex;
  };
  return { abi: raw.abi, bytecode: raw.bytecode };
}

async function loadDeploymentArtifact(pathName: string): Promise<DeploymentArtifact> {
  return JSON.parse(await readFile(pathName, 'utf8')) as DeploymentArtifact;
}

function deploymentAddress(artifact: DeploymentArtifact, key: string, label: string): Address {
  const value = artifact.contracts?.[key];
  assert(value, `${label} is missing contracts.${key}`);
  return getAddress(value) as Address;
}

function deploymentConfigAddress(artifact: DeploymentArtifact, key: string, label: string): Address {
  const value = artifact.config?.[key];
  assert(typeof value === 'string', `${label} is missing config.${key}`);
  return getAddress(value) as Address;
}

function walletClient(rpcUrl: string, account: PrivateKeyAccount, chain: Chain = base) {
  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
}

async function waitForSuccess(publicClient: PublicClient, hash: Hex): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${hash}`);
  return receipt;
}

async function deployContract(
  publicClient: PublicClient,
  rpcUrl: string,
  account: PrivateKeyAccount,
  artifact: ContractArtifact,
  args: readonly unknown[] = [],
  chain: Chain = base,
): Promise<Address> {
  const client = walletClient(rpcUrl, account, chain);
  const hash = await client.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account,
    chain,
  });
  const receipt = await waitForSuccess(publicClient, hash);
  assert(receipt.contractAddress, `deploy tx ${hash} did not return a contract address`);
  return getAddress(receipt.contractAddress);
}

export async function writeContractTx(params: {
  publicClient: PublicClient;
  rpcUrl: string;
  account: PrivateKeyAccount;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  chain?: Chain;
}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const chain = params.chain ?? base;
  const client = walletClient(params.rpcUrl, params.account, chain);
  const hash = await client.writeContract({
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args ?? [],
    value: params.value ?? 0n,
    account: params.account,
    chain,
  });
  const receipt = await waitForSuccess(params.publicClient, hash);
  return { hash, receipt };
}

export function decodeFirstEvent(receipt: TransactionReceipt, abi: Abi, eventName: string): Record<string, unknown> {
  for (const log of receipt.logs as Log[]) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === eventName) {
        return decoded.args as Record<string, unknown>;
      }
    } catch {
      // Not this ABI/event.
    }
  }
  throw new Error(`missing ${eventName} event in tx ${receipt.transactionHash}`);
}

export function tupleField<T>(value: unknown, key: string, index: number): T {
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined) return record[key] as T;
  return (value as readonly unknown[])[index] as T;
}

export async function deployTaskFirstStack(
  publicClient: PublicClient,
  rpcUrl: string,
  owner: PrivateKeyAccount,
  operatorA: PrivateKeyAccount,
  operatorB: PrivateKeyAccount,
  evaluator: PrivateKeyAccount,
  rate: bigint,
): Promise<{ deployment: Deployment; artifacts: Record<string, ContractArtifact> }> {
  const artifacts = {
    coordinator: await loadArtifact('artifacts/src/tasks/TaskCoordinator.sol/TaskCoordinator.json'),
    router: await loadArtifact('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json'),
    marketplace: await loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json'),
    activity: await loadArtifact('artifacts/src/staking/TaskActivityCheckerV3.sol/TaskActivityCheckerV3.json'),
    mech: await loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json'),
  };

  const coordinator = await deployContract(publicClient, rpcUrl, owner, artifacts.coordinator);
  const marketplace = await deployContract(publicClient, rpcUrl, owner, artifacts.marketplace);
  const activity = await deployContract(publicClient, rpcUrl, owner, artifacts.activity);
  const router = await deployContract(publicClient, rpcUrl, owner, artifacts.router);

  await writeContractTx({
    publicClient,
    rpcUrl,
    account: owner,
    address: activity,
    abi: artifacts.activity.abi,
    functionName: 'initialize',
    args: [parseEther('0.001'), owner.address, 64n, 0n, 20n],
  });
  await writeContractTx({
    publicClient,
    rpcUrl,
    account: owner,
    address: coordinator,
    abi: artifacts.coordinator.abi,
    functionName: 'initialize',
    args: [owner.address, router],
  });
  await writeContractTx({
    publicClient,
    rpcUrl,
    account: owner,
    address: router,
    abi: artifacts.router.abi,
    functionName: 'initialize',
    args: [owner.address, marketplace, coordinator, activity],
  });
  await writeContractTx({
    publicClient,
    rpcUrl,
    account: owner,
    address: activity,
    abi: artifacts.activity.abi,
    functionName: 'setAuthorizedRouter',
    args: [router],
  });

  const mechA = await deployContract(publicClient, rpcUrl, owner, artifacts.mech, [
    rate,
    NATIVE_PAYMENT_TYPE,
    operatorA.address,
    marketplace,
  ]);
  const mechB = await deployContract(publicClient, rpcUrl, owner, artifacts.mech, [
    rate,
    NATIVE_PAYMENT_TYPE,
    operatorB.address,
    marketplace,
  ]);
  const mechEvaluator = await deployContract(publicClient, rpcUrl, owner, artifacts.mech, [
    rate,
    NATIVE_PAYMENT_TYPE,
    evaluator.address,
    marketplace,
  ]);

  return {
    deployment: { coordinator, router, marketplace, activity, mechA, mechB, mechEvaluator },
    artifacts,
  };
}

export async function signedExecutionEnvelope(params: {
  solverType: string;
  role: 'solution' | 'verdict';
  taskCid: string;
  requestId: string;
  onchainCreationTx: Hex;
  onchainCreationBlock: number;
  safeAddress: Address;
  privateKey: Hex;
  window: { startTs: number; endTs: number };
  payload: Record<string, unknown>;
  implName?: string;
}): Promise<SignedEnvelope> {
  const account = privateKeyToAccount(params.privateKey);
  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: params.solverType,
    role: params.role,
    generatedAt: Date.now(),
    task: {
      cid: params.taskCid,
      onchainCreationTx: params.onchainCreationTx,
      onchainCreationBlock: params.onchainCreationBlock,
      requestId: params.requestId,
    },
    participant: {
      safeAddress: params.safeAddress,
      agentEoa: account.address,
    },
    window: params.window,
    executor: {
      implName:
        params.implName ??
        (params.role === 'verdict' ? 'prediction-v1-evaluator' : 'prediction-v1-e2e-harness'),
      implVersion: '1.0.0',
      clientGitSha: 'dev-e2e',
      codeDigest: `sha256:${'11'.repeat(32)}`,
      runtimeBundleDigest: `sha256:${'22'.repeat(32)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: account.address },
    },
    evidenceTier: 'committed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: params.payload,
  };
  const signed = await signCanonical(unsigned, params.privateKey, account.address);
  const envelope = {
    ...unsigned,
    signature: {
      algo: 'secp256k1' as const,
      signer: account.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };
  return SignedEnvelopeSchema.parse(envelope);
}

async function expectWriteRevert(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} did not revert`);
}

function hexQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function taskCidDigestAndCid(task: Task): { digest: Hex; cid: string } {
  const sha256 = createHash('sha256').update(canonicalJson(task)).digest('hex');
  return {
    digest: `0x${sha256}` as Hex,
    cid: `f01551220${sha256}`,
  };
}

function assertAddressEquals(actual: unknown, expected: Address, label: string): void {
  assert(
    getAddress(String(actual)) === getAddress(expected),
    `${label} mismatch: expected ${expected}, got ${String(actual)}`,
  );
}

function startForkMiningPulse(rpcUrl: string): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void anvilJsonRpc(rpcUrl, 'anvil_mine', ['0x1'])
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  }, 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function verifyBaseSepoliaV3Deployment(publicClient: PublicClient): Promise<{
  coordinator: Address;
  router: Address;
  marketplace: Address;
  activity: Address;
  checkerOwner: Address;
  checkerAuthorizedRouter: Address;
  checkerNeedsForkUpgrade: boolean;
  checkerNeedsForkRewire: boolean;
}> {
  const [v3Artifact, mechArtifact, checkerArtifact] = await Promise.all([
    loadDeploymentArtifact(BASE_SEPOLIA_V3_DEPLOYMENT),
    loadDeploymentArtifact(BASE_SEPOLIA_MECH_DEPLOYMENT),
    loadDeploymentArtifact(BASE_SEPOLIA_ROUTER_CHECKER_DEPLOYMENT),
  ]);
  assert(v3Artifact.chainId === baseSepolia.id, `V3 artifact chainId=${v3Artifact.chainId}, expected ${baseSepolia.id}`);

  const coordinator = deploymentAddress(v3Artifact, 'taskCoordinator', 'V3 deployment');
  const router = deploymentAddress(v3Artifact, 'jinnRouterV3', 'V3 deployment');
  const marketplace = deploymentAddress(v3Artifact, 'mechMarketplace', 'V3 deployment');
  const activity = deploymentAddress(v3Artifact, 'activityChecker', 'V3 deployment');

  const expectedMarketplace = deploymentAddress(mechArtifact, 'mechMarketplace', 'Phase 1b mech deployment');
  const expectedActivity = deploymentAddress(checkerArtifact, 'activityChecker', 'router-checker deployment');
  assertAddressEquals(marketplace, expectedMarketplace, 'V3 artifact marketplace');
  assertAddressEquals(activity, expectedActivity, 'V3 artifact activity checker');

  const chainId = await publicClient.getChainId();
  assert(chainId === baseSepolia.id, `fork chainId=${chainId}, expected ${baseSepolia.id}`);

  const [
    storedCoordinator,
    storedMarketplace,
    storedActivity,
    checkerOwner,
    checkerAuthorizedRouter,
  ] = await Promise.all([
    publicClient.readContract({
      address: router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'taskCoordinator',
    }),
    publicClient.readContract({
      address: router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'mechMarketplace',
    }),
    publicClient.readContract({
      address: router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'activityChecker',
    }),
    publicClient.readContract({
      address: activity,
      abi: ACTIVITY_CHECKER_E2E_ABI,
      functionName: 'owner',
    }),
    publicClient.readContract({
      address: activity,
      abi: ACTIVITY_CHECKER_E2E_ABI,
      functionName: 'authorizedRouter',
    }),
  ]);

  assertAddressEquals(storedCoordinator, coordinator, 'router.taskCoordinator');
  assertAddressEquals(storedMarketplace, marketplace, 'router.mechMarketplace');
  assertAddressEquals(storedActivity, activity, 'router.activityChecker');
  const normalizedCheckerAuthorizedRouter = getAddress(String(checkerAuthorizedRouter)) as Address;
  let checkerNeedsForkUpgrade = false;
  try {
    await publicClient.readContract({
      address: activity,
      abi: ACTIVITY_CHECKER_E2E_ABI,
      functionName: 'taskCreationWeight',
      args: [router],
    });
  } catch {
    checkerNeedsForkUpgrade = true;
  }

  return {
    coordinator,
    router,
    marketplace,
    activity,
    checkerOwner: getAddress(String(checkerOwner)) as Address,
    checkerAuthorizedRouter: normalizedCheckerAuthorizedRouter,
    checkerNeedsForkUpgrade,
    checkerNeedsForkRewire: normalizedCheckerAuthorizedRouter !== router,
  };
}

async function upgradeAndRewireActivityCheckerInsideFork(params: {
  publicClient: PublicClient;
  rpcUrl: string;
  activity: Address;
  router: Address;
  owner: Address;
  deployer: PrivateKeyAccount;
  upgrade: boolean;
}): Promise<void> {
  if (params.upgrade) {
    const checkerArtifact = await loadArtifact('artifacts/src/staking/TaskActivityCheckerV3.sol/TaskActivityCheckerV3.json');
    const impl = await deployContract(params.publicClient, params.rpcUrl, params.deployer, checkerArtifact, [], baseSepolia);
    process.stdout.write(
      `fork-local checker upgrade: TaskActivityCheckerV3 impl=${impl}; impersonating owner ${params.owner} inside Anvil only\n`,
    );
    await anvilJsonRpc(params.rpcUrl, 'anvil_setBalance', [
      params.owner,
      hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
    ]);
    await anvilJsonRpc(params.rpcUrl, 'anvil_impersonateAccount', [params.owner]);
    try {
      const ownerWallet = createWalletClient({
        account: params.owner,
        chain: baseSepolia,
        transport: http(params.rpcUrl),
      });
      const hash = await ownerWallet.writeContract({
        address: params.activity,
        abi: ACTIVITY_CHECKER_E2E_ABI,
        functionName: 'changeImplementation',
        args: [impl],
        account: params.owner,
        chain: baseSepolia,
      });
      await waitForSuccess(params.publicClient, hash);
    } finally {
      await anvilJsonRpc(params.rpcUrl, 'anvil_stopImpersonatingAccount', [params.owner]);
    }
  }

  process.stdout.write(
    `fork-local rewire: setting activityChecker.authorizedRouter to V3; impersonating owner ${params.owner} inside Anvil only\n`,
  );
  await anvilJsonRpc(params.rpcUrl, 'anvil_setBalance', [
    params.owner,
    hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
  ]);
  await anvilJsonRpc(params.rpcUrl, 'anvil_impersonateAccount', [params.owner]);
  try {
    const ownerWallet = createWalletClient({
      account: params.owner,
      chain: baseSepolia,
      transport: http(params.rpcUrl),
    });
      const hash = await ownerWallet.writeContract({
        address: params.activity,
        abi: ACTIVITY_CHECKER_E2E_ABI,
        functionName: 'setAuthorizedRouter',
        args: [params.router],
        account: params.owner,
        chain: baseSepolia,
    });
    await waitForSuccess(params.publicClient, hash);
  } finally {
    await anvilJsonRpc(params.rpcUrl, 'anvil_stopImpersonatingAccount', [params.owner]);
  }

  const authorizedRouter = await params.publicClient.readContract({
    address: params.activity,
    abi: ACTIVITY_CHECKER_E2E_ABI,
    functionName: 'authorizedRouter',
  });
  assertAddressEquals(authorizedRouter, params.router, 'fork-local activityChecker.authorizedRouter');
}

async function upgradeTaskStackInsideFork(params: {
  publicClient: PublicClient;
  rpcUrl: string;
  coordinator: Address;
  router: Address;
  marketplace: Address;
  activity: Address;
  owner: Address;
  deployer: PrivateKeyAccount;
}): Promise<void> {
  const [coordinatorArtifact, routerArtifact] = await Promise.all([
    loadArtifact('artifacts/src/tasks/TaskCoordinator.sol/TaskCoordinator.json'),
    loadArtifact('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json'),
  ]);
  const coordinatorImpl = await deployContract(
    params.publicClient,
    params.rpcUrl,
    params.deployer,
    coordinatorArtifact,
    [],
    baseSepolia,
  );
  const routerImpl = await deployContract(
    params.publicClient,
    params.rpcUrl,
    params.deployer,
    routerArtifact,
    [],
    baseSepolia,
  );

  process.stdout.write(
    `fork-local V3 upgrade: coordinatorImpl=${coordinatorImpl}, routerImpl=${routerImpl}; ` +
    `impersonating proxy owner ${params.owner} inside Anvil only\n`,
  );
  await anvilJsonRpc(params.rpcUrl, 'anvil_setBalance', [
    params.owner,
    hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
  ]);
  await anvilJsonRpc(params.rpcUrl, 'anvil_impersonateAccount', [params.owner]);
  try {
    const ownerWallet = createWalletClient({
      account: params.owner,
      chain: baseSepolia,
      transport: http(params.rpcUrl),
    });
    for (const [proxy, impl] of [
      [params.coordinator, coordinatorImpl],
      [params.router, routerImpl],
    ] as const) {
      const hash = await ownerWallet.writeContract({
        address: proxy,
        abi: JINN_UPGRADEABLE_PROXY_E2E_ABI,
        functionName: 'upgradeTo',
        args: [impl],
        account: params.owner,
        chain: baseSepolia,
      });
      await waitForSuccess(params.publicClient, hash);
    }
  } finally {
    await anvilJsonRpc(params.rpcUrl, 'anvil_stopImpersonatingAccount', [params.owner]);
  }

  const [
    coordinatorImplAfter,
    routerImplAfter,
    coordinatorAdmin,
    routerAdmin,
    coordinatorOwner,
    coordinatorAuthorizedRouter,
    routerCoordinator,
    routerMarketplace,
    routerActivity,
  ] = await Promise.all([
    params.publicClient.readContract({
      address: params.coordinator,
      abi: JINN_UPGRADEABLE_PROXY_E2E_ABI,
      functionName: 'getImplementation',
    }),
    params.publicClient.readContract({
      address: params.router,
      abi: JINN_UPGRADEABLE_PROXY_E2E_ABI,
      functionName: 'getImplementation',
    }),
    params.publicClient.readContract({
      address: params.coordinator,
      abi: JINN_UPGRADEABLE_PROXY_E2E_ABI,
      functionName: 'getAdmin',
    }),
    params.publicClient.readContract({
      address: params.router,
      abi: JINN_UPGRADEABLE_PROXY_E2E_ABI,
      functionName: 'getAdmin',
    }),
    params.publicClient.readContract({
      address: params.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'owner',
    }),
    params.publicClient.readContract({
      address: params.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'authorizedRouter',
    }),
    params.publicClient.readContract({
      address: params.router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'taskCoordinator',
    }),
    params.publicClient.readContract({
      address: params.router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'mechMarketplace',
    }),
    params.publicClient.readContract({
      address: params.router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'activityChecker',
    }),
  ]);
  process.stdout.write(
    `fork-local V3 upgrade verified: coordinatorImpl=${coordinatorImplAfter}, routerImpl=${routerImplAfter}, ` +
    `coordinatorAdmin=${coordinatorAdmin}, routerAdmin=${routerAdmin}, coordinatorOwner=${coordinatorOwner}\n`,
  );
  assertAddressEquals(coordinatorImplAfter, coordinatorImpl, 'fork upgraded coordinator implementation');
  assertAddressEquals(routerImplAfter, routerImpl, 'fork upgraded router implementation');
  assertAddressEquals(coordinatorAdmin, params.owner, 'fork coordinator proxy admin');
  assertAddressEquals(routerAdmin, params.owner, 'fork router proxy admin');
  assertAddressEquals(coordinatorAuthorizedRouter, params.router, 'fork coordinator.authorizedRouter');
  assertAddressEquals(routerCoordinator, params.coordinator, 'fork router.taskCoordinator after upgrade');
  assertAddressEquals(routerMarketplace, params.marketplace, 'fork router.mechMarketplace after upgrade');
  assertAddressEquals(routerActivity, params.activity, 'fork router.activityChecker after upgrade');
}

async function topUpDistributorStakeTokenInsideFork(params: {
  publicClient: PublicClient;
  rpcUrl: string;
}): Promise<void> {
  const [tokenArtifact, stolasArtifact] = await Promise.all([
    loadDeploymentArtifact(BASE_SEPOLIA_TOKEN_DEPLOYMENT),
    loadDeploymentArtifact(BASE_SEPOLIA_STOLAS_DEPLOYMENT),
  ]);
  const token = deploymentAddress(tokenArtifact, 'l2Token', 'Base Sepolia token deployment');
  const bridge = deploymentAddress(tokenArtifact, 'l2StandardBridge', 'Base Sepolia token deployment');
  const distributor = deploymentAddress(stolasArtifact, 'distributor', 'Base Sepolia stOLAS deployment');

  const balance = await params.publicClient.readContract({
    address: token,
    abi: MINTABLE_ERC20_E2E_ABI,
    functionName: 'balanceOf',
    args: [distributor],
  });
  if (balance >= BASE_SEPOLIA_DISTRIBUTOR_STAKE_FLOAT) return;

  const mintAmount = BASE_SEPOLIA_DISTRIBUTOR_STAKE_FLOAT - balance;
  process.stdout.write(
    `fork-local token top-up: minting ${mintAmount.toString()} staking tokens to stOLAS distributor ${distributor}\n`,
  );
  await anvilJsonRpc(params.rpcUrl, 'anvil_setBalance', [
    bridge,
    hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
  ]);
  await anvilJsonRpc(params.rpcUrl, 'anvil_impersonateAccount', [bridge]);
  try {
    const bridgeWallet = createWalletClient({
      account: bridge,
      chain: baseSepolia,
      transport: http(params.rpcUrl),
    });
    const hash = await bridgeWallet.writeContract({
      address: token,
      abi: MINTABLE_ERC20_E2E_ABI,
      functionName: 'mint',
      args: [distributor, mintAmount],
      account: bridge,
      chain: baseSepolia,
    });
    await waitForSuccess(params.publicClient, hash);
  } finally {
    await anvilJsonRpc(params.rpcUrl, 'anvil_stopImpersonatingAccount', [bridge]);
  }

  const nextBalance = await params.publicClient.readContract({
    address: token,
    abi: MINTABLE_ERC20_E2E_ABI,
    functionName: 'balanceOf',
    args: [distributor],
  });
  assert(nextBalance >= BASE_SEPOLIA_DISTRIBUTOR_STAKE_FLOAT, 'fork-local distributor token top-up failed');
}

async function forkTraceSummary(rpcUrl: string, message: string): Promise<string | null> {
  const txHash = message.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined;
  if (!txHash) return null;
  try {
    const trace = await anvilJsonRpc(rpcUrl, 'debug_traceTransaction', [
      txHash,
      { tracer: 'callTracer' },
    ]) as unknown;
    const errors: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record['error'] || record['revertReason']) {
        errors.push(
          `${path} to=${String(record['to'])} error=${String(record['error'] ?? '')} ` +
          `revertReason=${String(record['revertReason'] ?? '')} input=${String(record['input'] ?? '').slice(0, 10)}`,
        );
      }
      const calls = record['calls'];
      if (Array.isArray(calls)) {
        calls.forEach((call, index) => visit(call, `${path}.${index}`));
      }
    };
    visit(trace, 'root');
    if (errors.length > 0) return errors.join('\n');
    return JSON.stringify(trace).slice(0, 4_000);
  } catch (err) {
    return `trace unavailable for ${txHash}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function bootstrapBaseSepoliaForkOperator(rpcUrl: string): Promise<{
  tmpDir: string;
  safeAddress: Address;
  mechAddress: Address;
  agentPrivateKey: Hex;
  agentId: string | null;
}> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'jinn-base-sepolia-fork-earning-'));
  const bootstrapper = new FleetBootstrapper({
    earningDir: tmpDir,
    chain: 'base-sepolia',
    rpcUrl,
    stakingMode: 'standard',
    targetServices: 1,
    autoTestnetFaucet: false,
  });

  let result = await bootstrapper.bootstrap(BASE_SEPOLIA_E2E_PASSWORD);
  if (!result.ok && result.funding?.master_address) {
    await anvilJsonRpc(rpcUrl, 'anvil_setBalance', [
      getAddress(result.funding.master_address),
      hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
    ]);
    result = await bootstrapper.bootstrap(BASE_SEPOLIA_E2E_PASSWORD);
  }

  if (!result.ok) {
    const trace = await forkTraceSummary(rpcUrl, result.message);
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(
      `fork operator bootstrap failed: ${result.message}` +
      (trace ? `\ntrace=${trace}` : ''),
    );
  }

  const service = result.fleet_state.services.find((svc) => svc.safe_address && svc.mech_address);
  if (!service?.safe_address || !service.mech_address) {
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error('fork operator bootstrap did not produce a Safe and Mech');
  }

  const store = new FleetStateStore(tmpDir);
  const mnemonic = await decryptMnemonic(
    await store.loadMnemonicKeystore(),
    BASE_SEPOLIA_E2E_PASSWORD,
  );

  return {
    tmpDir,
    safeAddress: getAddress(service.safe_address) as Address,
    mechAddress: getAddress(service.mech_address) as Address,
    agentPrivateKey: walletPrivateKeyAtIndex(mnemonic, service.index),
    agentId: service.agent_id ?? null,
  };
}

export async function runBaseSepoliaForkTaskFirstFullLoop(): Promise<AnvilTaskFirstFullLoopResult> {
  const anvilCheck = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  if (anvilCheck.status !== 0) {
    throw new Error('anvil not in PATH; install Foundry to run the Base Sepolia fork e2e');
  }
  await compileContracts();

  const forkUrl = process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org';
  const anvil = await spawnAnvilFork({
    forkUrl,
    chain: baseSepolia,
    silent: true,
    readyTimeoutMs: 30_000,
  });
  const creator = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(anvil.rpcUrl),
  }) as unknown as PublicClient;
  const stopMiningPulse = startForkMiningPulse(anvil.rpcUrl);
  let operatorTmpDir: string | null = null;
  let evaluatorTmpDir: string | null = null;

  try {
    await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
      creator.address,
      hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
    ]);
    const deployment = await verifyBaseSepoliaV3Deployment(publicClient);
    await upgradeTaskStackInsideFork({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      coordinator: deployment.coordinator,
      router: deployment.router,
      marketplace: deployment.marketplace,
      activity: deployment.activity,
      owner: deployment.checkerOwner,
      deployer: creator,
    });
    if (deployment.checkerNeedsForkUpgrade || deployment.checkerNeedsForkRewire) {
      process.stdout.write(
        `live checker gap: upgrade=${deployment.checkerNeedsForkUpgrade}, ` +
        `activityChecker.authorizedRouter=${deployment.checkerAuthorizedRouter}, expected ${deployment.router}\n`,
      );
      await upgradeAndRewireActivityCheckerInsideFork({
        publicClient,
        rpcUrl: anvil.rpcUrl,
        activity: deployment.activity,
        router: deployment.router,
        owner: deployment.checkerOwner,
        deployer: creator,
        upgrade: deployment.checkerNeedsForkUpgrade,
      });
    }
    await topUpDistributorStakeTokenInsideFork({
      publicClient,
      rpcUrl: anvil.rpcUrl,
    });
    const operator = await bootstrapBaseSepoliaForkOperator(anvil.rpcUrl);
    operatorTmpDir = operator.tmpDir;
    const evaluatorOperator = await bootstrapBaseSepoliaForkOperator(anvil.rpcUrl);
    evaluatorTmpDir = evaluatorOperator.tmpDir;
    const operatorAccount = privateKeyToAccount(operator.agentPrivateKey);
    const operatorWallet = walletClient(anvil.rpcUrl, operatorAccount, baseSepolia);
    const evaluatorAccount = privateKeyToAccount(evaluatorOperator.agentPrivateKey);
    const evaluatorWallet = walletClient(anvil.rpcUrl, evaluatorAccount, baseSepolia);

    const isOperator = await publicClient.readContract({
      address: operator.mechAddress,
      abi: MECH_ABI,
      functionName: 'isOperator',
      args: [operator.safeAddress],
    });
    assert(isOperator === true, `bootstrapped Safe ${operator.safeAddress} is not operator for Mech ${operator.mechAddress}`);
    const isEvaluatorOperator = await publicClient.readContract({
      address: evaluatorOperator.mechAddress,
      abi: MECH_ABI,
      functionName: 'isOperator',
      args: [evaluatorOperator.safeAddress],
    });
    assert(
      isEvaluatorOperator === true,
      `bootstrapped evaluator Safe ${evaluatorOperator.safeAddress} is not operator for Mech ${evaluatorOperator.mechAddress}`,
    );

    const [deliveryRate, timeoutBounds] = await Promise.all([
      getMechDeliveryRate(publicClient, operator.mechAddress),
      getTimeoutBounds(publicClient, deployment.marketplace),
    ]);
    assert(deliveryRate > 0n, `bootstrapped Mech maxDeliveryRate=${deliveryRate}`);
    const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 60n;
    assert(responseTimeout <= timeoutBounds.max, 'marketplace response timeout bounds are invalid');

    const task = makePredictionV1Task();
    const predictionTask = PredictionV1TaskSchema.parse(task);
    const { digest: taskCidDigest, cid: taskCid } = taskCidDigestAndCid(task);
    const manifestDigest = keccak256(toBytes('prediction.v1'));
    // Tokenless-OLAS pivot: on-chain policy is now just `maxClaims`.
    const policy = { maxClaims: 2 };

    let created: { hash: Hex; receipt: TransactionReceipt };
    try {
      created = await writeContractTx({
        publicClient,
        rpcUrl: anvil.rpcUrl,
        account: creator,
        address: deployment.router,
        abi: JINN_ROUTER_V3_E2E_ABI,
        functionName: 'createTask',
        args: [taskCidDigest, manifestDigest, policy, deliveryRate, deliveryRate, responseTimeout],
        value: deliveryRate * 4n,
        chain: baseSepolia,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const trace = await forkTraceSummary(anvil.rpcUrl, message);
      const [coordinatorAuthorizedRouter, routerCoordinator, routerMarketplace, routerActivity] = await Promise.all([
        publicClient.readContract({
          address: deployment.coordinator,
          abi: TASK_COORDINATOR_E2E_ABI,
          functionName: 'authorizedRouter',
        }).catch((readErr) => `read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`),
        publicClient.readContract({
          address: deployment.router,
          abi: JINN_ROUTER_V3_E2E_ABI,
          functionName: 'taskCoordinator',
        }).catch((readErr) => `read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`),
        publicClient.readContract({
          address: deployment.router,
          abi: JINN_ROUTER_V3_E2E_ABI,
          functionName: 'mechMarketplace',
        }).catch((readErr) => `read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`),
        publicClient.readContract({
          address: deployment.router,
          abi: JINN_ROUTER_V3_E2E_ABI,
          functionName: 'activityChecker',
        }).catch((readErr) => `read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`),
      ]);
      throw new Error(
        `fork createTask failed: ${message}\n` +
        `wiring: coordinator.authorizedRouter=${String(coordinatorAuthorizedRouter)}, ` +
        `router.taskCoordinator=${String(routerCoordinator)}, ` +
        `router.mechMarketplace=${String(routerMarketplace)}, ` +
        `router.activityChecker=${String(routerActivity)}` +
        (trace ? `\ntrace=${trace}` : ''),
      );
    }
    const taskCreated = decodeFirstEvent(created.receipt, JINN_ROUTER_V3_E2E_ABI, 'TaskCreated');
    const taskId = String(taskCreated['taskId']);
    assert(BigInt(taskId) > 0n, `invalid TaskCreated taskId=${taskId}`);

    const claim = await claimTask(
      publicClient,
      operatorWallet,
      operator.safeAddress,
      deployment.router,
      taskId,
      operator.mechAddress,
    );
    assert(claim.attemptIndex === 0, `first fork attempt index was ${claim.attemptIndex}`);
    const requestId = claim.requestId as Hex;

    await expectWriteRevert(
      () => publicClient.simulateContract({
        account: operator.safeAddress,
        address: deployment.router,
        abi: JINN_ROUTER_V3_E2E_ABI,
        functionName: 'claimTask',
        args: [BigInt(taskId), operator.mechAddress],
      }),
      'duplicate fork operator claim',
    );

    const solutionPayload = makePredictionV1SolutionPayload();
    const solutionEnvelope = await signedExecutionEnvelope({
      solverType: 'prediction.v1',
      role: 'solution',
      taskCid,
      requestId,
      onchainCreationTx: created.hash,
      onchainCreationBlock: Number(created.receipt.blockNumber),
      safeAddress: operator.safeAddress,
      privateKey: operator.agentPrivateKey,
      window: predictionTask.window,
      payload: solutionPayload,
    });
    validatePayload('prediction.v1', 'solution', solutionEnvelope.payload);

    await callDeliverToMarketplace(
      publicClient,
      operatorWallet,
      operator.safeAddress,
      operator.mechAddress,
      [requestId],
      [solutionEnvelope.signature.hash],
    );
    await claimDelivery(
      publicClient,
      operatorWallet,
      operator.safeAddress,
      deployment.router,
      requestId,
      { variant: 'v3', kind: 'solution', evidenceHash: solutionEnvelope.signature.hash },
    );

    const verdictClaim = await createVerdictPorts({
      publicClient,
      broadcaster: createDirectSafeBroadcaster(
        publicClient,
        evaluatorWallet,
        evaluatorOperator.safeAddress as Address,
      ) as never,
      safeAddress: evaluatorOperator.safeAddress as Address,
      routerAddress: deployment.router as Address,
      mechAddress: evaluatorOperator.mechAddress as Address,
    }).openVerdictAttempt({
      operationId: `e2e-open-verdict:${requestId}`,
      taskId: BigInt(taskId),
      attemptIndex: claim.attemptIndex,
      evaluationTaskCidDigest: keccak256(toBytes(`evaluation:${taskCid}:${requestId}`)),
    });
    const verdictRequestId = verdictClaim.requestId as Hex;

    const evaluatorHarness = new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => makeResolvedPolymarketSnapshot(task),
      },
    });
    const evaluationTmp = await mkdtemp(join(tmpdir(), 'jinn-prediction-fork-eval-e2e-'));
    let verdictPayload: Record<string, unknown>;
    try {
      const verdictSolution = await evaluatorHarness.run({
        task: {
          ...task,
          role: 'evaluation',
          restorationRequestId: requestId,
          context: {
            restorationResult: JSON.stringify(solutionEnvelope),
            [SOLUTION_TASK_CID_CONTEXT_KEY]: taskCid,
            [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: 'bafy-solution-fork',
          },
        },
        taskCid,
        workingDir: evaluationTmp,
        implStateDir: join(evaluationTmp, 'state'),
        log: () => {},
        abort: new AbortController().signal,
        msUntilEndTs: () => 0,
        trajectory: new TrajectoryCollector({ taskCid, runId: requestId }),
      });
      assert(verdictSolution.verdictPayload, 'prediction evaluator did not return a verdictPayload');
      verdictPayload = verdictSolution.verdictPayload;
      validatePayload('prediction.v1', 'verdict', verdictPayload);
    } finally {
      await rm(evaluationTmp, { recursive: true, force: true });
    }

    const verdictEnvelope = await signedExecutionEnvelope({
      solverType: 'prediction.v1',
      role: 'verdict',
      taskCid,
      requestId: verdictRequestId,
      onchainCreationTx: created.hash,
      onchainCreationBlock: Number(created.receipt.blockNumber),
      safeAddress: evaluatorOperator.safeAddress,
      privateKey: evaluatorOperator.agentPrivateKey,
      window: predictionTask.window,
      payload: verdictPayload,
    });
    validatePayload('prediction.v1', 'verdict', verdictEnvelope.payload);

    await callDeliverToMarketplace(
      publicClient,
      evaluatorWallet,
      evaluatorOperator.safeAddress,
      evaluatorOperator.mechAddress,
      [verdictRequestId],
      [verdictEnvelope.signature.hash],
    );
    await claimDelivery(
      publicClient,
      evaluatorWallet,
      evaluatorOperator.safeAddress,
      deployment.router,
      verdictRequestId,
      { variant: 'v3', kind: 'verdict', evidenceHash: verdictEnvelope.signature.hash, verdictCode: 1 },
    );

    const verdictRef = await publicClient.readContract({
      address: deployment.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'getVerdictRequestRef',
      args: [verdictRequestId],
    });
    assert(String(tupleField<bigint>(verdictRef, 'taskId', 0)) === taskId, 'fork verdictRef taskId mismatch');
    assert(Number(tupleField<number | bigint>(verdictRef, 'attemptIndex', 1)) === claim.attemptIndex, 'fork verdictRef attemptIndex mismatch');
    assert(Number(tupleField<number | bigint>(verdictRef, 'verdictIndex', 2)) === verdictClaim.verdictIndex, 'fork verdictRef verdictIndex mismatch');
    assert(tupleField<boolean>(verdictRef, 'exists', 3) === true, 'fork verdictRef missing');

    const requestRef = await publicClient.readContract({
      address: deployment.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'getRequestRef',
      args: [requestId],
    });
    assert(String(tupleField<bigint>(requestRef, 'taskId', 0)) === taskId, 'fork requestRef taskId mismatch');
    assert(Number(tupleField<number | bigint>(requestRef, 'attemptIndex', 1)) === claim.attemptIndex, 'fork requestRef attemptIndex mismatch');
    assert(tupleField<boolean>(requestRef, 'exists', 2) === true, 'fork requestRef missing');

    const attemptRecord = await publicClient.readContract({
      address: deployment.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'getAttempt',
      args: [BigInt(taskId), claim.attemptIndex],
    });
    assert(tupleField<string>(attemptRecord, 'operator', 2).toLowerCase() === operator.safeAddress.toLowerCase(), 'fork attempt operator mismatch');
    assert(tupleField<string>(attemptRecord, 'requestId', 3).toLowerCase() === requestId.toLowerCase(), 'fork attempt requestId mismatch');
    assert(tupleField<string>(attemptRecord, 'solutionCidDigest', 4).toLowerCase() === solutionEnvelope.signature.hash.toLowerCase(), 'fork evidence hash mismatch');
    assert(Number(tupleField<bigint>(attemptRecord, 'status', 9)) === 3, 'fork attempt was not submitted');
    assert(Number(tupleField<bigint>(attemptRecord, 'finalization', 10)) === 2, 'fork attempt was not finalized as passed');

    const taskRecord = await publicClient.readContract({
      address: deployment.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'getTask',
      args: [BigInt(taskId)],
    });
    const submittedCount = Number(tupleField<bigint>(taskRecord, 'submittedCount', 6));
    assert(submittedCount === 1, `fork submittedCount=${submittedCount}, expected 1`);

    const [solutionWeight, verdictWeight, creatorWeight] = await Promise.all([
      publicClient.readContract({
        address: deployment.activity,
        abi: ACTIVITY_CHECKER_E2E_ABI,
        functionName: 'solutionDeliveryWeight',
        args: [operator.safeAddress],
      }),
      publicClient.readContract({
        address: deployment.activity,
        abi: ACTIVITY_CHECKER_E2E_ABI,
        functionName: 'verdictDeliveryWeight',
        args: [evaluatorOperator.safeAddress],
      }),
      publicClient.readContract({
        address: deployment.activity,
        abi: ACTIVITY_CHECKER_E2E_ABI,
        functionName: 'taskCreationWeight',
        args: [creator.address],
      }),
    ]);
    assert(solutionWeight === parseEther('1'), `fork solution weight=${solutionWeight}`);
    assert(verdictWeight === parseEther('1'), `fork verdict weight=${verdictWeight}`);
    assert(creatorWeight === parseEther('1'), `fork creator weight=${creatorWeight}`);

    await anvilJsonRpc(anvil.rpcUrl, 'evm_increaseTime', [180]);
    await anvilJsonRpc(anvil.rpcUrl, 'anvil_mine', ['0x1']);
    await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: creator,
      address: deployment.router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'refundUnusedTaskBudget',
      args: [BigInt(taskId)],
      chain: baseSepolia,
    });
    const payment = await publicClient.readContract({
      address: deployment.router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'taskPayments',
      args: [BigInt(taskId)],
    });
    const refundedUnusedBudget =
      tupleField<bigint>(payment, 'solutionBudgetRemaining', 6) === 0n &&
      tupleField<bigint>(payment, 'verdictBudgetRemaining', 7) === 0n &&
      tupleField<boolean>(payment, 'solutionBudgetRefunded', 8) === true &&
      tupleField<boolean>(payment, 'verdictBudgetRefunded', 9) === true;
    assert(refundedUnusedBudget, 'fork unused Task budget was not refunded');

    return {
      taskId,
      attempts: [
        { operator: operator.safeAddress, attemptIndex: claim.attemptIndex, requestId },
      ],
      verdict: String(verdictPayload['verdict']),
      score: verdictScoreSummary(verdictPayload),
      submittedCount,
      refundedUnusedBudget,
    };
  } finally {
    stopMiningPulse();
    if (operatorTmpDir) {
      await rm(operatorTmpDir, { recursive: true, force: true });
    }
    if (evaluatorTmpDir) {
      await rm(evaluatorTmpDir, { recursive: true, force: true });
    }
    await anvil.teardown();
  }
}

// ── SolverNet creation/launch + lifecycle (manifest-driven) ─────────────────

const BASE_SEPOLIA_IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address;

export interface ForkSolverNetCreationResult {
  manifestCid: string;
  taskId: string;
  attempt: { operator: Address; attemptIndex: number; requestId: string };
  verdict: string;
  score: string;
  submittedCount: number;
  /** Number of `setMetadata` writes the publisher observed across the run. */
  setMetadataCalls: number;
}

/**
 * 5th e2e phase: exercise the manifest-driven SolverNet path end-to-end on
 * a Base Sepolia anvil fork.
 *
 *   1. Same fork + V3 upgrade setup as `runBaseSepoliaForkTaskFirstFullLoop`.
 *   2. Bootstrap a launcher operator → master Safe + agent EOA + agentId
 *      from the IdentityRegistry mint step.
 *   3. Build + sign a `SolverNetManifestV1`.
 *   4. `LaunchAction.launch()` → in-memory IPFS pin + real
 *      `IdentityRegistry.setMetadata` on the fork + launched record on disk.
 *   5. Bootstrap a solver + evaluator operator (reuses existing helper).
 *   6. Post a Task whose `manifestDigest` is `keccak256(toBytes(cid))` so
 *      the on-chain Task is bound to the launched manifest.
 *   7. Reuse the claim/submit/verdict/finalize sequence from the legacy fork
 *      loop — the manifestDigest binding does not change the lifecycle.
 *   8. Drive the operator-join eligibility filter (Task 28's
 *      `evaluateJoinedEligibility`) against the real chain-emitted task:
 *      a) accept — joined CID + solver role,
 *      b) reject-cid — non-joined manifestCid,
 *      c) reject-role — joined CID but evaluation role the operator did
 *         not opt into.
 *   (The former step 9 drove `LifecycleTransition` through paused → launched
 *   → retired; that producer retired with Wave-4 D3.)
 */
export async function runBaseSepoliaForkSolverNetCreationLoop(): Promise<ForkSolverNetCreationResult> {
  const anvilCheck = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  if (anvilCheck.status !== 0) {
    throw new Error('anvil not in PATH; install Foundry to run the Base Sepolia fork e2e');
  }
  await compileContracts();

  const forkUrl = process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org';
  const anvil = await spawnAnvilFork({
    forkUrl,
    chain: baseSepolia,
    silent: true,
    readyTimeoutMs: 30_000,
  });
  const creator = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(anvil.rpcUrl),
  }) as unknown as PublicClient;
  const stopMiningPulse = startForkMiningPulse(anvil.rpcUrl);

  let launcherTmpDir: string | null = null;
  let operatorTmpDir: string | null = null;
  let evaluatorTmpDir: string | null = null;
  const storeBaseDir = await mkdtemp(join(tmpdir(), 'jinn-solvernet-launch-e2e-'));

  try {
    // Step 1 — fund creator + upgrade V3 stack inside the fork.
    await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
      creator.address,
      hexQuantity(BASE_SEPOLIA_E2E_FUNDING_WEI),
    ]);
    const deployment = await verifyBaseSepoliaV3Deployment(publicClient);
    await upgradeTaskStackInsideFork({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      coordinator: deployment.coordinator,
      router: deployment.router,
      marketplace: deployment.marketplace,
      activity: deployment.activity,
      owner: deployment.checkerOwner,
      deployer: creator,
    });
    if (deployment.checkerNeedsForkUpgrade || deployment.checkerNeedsForkRewire) {
      await upgradeAndRewireActivityCheckerInsideFork({
        publicClient,
        rpcUrl: anvil.rpcUrl,
        activity: deployment.activity,
        router: deployment.router,
        owner: deployment.checkerOwner,
        deployer: creator,
        upgrade: deployment.checkerNeedsForkUpgrade,
      });
    }
    await topUpDistributorStakeTokenInsideFork({
      publicClient,
      rpcUrl: anvil.rpcUrl,
    });

    // Step 2 — bootstrap launcher operator (gives us agent EOA + agentId
    // + master Safe minted into the IdentityRegistry).
    const launcher = await bootstrapBaseSepoliaForkOperator(anvil.rpcUrl);
    launcherTmpDir = launcher.tmpDir;
    assert(launcher.agentId !== null && launcher.agentId.length > 0, 'launcher bootstrap did not produce an agentId');
    const launcherAccount = privateKeyToAccount(launcher.agentPrivateKey);
    assert(
      launcherAccount.address.toLowerCase() === launcherAccount.address.toLowerCase(),
      'launcher account derivation mismatch (sanity)',
    );

    // Step 3 — build + sign a SolverNetManifestV1.
    const manifest = await buildSignedSolverNetManifestV1({
      solverNetId: 'sn_e2e_prediction_v1',
      name: 'E2E Prediction',
      description: 'E2E SolverNet creation/launch fixture (Base Sepolia fork).',
      safeAddress: launcher.safeAddress,
      agentEoa: launcherAccount.address,
      agentId: launcher.agentId,
      agentEoaPrivateKey: launcher.agentPrivateKey,
    });

    // Step 4 — wire LaunchAction deps and launch.
    const solverNetStore = createSolverNetStore({ baseDir: storeBaseDir });
    const ipfs = createInMemoryIpfsClient();
    const subgraph = createInMemorySubgraphClient();
    const publisher = createForkMetadataPublisher({
      rpcUrl: anvil.rpcUrl,
      identityRegistryAddress: BASE_SEPOLIA_IDENTITY_REGISTRY,
      agentEoaPrivateKey: launcher.agentPrivateKey,
    });
    const registry = new IdentityRegistryBackedSolverNetRegistryClient({
      ipfs,
      publisher,
      subgraph,
      network: 'base-sepolia',
    });

    const spawnedRecords: Array<{ solverNetId: string }> = [];
    const launchAction = new LaunchAction({
      store: solverNetStore,
      ipfs,
      publisher,
      subgraph,
      spawnGenerator: async (record) => {
        // The new launched-record generator factory is unit-tested
        // separately. The e2e value here is the launch action + on-chain
        // setMetadata + lifecycle wiring; we only assert spawn was called.
        spawnedRecords.push({ solverNetId: record.solverNetId });
      },
      awaitTxConfirmation: async (txHash) => {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        return { blockNumber: Number(receipt.blockNumber) };
      },
    });

    const launched = await launchAction.launch({
      manifest,
      signer: {
        agentEoaAddress: launcherAccount.address,
        agentEoaPrivateKey: launcher.agentPrivateKey,
        agentId: launcher.agentId,
      },
    });

    assert(launched.status === 'launched', `launch did not land at status=launched (got ${launched.status})`);
    assert(launched.launchProgress === undefined, 'launchProgress should be cleared after launch');
    assert(launched.manifestCid.length > 0, 'launched record missing manifestCid');
    assert(launched.registry.metadataTxHash !== undefined, 'launched record missing metadataTxHash');
    assert(spawnedRecords.length === 1, `spawnGenerator called ${spawnedRecords.length}× (expected 1)`);
    assert(publisher.calls.length === 1, `expected 1 setMetadata call after launch, got ${publisher.calls.length}`);
    assert(
      publisher.calls[0]!.key === `solvernet-manifest:${launched.manifestCid}`,
      `setMetadata key mismatch: got ${publisher.calls[0]!.key}`,
    );
    const onDisk = await solverNetStore.loadRecord(launched.solverNetId);
    assert(onDisk?.status === 'launched', 'launched record on disk is not status=launched');

    // Step 5 — bootstrap solver + evaluator operators (reuses existing
    // fork loop's helper).
    const operator = await bootstrapBaseSepoliaForkOperator(anvil.rpcUrl);
    operatorTmpDir = operator.tmpDir;
    const evaluatorOperator = await bootstrapBaseSepoliaForkOperator(anvil.rpcUrl);
    evaluatorTmpDir = evaluatorOperator.tmpDir;
    const operatorAccount = privateKeyToAccount(operator.agentPrivateKey);
    const operatorWallet = walletClient(anvil.rpcUrl, operatorAccount, baseSepolia);
    const evaluatorAccount = privateKeyToAccount(evaluatorOperator.agentPrivateKey);
    const evaluatorWallet = walletClient(anvil.rpcUrl, evaluatorAccount, baseSepolia);

    const isOperator = await publicClient.readContract({
      address: operator.mechAddress,
      abi: MECH_ABI,
      functionName: 'isOperator',
      args: [operator.safeAddress],
    });
    assert(isOperator === true, `bootstrapped Safe ${operator.safeAddress} is not operator for Mech ${operator.mechAddress}`);

    const [deliveryRate, timeoutBounds] = await Promise.all([
      getMechDeliveryRate(publicClient, operator.mechAddress),
      getTimeoutBounds(publicClient, deployment.marketplace),
    ]);
    assert(deliveryRate > 0n, `bootstrapped Mech maxDeliveryRate=${deliveryRate}`);
    const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 60n;

    // Step 6 — post a Task whose manifestDigest binds it to the launched
    // manifest CID. We reuse the existing prediction.v1 task fixture and
    // submit via the same `writeContractTx` path the legacy fork loop
    // uses; the only manifest-driven difference is the digest.
    const task = makePredictionV1Task();
    const predictionTask = PredictionV1TaskSchema.parse(task);
    const { digest: taskCidDigest, cid: taskCid } = taskCidDigestAndCid(task);
    const manifestDigest = manifestDigestForCid(launched.manifestCid);
    // Tokenless-OLAS pivot: on-chain policy is now just `maxClaims`.
    const policy = { maxClaims: 2 };

    const created = await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: creator,
      address: deployment.router,
      abi: JINN_ROUTER_V3_E2E_ABI,
      functionName: 'createTask',
      args: [taskCidDigest, manifestDigest, policy, deliveryRate, deliveryRate, responseTimeout],
      value: deliveryRate * 4n,
      chain: baseSepolia,
    });
    const taskCreated = decodeFirstEvent(created.receipt, JINN_ROUTER_V3_E2E_ABI, 'TaskCreated');
    const taskId = String(taskCreated['taskId']);
    assert(BigInt(taskId) > 0n, `invalid TaskCreated taskId=${taskId}`);

    // Confirm the task was anchored under our manifest digest.
    const taskRecord = await publicClient.readContract({
      address: deployment.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'getTask',
      args: [BigInt(taskId)],
    });
    const onChainManifestDigest = String(tupleField<Hex>(taskRecord, 'manifestDigest', 2)).toLowerCase();
    assert(
      onChainManifestDigest === manifestDigest.toLowerCase(),
      `task manifestDigest mismatch: chain=${onChainManifestDigest} expected=${manifestDigest}`,
    );

    // Step 7 — reuse the claim/submit/verdict/finalize sequence from the
    // legacy fork loop. (Inlined here rather than refactored out to keep
    // diffs scoped to this phase.)
    const claim = await claimTask(
      publicClient,
      operatorWallet,
      operator.safeAddress,
      deployment.router,
      taskId,
      operator.mechAddress,
    );
    assert(claim.attemptIndex === 0, `first attempt index was ${claim.attemptIndex}`);
    const requestId = claim.requestId as Hex;

    const solutionPayload = makePredictionV1SolutionPayload();
    const solutionEnvelope = await signedExecutionEnvelope({
      solverType: 'prediction.v1',
      role: 'solution',
      taskCid,
      requestId,
      onchainCreationTx: created.hash,
      onchainCreationBlock: Number(created.receipt.blockNumber),
      safeAddress: operator.safeAddress,
      privateKey: operator.agentPrivateKey,
      window: predictionTask.window,
      payload: solutionPayload,
    });
    validatePayload('prediction.v1', 'solution', solutionEnvelope.payload);

    await callDeliverToMarketplace(
      publicClient,
      operatorWallet,
      operator.safeAddress,
      operator.mechAddress,
      [requestId],
      [solutionEnvelope.signature.hash],
    );
    await claimDelivery(
      publicClient,
      operatorWallet,
      operator.safeAddress,
      deployment.router,
      requestId,
      { variant: 'v3', kind: 'solution', evidenceHash: solutionEnvelope.signature.hash },
    );

    const verdictClaim = await createVerdictPorts({
      publicClient,
      broadcaster: createDirectSafeBroadcaster(
        publicClient,
        evaluatorWallet,
        evaluatorOperator.safeAddress as Address,
      ) as never,
      safeAddress: evaluatorOperator.safeAddress as Address,
      routerAddress: deployment.router as Address,
      mechAddress: evaluatorOperator.mechAddress as Address,
    }).openVerdictAttempt({
      operationId: `e2e-open-verdict:${requestId}`,
      taskId: BigInt(taskId),
      attemptIndex: claim.attemptIndex,
      evaluationTaskCidDigest: keccak256(toBytes(`evaluation:${taskCid}:${requestId}`)),
    });
    const verdictRequestId = verdictClaim.requestId as Hex;

    const evaluatorHarness = new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => makeResolvedPolymarketSnapshot(task),
      },
    });
    const evaluationTmp = await mkdtemp(join(tmpdir(), 'jinn-solvernet-eval-e2e-'));
    let verdictPayload: Record<string, unknown>;
    try {
      const verdictSolution = await evaluatorHarness.run({
        task: {
          ...task,
          role: 'evaluation',
          restorationRequestId: requestId,
          context: {
            restorationResult: JSON.stringify(solutionEnvelope),
            [SOLUTION_TASK_CID_CONTEXT_KEY]: taskCid,
            [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: 'bafy-solution-solvernet',
          },
        },
        taskCid,
        workingDir: evaluationTmp,
        implStateDir: join(evaluationTmp, 'state'),
        log: () => {},
        abort: new AbortController().signal,
        msUntilEndTs: () => 0,
        trajectory: new TrajectoryCollector({ taskCid, runId: requestId }),
      });
      assert(verdictSolution.verdictPayload, 'prediction evaluator did not return a verdictPayload');
      verdictPayload = verdictSolution.verdictPayload;
      validatePayload('prediction.v1', 'verdict', verdictPayload);
    } finally {
      await rm(evaluationTmp, { recursive: true, force: true });
    }

    const verdictEnvelope = await signedExecutionEnvelope({
      solverType: 'prediction.v1',
      role: 'verdict',
      taskCid,
      requestId: verdictRequestId,
      onchainCreationTx: created.hash,
      onchainCreationBlock: Number(created.receipt.blockNumber),
      safeAddress: evaluatorOperator.safeAddress,
      privateKey: evaluatorOperator.agentPrivateKey,
      window: predictionTask.window,
      payload: verdictPayload,
    });
    validatePayload('prediction.v1', 'verdict', verdictEnvelope.payload);

    await callDeliverToMarketplace(
      publicClient,
      evaluatorWallet,
      evaluatorOperator.safeAddress,
      evaluatorOperator.mechAddress,
      [verdictRequestId],
      [verdictEnvelope.signature.hash],
    );
    await claimDelivery(
      publicClient,
      evaluatorWallet,
      evaluatorOperator.safeAddress,
      deployment.router,
      verdictRequestId,
      { variant: 'v3', kind: 'verdict', evidenceHash: verdictEnvelope.signature.hash, verdictCode: 1 },
    );

    const taskRecordPostFinalize = await publicClient.readContract({
      address: deployment.coordinator,
      abi: TASK_COORDINATOR_E2E_ABI,
      functionName: 'getTask',
      args: [BigInt(taskId)],
    });
    const submittedCount = Number(tupleField<bigint>(taskRecordPostFinalize, 'submittedCount', 6));
    assert(submittedCount === 1, `submittedCount=${submittedCount}, expected 1`);

    // Wave-4 D3 retired the lifecycle-transition producer, so the former
    // Step 9 (paused → launched → retired, one setMetadata each) is gone.
    // The launch write is the only setMetadata this loop now performs.
    assert(
      publisher.calls.length === 1,
      `expected 1 setMetadata call for the launch, got ${publisher.calls.length}`,
    );
    return {
      manifestCid: launched.manifestCid,
      taskId,
      attempt: { operator: operator.safeAddress, attemptIndex: claim.attemptIndex, requestId },
      verdict: String(verdictPayload['verdict']),
      score: verdictScoreSummary(verdictPayload),
      submittedCount,
      setMetadataCalls: publisher.calls.length,
    };
  } finally {
    stopMiningPulse();
    if (launcherTmpDir) {
      await rm(launcherTmpDir, { recursive: true, force: true });
    }
    if (operatorTmpDir) {
      await rm(operatorTmpDir, { recursive: true, force: true });
    }
    if (evaluatorTmpDir) {
      await rm(evaluatorTmpDir, { recursive: true, force: true });
    }
    await rm(storeBaseDir, { recursive: true, force: true });
    await anvil.teardown();
  }
}

export async function runAnvilTaskFirstFullLoop(): Promise<AnvilTaskFirstFullLoopResult> {
  await compileContracts();

  const anvil = await spawnPlainAnvil();
  const accounts = ANVIL_PRIVATE_KEYS.map((key) => privateKeyToAccount(key));
  const [creator, operatorA, operatorB, evaluator] = accounts;
  assert(creator && operatorA && operatorB && evaluator, 'missing deterministic e2e accounts');
  const rate = parseEther('0.01');
  const publicClient = createPublicClient({
    chain: base,
    transport: http(anvil.rpcUrl),
  }) as unknown as PublicClient;

  try {
    for (const account of accounts) {
      await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
        account.address,
        '0x56bc75e2d63100000',
      ]);
    }

    const { deployment, artifacts } = await deployTaskFirstStack(
      publicClient,
      anvil.rpcUrl,
      creator,
      operatorA,
      operatorB,
      evaluator,
      rate,
    );

    const task = makePredictionV1Task();
    const predictionTask = PredictionV1TaskSchema.parse(task);
    const taskCidDigest = keccak256(toBytes(JSON.stringify(task)));
    const taskCid = `f01551220${taskCidDigest.slice(2)}`;
    const manifestDigest = keccak256(toBytes('prediction.v1'));
    // Tokenless-OLAS pivot: on-chain policy is now just `maxClaims`.
    const policy = { maxClaims: 3 };

    const created = await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: creator,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'createTask',
      args: [taskCidDigest, manifestDigest, policy, rate, rate, 3600n],
      value: rate * 6n,
    });
    const taskCreated = decodeFirstEvent(created.receipt, artifacts.router.abi, 'TaskCreated');
    const taskId = String(taskCreated['taskId']);
    assert(taskId === '1', `expected first taskId=1, got ${taskId}`);

    const claimA = await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: operatorA,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'claimTask',
      args: [1n, deployment.mechA],
    });
    const attemptA = decodeFirstEvent(claimA.receipt, artifacts.router.abi, 'TaskAttemptCreated');
    const requestIdA = String(attemptA['requestId']);
    const attemptIndexA = Number(attemptA['attemptIndex']);
    assert(attemptIndexA === 0, `first attempt index was ${attemptIndexA}`);

    await expectWriteRevert(
      () => writeContractTx({
        publicClient,
        rpcUrl: anvil.rpcUrl,
        account: operatorA,
        address: deployment.router,
        abi: artifacts.router.abi,
        functionName: 'claimTask',
        args: [1n, deployment.mechA],
      }),
      'duplicate operator claim',
    );

    const claimB = await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: operatorB,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'claimTask',
      args: [1n, deployment.mechB],
    });
    const attemptB = decodeFirstEvent(claimB.receipt, artifacts.router.abi, 'TaskAttemptCreated');
    const requestIdB = String(attemptB['requestId']);
    const attemptIndexB = Number(attemptB['attemptIndex']);
    assert(attemptIndexB === 1, `second attempt index was ${attemptIndexB}`);
    assert(requestIdB !== requestIdA, 'parallel attempts reused the same requestId');

    const solutionPayload = makePredictionV1SolutionPayload();
    const solutionEnvelope = await signedExecutionEnvelope({
      solverType: 'prediction.v1',
      role: 'solution',
      taskCid,
      requestId: requestIdA,
      onchainCreationTx: created.hash,
      onchainCreationBlock: Number(created.receipt.blockNumber),
      safeAddress: operatorA.address,
      privateKey: ANVIL_PRIVATE_KEYS[1],
      window: predictionTask.window,
      payload: solutionPayload,
    });
    validatePayload('prediction.v1', 'solution', solutionEnvelope.payload);

    await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: operatorA,
      address: deployment.mechA,
      abi: artifacts.mech.abi,
      functionName: 'deliverToMarketplace',
      args: [[requestIdA], [solutionEnvelope.signature.hash]],
    });
    await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: operatorA,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'claimSolutionDelivery',
      args: [requestIdA, solutionEnvelope.signature.hash],
    });
    const claimVerdict = await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: evaluator,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'claimEvaluation',
      args: [1n, 0, deployment.mechEvaluator, keccak256(toBytes(`evaluation:${taskCid}:${requestIdA}`))],
    });
    const verdictAttempt = decodeFirstEvent(claimVerdict.receipt, artifacts.router.abi, 'EvaluationAttemptCreated');
    const verdictRequestId = String(verdictAttempt['requestId']);
    const verdictIndex = Number(verdictAttempt['verdictIndex']);
    assert(verdictIndex === 0, `first verdict index was ${verdictIndex}`);

    const evaluatorHarness = new PredictionV1Evaluator({
      _testDeps: {
        getResolution: async () => makeResolvedPolymarketSnapshot(task),
      },
    });
    const evaluationTmp = await mkdtemp(join(tmpdir(), 'jinn-prediction-eval-e2e-'));
    let verdictPayload: Record<string, unknown>;
    try {
      const verdictSolution = await evaluatorHarness.run({
        task: {
          ...task,
          role: 'evaluation',
          restorationRequestId: requestIdA,
          context: {
            restorationResult: JSON.stringify(solutionEnvelope),
            [SOLUTION_TASK_CID_CONTEXT_KEY]: taskCid,
            [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: 'bafy-solution-anvil',
          },
        },
        taskCid,
        workingDir: evaluationTmp,
        implStateDir: join(evaluationTmp, 'state'),
        log: () => {},
        abort: new AbortController().signal,
        msUntilEndTs: () => 0,
        trajectory: new TrajectoryCollector({ taskCid, runId: requestIdA }),
      });
      assert(verdictSolution.verdictPayload, 'prediction evaluator did not return a verdictPayload');
      verdictPayload = verdictSolution.verdictPayload;
      validatePayload('prediction.v1', 'verdict', verdictPayload);
    } finally {
      await rm(evaluationTmp, { recursive: true, force: true });
    }

    const verdictEnvelope = await signedExecutionEnvelope({
      solverType: 'prediction.v1',
      role: 'verdict',
      taskCid,
      requestId: verdictRequestId,
      onchainCreationTx: created.hash,
      onchainCreationBlock: Number(created.receipt.blockNumber),
      safeAddress: evaluator.address,
      privateKey: ANVIL_PRIVATE_KEYS[3],
      window: predictionTask.window,
      payload: verdictPayload,
    });
    validatePayload('prediction.v1', 'verdict', verdictEnvelope.payload);

    await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: evaluator,
      address: deployment.mechEvaluator,
      abi: artifacts.mech.abi,
      functionName: 'deliverToMarketplace',
      args: [[verdictRequestId], [verdictEnvelope.signature.hash]],
    });
    await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: evaluator,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'claimVerdictDelivery',
      args: [verdictRequestId, verdictEnvelope.signature.hash, 1],
    });

    const verdictRef = await publicClient.readContract({
      address: deployment.coordinator,
      abi: artifacts.coordinator.abi,
      functionName: 'getVerdictRequestRef',
      args: [verdictRequestId],
    });
    assert(String(tupleField<bigint>(verdictRef, 'taskId', 0)) === taskId, 'local verdictRef taskId mismatch');
    assert(Number(tupleField<number | bigint>(verdictRef, 'attemptIndex', 1)) === attemptIndexA, 'local verdictRef attemptIndex mismatch');
    assert(Number(tupleField<number | bigint>(verdictRef, 'verdictIndex', 2)) === verdictIndex, 'local verdictRef verdictIndex mismatch');
    assert(tupleField<boolean>(verdictRef, 'exists', 3) === true, 'local verdictRef missing');

    const attemptRecord = await publicClient.readContract({
      address: deployment.coordinator,
      abi: artifacts.coordinator.abi,
      functionName: 'getAttempt',
      args: [1n, 0],
    });
    assert(tupleField<string>(attemptRecord, 'requestId', 3).toLowerCase() === requestIdA.toLowerCase(), 'attempt requestId mismatch');
    assert(tupleField<string>(attemptRecord, 'solutionCidDigest', 4).toLowerCase() === solutionEnvelope.signature.hash.toLowerCase(), 'submission evidence hash mismatch');
    assert(Number(tupleField<bigint>(attemptRecord, 'status', 9)) === 3, 'attempt was not submitted');
    assert(Number(tupleField<bigint>(attemptRecord, 'finalization', 10)) === 2, 'attempt was not finalized as passed');

    const requestRef = await publicClient.readContract({
      address: deployment.coordinator,
      abi: artifacts.coordinator.abi,
      functionName: 'getRequestRef',
      args: [requestIdA],
    });
    assert(String(tupleField<bigint>(requestRef, 'taskId', 0)) === taskId, 'verdict grouping requestRef taskId mismatch');

    const taskRecord = await publicClient.readContract({
      address: deployment.coordinator,
      abi: artifacts.coordinator.abi,
      functionName: 'getTask',
      args: [1n],
    });
    const submittedCount = Number(tupleField<bigint>(taskRecord, 'submittedCount', 6));
    assert(submittedCount === 1, `submittedCount=${submittedCount}, expected 1`);

    const [solutionWeight, verdictWeight, creatorWeight] = await Promise.all([
      publicClient.readContract({
        address: deployment.activity,
        abi: artifacts.activity.abi,
        functionName: 'solutionDeliveryWeight',
        args: [operatorA.address],
      }),
      publicClient.readContract({
        address: deployment.activity,
        abi: artifacts.activity.abi,
        functionName: 'verdictDeliveryWeight',
        args: [evaluator.address],
      }),
      publicClient.readContract({
        address: deployment.activity,
        abi: artifacts.activity.abi,
        functionName: 'taskCreationWeight',
        args: [creator.address],
      }),
    ]);
    assert(solutionWeight === parseEther('1'), `operatorA solution weight=${solutionWeight}`);
    assert(verdictWeight === parseEther('1'), `evaluator verdict weight=${verdictWeight}`);
    assert(creatorWeight === parseEther('1'), `creator weight=${creatorWeight}`);

    await anvilJsonRpc(anvil.rpcUrl, 'evm_increaseTime', [360]);
    await anvilJsonRpc(anvil.rpcUrl, 'anvil_mine', ['0x1']);
    await writeContractTx({
      publicClient,
      rpcUrl: anvil.rpcUrl,
      account: creator,
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'refundUnusedTaskBudget',
      args: [1n],
    });
    const payment = await publicClient.readContract({
      address: deployment.router,
      abi: artifacts.router.abi,
      functionName: 'taskPayments',
      args: [1n],
    });
    const refundedUnusedBudget =
      tupleField<bigint>(payment, 'solutionBudgetRemaining', 6) === 0n &&
      tupleField<bigint>(payment, 'verdictBudgetRemaining', 7) === 0n &&
      tupleField<boolean>(payment, 'solutionBudgetRefunded', 8) === true &&
      tupleField<boolean>(payment, 'verdictBudgetRefunded', 9) === true;
    assert(refundedUnusedBudget, 'unused Task budget was not refunded');

    return {
      taskId,
      attempts: [
        { operator: operatorA.address, attemptIndex: attemptIndexA, requestId: requestIdA },
        { operator: operatorB.address, attemptIndex: attemptIndexB, requestId: requestIdB },
      ],
      verdict: String(verdictPayload['verdict']),
      score: verdictScoreSummary(verdictPayload),
      submittedCount,
      refundedUnusedBudget,
    };
  } finally {
    await anvil.teardown();
  }
}

export async function runPredictionV1Smoke(): Promise<void> {
  const task = makePredictionV1Task();
  assert(task.solverType === 'prediction.v1', 'prediction smoke did not create prediction.v1 task');
  makePredictionV1SolutionPayload();
  makePredictionV1VerdictPayload();
}

// ── Freeze-mode Anvil-fork e2e (Phase A) ──────────────────────────────────────

/**
 * Build a HarnessContext suitable for invoking `runHarnessWithFreezeFence`
 * directly. Uses a real TrajectoryCollector so callers can snapshot spans
 * after the run.
 */
function buildFreezeFenceCtx(params: {
  task: Task;
  implStateDir: string;
  workingDir: string;
  mode: 'train' | 'frozen';
  trajectory?: TrajectoryCollector;
}): HarnessContext {
  const trajectory = params.trajectory ?? new TrajectoryCollector({
    taskCid: 'freeze-fence-fork-e2e',
    runId: `${params.task.id}:${params.mode}`,
  });
  const endTs = params.task.window?.endTs ?? Date.now() + 3_600_000;
  return {
    task: params.task,
    implStateDir: params.implStateDir,
    workingDir: params.workingDir,
    log: () => { /* no-op for fork e2e */ },
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
    trajectory,
    mode: params.mode,
  };
}

export interface FreezeFenceForkE2EResult {
  rpcUrl: string;
  /** codeDigest from the first frozen run (sha256 hex of empty implStateDir contents). */
  codeDigestRun1: string;
  /** codeDigest from the second frozen run; must equal run 1 (Phase A.1). */
  codeDigestRun2: string;
  /** Hash of implStateDir before the violating run (Phase A.3). */
  preViolationHash: string;
  /** Hash of implStateDir after rollback (Phase A.3); must equal preViolationHash. */
  postViolationHash: string;
  /** Files that survived rollback (Phase A.3); should equal pre-state files. */
  survivingFiles: string[];
  /** Violation metadata reported by the fence (Phase A.2). */
  violationHarnessName: string;
  violationStateHashBefore: string;
  violationStateHashAfter: string;
}

/**
 * Phase A — Anvil-fork e2e for the freeze-fence.
 *
 * Reuses `spawnPlainAnvil()` (the lighter local-Anvil path that the existing
 * `runAnvilTaskFirstFullLoop` uses) so this phase runs without depending on
 * an external Base Sepolia RPC. The fork env is incidental: the freeze-fence
 * is a pure file-system + harness contract, but spawning the Anvil harness
 * proves the fence works in the same process configuration that the daemon's
 * task lifecycle uses (and matches the existing e2e harness shape).
 *
 * Three assertions:
 *   1. Stable codeDigest — frozen-mode run twice on the same task yields
 *      identical `executor.codeDigest` values.
 *   2. Mutation detected — a harness that writes to implStateDir under
 *      `mode='frozen'` produces no envelope and a structured violation.
 *   3. Rollback works — after a violation, the implStateDir hash matches
 *      its pre-run hash (snapshot was restored).
 */
export async function runFreezeFenceForkE2E(): Promise<FreezeFenceForkE2EResult> {
  const anvil = await spawnPlainAnvil();
  const tmp = await mkdtemp(join(tmpdir(), 'jinn-freeze-fence-fork-e2e-'));

  try {
    // ── Case 1: stable codeDigest across two frozen runs ────────────────────
    const stableImplDir = join(tmp, 'stable', 'impl');
    const stableWorkDir = join(tmp, 'stable', 'work');
    await mkdir(stableImplDir, { recursive: true });
    await mkdir(stableWorkDir, { recursive: true });
    // Pre-populate so the hash is over real content (not the empty-dir sentinel).
    await writeFile(join(stableImplDir, 'knowledge.json'), JSON.stringify({ version: 1 }));
    await writeFile(join(stableImplDir, 'memory.txt'), 'baseline memory');

    const stableTask = makePredictionV1Task();
    const readonlyHarness: Harness = {
      name: 'freeze-fence-fork-readonly',
      version: '1.0.0',
      supports: () => true,
      async run(ctx) {
        // Frozen-compliant: emit a phase span but do NOT touch implStateDir.
        const t = String(Date.now() * 1_000_000);
        ctx.trajectory.addSpan({
          name: 'execute',
          kind: 'INTERNAL',
          startTimeUnixNano: t,
          endTimeUnixNano: t,
          attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'execute' },
          events: [],
          status: { code: 'OK' },
        });
        return {
          venueRef: { name: 'freeze-fence-fork' },
          gating: { accepted: true },
          informational: { rpcUrl: anvil.rpcUrl },
        } satisfies Solution;
      },
    };

    const ctxRun1 = buildFreezeFenceCtx({
      task: stableTask,
      implStateDir: stableImplDir,
      workingDir: stableWorkDir,
      mode: 'frozen',
    });
    const fenceRun1 = await runHarnessWithFreezeFence(readonlyHarness, ctxRun1);
    assert(fenceRun1.ok === true, 'Phase A.1: frozen run 1 must not violate');
    const codeDigestRun1 = fenceRun1.codeDigest;

    const ctxRun2 = buildFreezeFenceCtx({
      task: stableTask,
      implStateDir: stableImplDir,
      workingDir: stableWorkDir,
      mode: 'frozen',
    });
    const fenceRun2 = await runHarnessWithFreezeFence(readonlyHarness, ctxRun2);
    assert(fenceRun2.ok === true, 'Phase A.1: frozen run 2 must not violate');
    const codeDigestRun2 = fenceRun2.codeDigest;

    assert(
      codeDigestRun1 === codeDigestRun2,
      `Phase A.1: codeDigest must be stable across frozen runs (run1=${codeDigestRun1}, run2=${codeDigestRun2})`,
    );

    // ── Case 2 & 3: mutation detected + rollback works ──────────────────────
    const violatingImplDir = join(tmp, 'violating', 'impl');
    const violatingWorkDir = join(tmp, 'violating', 'work');
    await mkdir(violatingImplDir, { recursive: true });
    await mkdir(violatingWorkDir, { recursive: true });
    await writeFile(join(violatingImplDir, 'baseline.json'), JSON.stringify({ stable: true }));
    await writeFile(join(violatingImplDir, 'knowledge.json'), JSON.stringify({ version: 2 }));

    const preViolationFiles = (await readdir(violatingImplDir)).sort();
    const preViolationHash = await hashImplStateDir(violatingImplDir);

    const violatingTask = makePredictionV1Task();
    const violatingHarness: Harness = {
      name: 'freeze-fence-fork-violator',
      version: '1.0.0',
      supports: () => true,
      async run(ctx) {
        // Mid-task mutation: write a forbidden file under frozen mode.
        await writeFile(
          join(ctx.implStateDir, 'forbidden.txt'),
          'frozen-mode contract violation',
        );
        return {
          venueRef: { name: 'freeze-fence-fork' },
          gating: { accepted: false },
        } satisfies Solution;
      },
    };

    const ctxViolation = buildFreezeFenceCtx({
      task: violatingTask,
      implStateDir: violatingImplDir,
      workingDir: violatingWorkDir,
      mode: 'frozen',
    });
    const fenceViolation = await runHarnessWithFreezeFence(violatingHarness, ctxViolation);

    assert(
      fenceViolation.ok === false,
      'Phase A.2: violating frozen-mode harness must NOT produce a successful fence result',
    );

    const violation = !fenceViolation.ok ? fenceViolation.violation : undefined;
    assert(violation !== undefined, 'Phase A.2: violation metadata must be present');
    assert(
      violation.harnessName === 'freeze-fence-fork-violator',
      `Phase A.2: violation.harnessName mismatch: ${violation.harnessName}`,
    );
    assert(
      violation.stateHashBefore !== violation.stateHashAfter,
      'Phase A.2: violation must report differing pre/post state hashes',
    );

    // Rollback assertion (Phase A.3).
    const postViolationHash = await hashImplStateDir(violatingImplDir);
    assert(
      postViolationHash === preViolationHash,
      `Phase A.3: rollback must restore implStateDir hash (pre=${preViolationHash}, post=${postViolationHash})`,
    );
    const survivingFiles = (await readdir(violatingImplDir)).sort();
    assert(
      survivingFiles.length === preViolationFiles.length &&
        survivingFiles.every((f, i) => f === preViolationFiles[i]),
      `Phase A.3: rollback must restore the original file set ` +
      `(pre=[${preViolationFiles.join(', ')}], post=[${survivingFiles.join(', ')}])`,
    );

    process.stdout.write(
      `  case 1 (stable codeDigest): ${codeDigestRun1.slice(0, 16)}... == ${codeDigestRun2.slice(0, 16)}...\n` +
      `  case 2 (violation detected): harness=${violation.harnessName} ` +
      `before=${violation.stateHashBefore.slice(0, 12)}... after=${violation.stateHashAfter.slice(0, 12)}...\n` +
      `  case 3 (rollback): files=[${survivingFiles.join(', ')}] hash=${postViolationHash.slice(0, 16)}...\n`,
    );

    return {
      rpcUrl: anvil.rpcUrl,
      codeDigestRun1,
      codeDigestRun2,
      preViolationHash,
      postViolationHash,
      survivingFiles,
      violationHarnessName: violation.harnessName,
      violationStateHashBefore: violation.stateHashBefore,
      violationStateHashAfter: violation.stateHashAfter,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await anvil.teardown();
  }
}

// ── Train-vs-frozen trajectory e2e (Phase B) ──────────────────────────────────

/**
 * A modeful mock harness that emits trajectory phase spans gated on
 * `ctx.mode`. Mirrors the SKILL-level dispatch in
 * `client/plugins/learner/skills/coordinator/SKILL.md`:
 *
 *   - Always emits `orient`, `strategize`, `plan`, `execute`, `debrief`.
 *   - Only emits `improve` and `memory` when ctx.mode === 'train'.
 *
 * The point of this harness is the e2e plumbing — confirming that
 * `ctx.mode` reaches the harness and observably changes its trajectory
 * output. The harness writes a small file in train mode (legitimate
 * implStateDir mutation) so the freeze-fence is also exercised.
 */
function modefulCoordinatorMockHarness(): Harness {
  const ALWAYS_PHASES = ['orient', 'strategize', 'plan', 'execute', 'debrief'] as const;
  const TRAIN_ONLY_PHASES = ['improve', 'memory'] as const;
  return {
    name: 'modeful-coordinator-mock',
    version: '1.0.0',
    supports: () => true,
    async run(ctx) {
      const emit = (phaseName: string) => {
        const t = String(Date.now() * 1_000_000);
        ctx.trajectory.addSpan({
          name: phaseName,
          kind: 'INTERNAL',
          startTimeUnixNano: t,
          endTimeUnixNano: t,
          attributes: {
            'jinn.span.kind': 'jinn.phase',
            'jinn.phase.name': phaseName,
            'jinn.mode': ctx.mode,
          },
          events: [],
          status: { code: 'OK' },
        });
      };

      for (const p of ALWAYS_PHASES) emit(p);
      if (ctx.mode === 'train') {
        for (const p of TRAIN_ONLY_PHASES) emit(p);
        // Exercise the train-mode write path so the fence's train branch
        // is also covered. No-op in frozen mode to honour the contract.
        await writeFile(
          join(ctx.implStateDir, 'train-memory.json'),
          JSON.stringify({ phase: 'memory', writtenAt: Date.now() }),
        );
      }

      return {
        venueRef: { name: 'modeful-mock' },
        gating: { accepted: true },
        informational: { mode: ctx.mode },
      } satisfies Solution;
    },
  };
}

export interface TrainVsFrozenTrajectoryE2EResult {
  rpcUrl: string;
  trainPhaseSpans: string[];
  frozenPhaseSpans: string[];
  trainCodeDigest: string;
  frozenCodeDigest: string;
}

/**
 * Phase B — assert that `ctx.mode` flows from config → engine → harness →
 * trajectory and is observable downstream by reading phase span names.
 *
 *   - Train run: trajectory contains `improve` and `memory` phase spans.
 *   - Frozen run: trajectory contains NO `improve` or `memory` phase spans.
 *
 * Both runs are driven through `runHarnessWithFreezeFence` (the same fence
 * the daemon uses) on a freshly spawned Anvil — exercising the same plumbing
 * the fork-Task-first lifecycle uses, minus the on-chain settlement (the
 * trajectory contract is a pure ctx.mode propagation property and does not
 * require on-chain state).
 */
export async function runTrainVsFrozenTrajectoryE2E(): Promise<TrainVsFrozenTrajectoryE2EResult> {
  const anvil = await spawnPlainAnvil();
  const tmp = await mkdtemp(join(tmpdir(), 'jinn-train-vs-frozen-e2e-'));

  try {
    const harness = modefulCoordinatorMockHarness();
    const sharedTask = makePredictionV1Task();

    // ── Train run ───────────────────────────────────────────────────────────
    const trainImplDir = join(tmp, 'train', 'impl');
    const trainWorkDir = join(tmp, 'train', 'work');
    await mkdir(trainImplDir, { recursive: true });
    await mkdir(trainWorkDir, { recursive: true });
    const trainTrajectory = new TrajectoryCollector({
      taskCid: 'modeful-train',
      runId: 'train-run-1',
    });
    const trainCtx = buildFreezeFenceCtx({
      task: sharedTask,
      implStateDir: trainImplDir,
      workingDir: trainWorkDir,
      mode: 'train',
      trajectory: trainTrajectory,
    });
    const trainFence = await runHarnessWithFreezeFence(harness, trainCtx);
    assert(trainFence.ok === true, 'Phase B: train run must not violate');
    const trainSnapshot = trainTrajectory.snapshot();
    const trainPhaseSpans = trainSnapshot.spans
      .filter((s) => s.attributes['jinn.span.kind'] === 'jinn.phase')
      .map((s) => String(s.attributes['jinn.phase.name']));

    assert(
      trainPhaseSpans.includes('improve'),
      `Phase B (train): trajectory must contain "improve" span; got [${trainPhaseSpans.join(', ')}]`,
    );
    assert(
      trainPhaseSpans.includes('memory'),
      `Phase B (train): trajectory must contain "memory" span; got [${trainPhaseSpans.join(', ')}]`,
    );

    // ── Frozen run ──────────────────────────────────────────────────────────
    const frozenImplDir = join(tmp, 'frozen', 'impl');
    const frozenWorkDir = join(tmp, 'frozen', 'work');
    await mkdir(frozenImplDir, { recursive: true });
    await mkdir(frozenWorkDir, { recursive: true });
    // Pre-populate so the codeDigest is over real content.
    await writeFile(join(frozenImplDir, 'frozen-baseline.json'), JSON.stringify({ baseline: true }));

    const frozenTrajectory = new TrajectoryCollector({
      taskCid: 'modeful-frozen',
      runId: 'frozen-run-1',
    });
    const frozenCtx = buildFreezeFenceCtx({
      task: sharedTask,
      implStateDir: frozenImplDir,
      workingDir: frozenWorkDir,
      mode: 'frozen',
      trajectory: frozenTrajectory,
    });
    const frozenFence = await runHarnessWithFreezeFence(harness, frozenCtx);
    assert(
      frozenFence.ok === true,
      'Phase B: frozen run must not violate (modeful harness must not write in frozen mode)',
    );
    const frozenSnapshot = frozenTrajectory.snapshot();
    const frozenPhaseSpans = frozenSnapshot.spans
      .filter((s) => s.attributes['jinn.span.kind'] === 'jinn.phase')
      .map((s) => String(s.attributes['jinn.phase.name']));

    assert(
      !frozenPhaseSpans.includes('improve'),
      `Phase B (frozen): trajectory must NOT contain "improve" span; got [${frozenPhaseSpans.join(', ')}]`,
    );
    assert(
      !frozenPhaseSpans.includes('memory'),
      `Phase B (frozen): trajectory must NOT contain "memory" span; got [${frozenPhaseSpans.join(', ')}]`,
    );

    process.stdout.write(
      `  train phases:  [${trainPhaseSpans.join(', ')}]\n` +
      `  frozen phases: [${frozenPhaseSpans.join(', ')}]\n`,
    );

    return {
      rpcUrl: anvil.rpcUrl,
      trainPhaseSpans,
      frozenPhaseSpans,
      trainCodeDigest: trainFence.ok ? trainFence.codeDigest : '',
      frozenCodeDigest: frozenFence.ok ? frozenFence.codeDigest : '',
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await anvil.teardown();
  }
}

export async function runContractIntegration(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'yarn',
      ['--cwd', '../contracts', 'test', 'test/TaskCoordinatorRouterV3.integration.test.ts'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: process.env,
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`contract integration failed with exit code ${code}`));
    });
  });
}
