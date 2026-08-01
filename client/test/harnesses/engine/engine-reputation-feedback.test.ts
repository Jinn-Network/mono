/**
 * Tests for ReputationRegistry feedback hook integration in engine.deliver()
 * (jinn-mono-yg4).
 *
 * Covers the evaluator-delivery path:
 *   - When verdict=PASS and the resolver returns an agentId, the hook is
 *     called with the right args (agentId, manifestRef, manifestHash).
 *   - When verdict=REJECTED, no feedback is posted (mapVerdictToScore→null).
 *   - When the resolver returns null (no subgraph match), no feedback is
 *     posted but the engine still completes the delivery (no throw).
 *   - Restoration tasks (taskRole=restoration) skip the feedback path
 *     entirely — the hook is for evaluators only.
 *   - Unexpected throws inside the hook are swallowed; deliver still
 *     transitions to COMPLETE.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Hex } from 'viem';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { ReputationRegistryClient, ResolvedAgent } from '../../../src/erc8004/index.js';
import { claimDelivery as mockedClaimDelivery } from '../../../src/adapters/mech/contracts.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  cidToDigestHex: vi
    .fn()
    .mockReturnValue(
      '0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    ),
  uploadToIpfs: vi.fn(),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi
    .fn()
    .mockResolvedValue('0xdeliverytx' as `0x${string}`),
  claimDelivery: vi.fn().mockResolvedValue('0xclaimtx' as `0x${string}`),
  submitTask: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanTasks: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RESTORER_EVIDENCE_HASH =
  '0xfeedfacedeadbeef00000000000000000000000000000000000000000000beef' as Hex;
const RESTORER_AGENT_ID = 1234n;
const RESTORER_MANIFEST_CID_FROM_SUBGRAPH = 'bafyharnessCidFromSubgraph';

// A minimal harness manifest JSON that the engine extracts evidenceHash from.
function buildInlinedRestorationResult(): string {
  const harnessManifest = {
    schemaVersion: 'portfolio.v0.manifest.v1',
task: {
      cid: 'bafyintent',
      onchainCreationTx: '0xtx',
      onchainCreationBlock: 100,
      requestId: '0xharnessReq',
    },
    signature: {
      algo: 'secp256k1',
      signer: '0xsigner',
      hash: RESTORER_EVIDENCE_HASH,
      sig: '0xsig',
    },
  };
  return JSON.stringify(harnessManifest);
}

interface MakeOptsArgs {
  reputationFeedback?: NonNullable<TaskEngineOptions['reputationFeedback']>;
}

function makeOpts(
  store: Store,
  args: MakeOptsArgs = {},
): TaskEngineOptions {
  return {
    store,
    paths: {
      workingDirRoot: '/tmp/eng-rep-fb-work',
      implStateDirRoot: '/tmp/eng-rep-fb-impl',
    },
    deliveryDeps: {
      publicClient: {} as import('viem').PublicClient,
      walletClient: {} as import('viem').WalletClient,
      safeAddress: '0xsafe' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: 'v2',
    },
    ...(args.reputationFeedback
      ? { reputationFeedback: args.reputationFeedback }
      : {}),
  };
}

class TestEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }
}

interface SeedOptions {
  taskRole: 'restoration' | 'evaluation';
  verdict: 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE' | null;
  inlineHarnessManifest: boolean;
  /**
   * Override the full `gatingClaim` shape persisted at POST_SNAPSHOT. When
   * provided, supersedes the default `{ verdict, score }` derived from
   * `opts.verdict` — used to assert engine behaviour against harness-specific
   * gating shapes (e.g. swe-rebench-v2's `{ score, passed_match, verdict }`).
   */
  gatingClaimOverride?: Record<string, unknown>;
  /** Override the persisted `solverType` (default `portfolio.v0`). */
  solverType?: string;
}

async function seedDelivering(
  engine: TestEngine,
  requestId: string,
  opts: SeedOptions,
): Promise<void> {
  const now = Date.now() - 1000;
  const solverType = opts.solverType ?? 'portfolio.v0';
  const task: PersistedTaskRunInput['task'] = {
    id: requestId,
    description: 'eval test',
    role: opts.taskRole,
    solverType,
    ...(opts.taskRole === 'evaluation' && opts.inlineHarnessManifest
      ? {
          context: { restorationResult: buildInlinedRestorationResult() },
          restorationRequestId: '0xharnessReq',
        }
      : {}),
  };

  const input: PersistedTaskRunInput = {
    requestId,
    taskCid: 'bafyintent',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType,
    taskRole: opts.taskRole,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task,
  };
  await engine.observe(input);

  const p = engine.testPersistence;
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT, {
    workingDir: '/tmp/wd',
    implStateDir: '/tmp/impl',
    preSnapshotCapturedAt: now,
    preSnapshotPayload: { capturedAt: now, hlTime: 0 },
  });
  p.transition(requestId, TaskRunState.RUNNING);
  p.transition(requestId, TaskRunState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: now,
    postSnapshotPayload: { capturedAt: now, hlTime: 0 },
    fillsPayload: [],
    gatingClaim: opts.gatingClaimOverride ?? (opts.verdict ? { verdict: opts.verdict, score: '0.5' } : {}),
  });
  p.transition(requestId, TaskRunState.PACKAGING, {
    manifestCid: 'bafyEvalManifest',
    artifactCids: {},
    evidenceHash:
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex,
  });
  p.transition(requestId, TaskRunState.DELIVERING);
}

function makeRegistry(
  giveFeedbackImpl: (...args: unknown[]) => Promise<`0x${string}`> = async () =>
    '0xtx-feedback' as `0x${string}`,
): ReputationRegistryClient {
  return {
    giveFeedback: vi.fn(giveFeedbackImpl),
    revokeFeedback: vi.fn(),
    respondToFeedback: vi.fn(),
    readFeedback: vi.fn(),
    readAllFeedback: vi.fn(),
    getSummary: vi.fn(),
    getClients: vi.fn(),
    getLastIndex: vi.fn(),
  } as unknown as ReputationRegistryClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Engine reputation feedback wiring (jinn-mono-yg4)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    // Engine.verdictCodeForTask flows into claimDelivery's `verdictCode`
    // argument — reset between tests so per-test assertions on call args
    // are not polluted by sibling tests.
    vi.mocked(mockedClaimDelivery).mockClear();
  });
  afterEach(() => {
    store.close();
  });

  it('PASS verdict + agentId resolved → giveFeedback called with manifest:<cid> + evidenceHash', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-pass';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);

    expect(resolveAgentId).toHaveBeenCalledWith(RESTORER_EVIDENCE_HASH);
    expect(registry.giveFeedback).toHaveBeenCalledOnce();
    expect(registry.giveFeedback).toHaveBeenCalledWith({
      harnessAgentId: RESTORER_AGENT_ID,
      score: 100,
      scoreDecimals: 2,
      manifestRef: `manifest:${RESTORER_MANIFEST_CID_FROM_SUBGRAPH}`,
      manifestHash: RESTORER_EVIDENCE_HASH,
      tag1: 'portfolio.v0',
    });
  });

  it('FAIL verdict → giveFeedback called with score=0', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-fail';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'FAIL',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    expect(registry.giveFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ score: 0, scoreDecimals: 2 }),
    );
  });

  it('REJECTED verdict → no giveFeedback call (eligibility-miss policy)', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-rejected';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'REJECTED',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('INDETERMINATE verdict → no giveFeedback call', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-indet';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'INDETERMINATE',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('resolver returns null → no giveFeedback call but state still COMPLETE', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue(null);

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-nores';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);
    expect(resolveAgentId).toHaveBeenCalled();
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('restoration Task → never calls resolver / giveFeedback (evaluator-only path)', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-restore';
    await seedDelivering(engine, requestId, {
      taskRole: 'restoration',
      verdict: 'PASS',
      inlineHarnessManifest: false,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);
    expect(resolveAgentId).not.toHaveBeenCalled();
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('no reputationFeedback configured → deliver completes without attempting feedback', async () => {
    const engine = new TestEngine(makeOpts(store));
    const requestId = '0xrid-no-fb-deps';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);
  });

  it('hook unexpected throw is swallowed; deliver still COMPLETE', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = makeRegistry(() => {
      throw new Error('boom');
    });
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: null,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-throw';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);
    // submitEvaluatorFeedback already classifies arbitrary errors as `failed`,
    // so deliver finishes cleanly. The warn spy is just here to confirm we
    // didn't mistakenly route the throw through the engine's catch path.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('reputation feedback unexpected throw'),
    );
  });

  it('evaluator Task missing inlined restorationResult → skip feedback (warn) but still COMPLETE', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: null,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-eval-noinline';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: false,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);
    expect(resolveAgentId).not.toHaveBeenCalled();
    expect(registry.giveFeedback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not extract harness manifest hash'),
    );
  });

  // ── swe-rebench-v2 regression coverage (jinn-mono-uy6v.10) ─────────────────
  //
  // Before the fix, the swe-rebench-v2-evaluator harness emitted
  // `gating: { score, passed_match }` (no `verdict` field). The engine's
  // feedback hook reads `gatingClaim.verdict`, so the hook silently no-op'd
  // on every verdict and the agent-reputation registry was never updated.
  //
  // The harness now derives `verdict: 'PASS' | 'FAIL'` from `passed_match`
  // and includes it in `gating`. These tests pin that the engine reads it
  // and submits feedback for both PASS and FAIL deliveries.

  it('swe-rebench-v2 passed_match=true gating → PASS feedback (score=100)', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-swe-rebench-pass';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
      solverType: 'swe-rebench-v2.v1',
      // Real shape emitted by SweRebenchV2EvaluatorHarness.run() on a passing
      // grade. The `verdict` field is what the engine's feedback hook keys on.
      gatingClaimOverride: { score: 1, passed_match: true, verdict: 'PASS' },
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);

    expect(resolveAgentId).toHaveBeenCalledWith(RESTORER_EVIDENCE_HASH);
    expect(registry.giveFeedback).toHaveBeenCalledOnce();
    expect(registry.giveFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessAgentId: RESTORER_AGENT_ID,
        score: 100,
        scoreDecimals: 2,
        manifestRef: `manifest:${RESTORER_MANIFEST_CID_FROM_SUBGRAPH}`,
        manifestHash: RESTORER_EVIDENCE_HASH,
        tag1: 'swe-rebench-v2.v1',
      }),
    );
  });

  it('swe-rebench-v2 passed_match=false gating → FAIL feedback (score=0)', async () => {
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-swe-rebench-fail';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'FAIL',
      inlineHarnessManifest: true,
      solverType: 'swe-rebench-v2.v1',
      gatingClaimOverride: { score: 0, passed_match: false, verdict: 'FAIL' },
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(TaskRunState.COMPLETE);

    expect(registry.giveFeedback).toHaveBeenCalledOnce();
    expect(registry.giveFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessAgentId: RESTORER_AGENT_ID,
        score: 0,
        scoreDecimals: 2,
        tag1: 'swe-rebench-v2.v1',
      }),
    );
  });

  // ── On-chain verdictCode pinning (jinn-mono-uy6v.10 review) ───────────────
  //
  // `verdictCodeForTask` reads `gatingClaim.verdict` and maps PASS→1, FAIL→2,
  // INVALID→3, INDETERMINATE/UNRESOLVED→4. The default arm fails closed so a
  // gatingClaim without a recognised `verdict` field cannot consume the
  // on-chain delivery slot as either PASS or Invalid.
  function lastClaimVerdictCode(): number | undefined {
    const calls = vi.mocked(mockedClaimDelivery).mock.calls;
    if (calls.length === 0) return undefined;
    const lastCall = calls[calls.length - 1]!;
    // `claimDelivery`'s options argument sits at index 6: the venue broadcaster was
    // threaded in at index 2 when it stopped being process-global state.
    const options = lastCall[6] as { verdictCode?: number };
    return options.verdictCode;
  }

  it('swe-rebench-v2 verdict=FAIL gating → on-chain claimDelivery tagged with FAIL code (2)', async () => {
    const engine = new TestEngine(makeOpts(store));
    const requestId = '0xrid-verdictcode-fail';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'FAIL',
      inlineHarnessManifest: true,
      solverType: 'swe-rebench-v2.v1',
      gatingClaimOverride: { score: 0, passed_match: false, verdict: 'FAIL' },
    });

    await engine.process(requestId);

    expect(engine.testPersistence.getByRequestId(requestId)!.state).toBe(
      TaskRunState.COMPLETE,
    );
    expect(lastClaimVerdictCode()).toBe(2);
  });

  it('swe-rebench-v2 verdict=PASS gating → on-chain claimDelivery tagged with PASS code (1)', async () => {
    const engine = new TestEngine(makeOpts(store));
    const requestId = '0xrid-verdictcode-pass';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
      solverType: 'swe-rebench-v2.v1',
      gatingClaimOverride: { score: 1, passed_match: true, verdict: 'PASS' },
    });

    await engine.process(requestId);

    expect(engine.testPersistence.getByRequestId(requestId)!.state).toBe(
      TaskRunState.COMPLETE,
    );
    expect(lastClaimVerdictCode()).toBe(1);
  });

  it('pre-fix gating shape (no verdict field) fails before on-chain claimDelivery', async () => {
    const engine = new TestEngine(makeOpts(store));
    const requestId = '0xrid-verdictcode-prefix';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS', // ignored by the override below
      inlineHarnessManifest: true,
      solverType: 'swe-rebench-v2.v1',
      gatingClaimOverride: { score: 0, passed_match: false }, // no `verdict`
    });

    await expect(engine.process(requestId)).rejects.toThrow(
      /missing or unrecognized gatingClaim\.verdict/,
    );

    expect(mockedClaimDelivery).not.toHaveBeenCalled();
  });

  it('swe-rebench-v2 pre-fix gating shape (no verdict field) fails before feedback or delivery', async () => {
    // This pins the pre-fix bug: a gatingClaim that carries score + passed_match
    // but NO `verdict` field is exactly what the live daemon was producing
    // (uy6v.10). The hook MUST skip with the recognisable log and never call
    // giveFeedback — so if a future harness regresses to that shape, this test
    // catches it loudly (no more silent no-op).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = makeRegistry();
    const resolveAgentId = vi
      .fn<(h: Hex) => Promise<ResolvedAgent | null>>()
      .mockResolvedValue({
        agentId: RESTORER_AGENT_ID,
        manifestCid: RESTORER_MANIFEST_CID_FROM_SUBGRAPH,
      });

    const engine = new TestEngine(
      makeOpts(store, {
        reputationFeedback: { client: registry, resolveAgentId },
      }),
    );
    const requestId = '0xrid-swe-rebench-pre-fix';
    await seedDelivering(engine, requestId, {
      taskRole: 'evaluation',
      verdict: 'PASS',
      inlineHarnessManifest: true,
      solverType: 'swe-rebench-v2.v1',
      // The exact shape the harness used to emit before uy6v.10.
      gatingClaimOverride: { score: 1, passed_match: true },
    });

    await expect(engine.process(requestId)).rejects.toThrow(
      /missing or unrecognized gatingClaim\.verdict/,
    );

    expect(registry.giveFeedback).not.toHaveBeenCalled();
    expect(mockedClaimDelivery).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
