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
 *   - Restoration intents (intentType=restoration) skip the feedback path
 *     entirely — the hook is for evaluators only.
 *   - Unexpected throws inside the hook are swallowed; deliver still
 *     transitions to COMPLETE.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Hex } from 'viem';
import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  type RestorationEngineOptions,
  type RestorerImplRegistry,
} from '../../../src/restorer/engine/engine.js';
import {
  IntentPersistence,
  type PersistedIntentInput,
} from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { ReputationRegistryClient } from '../../../src/reputation/registry.js';
import type { ResolvedAgent } from '../../../src/discovery/agent-resolver.js';

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
  submitRestorationJob: vi.fn(),
  submitEvaluationJob: vi.fn(),
  claimJob: vi.fn(),
  getJobClaim: vi.fn(),
  getMechDeliveryRate: vi.fn(),
  getTimeoutBounds: vi.fn(),
  pollDeliverEvents: vi.fn(),
  decodeMarketplaceRequestLogs: vi.fn(),
  decodeDeliverLogs: vi.fn(),
  scanRestorationJobs: vi.fn(),
  scanEvaluationJobs: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RESTORER_EVIDENCE_HASH =
  '0xfeedfacedeadbeef00000000000000000000000000000000000000000000beef' as Hex;
const RESTORER_AGENT_ID = 1234n;
const RESTORER_MANIFEST_CID_FROM_SUBGRAPH = 'bafyrestorerCidFromSubgraph';

const noopRegistry: RestorerImplRegistry = {
  resolveImplName: () => null,
};

// A minimal restorer manifest JSON that the engine extracts evidenceHash from.
function buildInlinedRestorationResult(): string {
  const restorerManifest = {
    schemaVersion: 'portfolio.v0.manifest.v1',
    intent: {
      cid: 'bafyintent',
      onchainCreationTx: '0xtx',
      onchainCreationBlock: 100,
      requestId: '0xrestorerReq',
    },
    signature: {
      algo: 'secp256k1',
      signer: '0xsigner',
      hash: RESTORER_EVIDENCE_HASH,
      sig: '0xsig',
    },
  };
  return JSON.stringify(restorerManifest);
}

interface MakeOptsArgs {
  reputationFeedback?: NonNullable<RestorationEngineOptions['reputationFeedback']>;
}

function makeOpts(
  store: Store,
  args: MakeOptsArgs = {},
): RestorationEngineOptions {
  return {
    store,
    registry: noopRegistry,
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

class TestEngine extends RestorationEngine {
  get testPersistence(): IntentPersistence {
    return this.persistence;
  }
}

interface SeedOptions {
  intentType: 'restoration' | 'evaluation';
  verdict: 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE' | null;
  inlineRestorerManifest: boolean;
}

async function seedDelivering(
  engine: TestEngine,
  requestId: string,
  opts: SeedOptions,
): Promise<void> {
  const now = Date.now() - 1000;
  const desiredState: PersistedIntentInput['desiredState'] = {
    id: requestId,
    description: 'eval test',
    type: opts.intentType,
    ...(opts.intentType === 'evaluation' && opts.inlineRestorerManifest
      ? {
          context: { restorationResult: buildInlinedRestorationResult() },
          restorationRequestId: '0xrestorerReq',
        }
      : {}),
  };

  const input: PersistedIntentInput = {
    requestId,
    intentCid: 'bafyintent',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    specKind: 'portfolio.v0',
    intentType: opts.intentType,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    desiredState,
  };
  await engine.observe(input);

  const p = engine.testPersistence;
  p.transition(requestId, IntentState.CLAIMED);
  p.transition(requestId, IntentState.WAITING);
  p.transition(requestId, IntentState.PRE_SNAPSHOT, {
    workingDir: '/tmp/wd',
    implStateDir: '/tmp/impl',
    preSnapshotCapturedAt: now,
    preSnapshotPayload: { capturedAt: now, hlTime: 0 },
  });
  p.transition(requestId, IntentState.RUNNING);
  p.transition(requestId, IntentState.POST_SNAPSHOT, {
    postSnapshotCapturedAt: now,
    postSnapshotPayload: { capturedAt: now, hlTime: 0 },
    fillsPayload: [],
    gatingClaim: opts.verdict ? { verdict: opts.verdict, score: '0.5' } : {},
  });
  p.transition(requestId, IntentState.PACKAGING, {
    manifestCid: 'bafyEvalManifest',
    artifactCids: {},
    evidenceHash:
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex,
  });
  p.transition(requestId, IntentState.DELIVERING);
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
      intentType: 'evaluation',
      verdict: 'PASS',
      inlineRestorerManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);

    expect(resolveAgentId).toHaveBeenCalledWith(RESTORER_EVIDENCE_HASH);
    expect(registry.giveFeedback).toHaveBeenCalledOnce();
    expect(registry.giveFeedback).toHaveBeenCalledWith({
      restorerAgentId: RESTORER_AGENT_ID,
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
      intentType: 'evaluation',
      verdict: 'FAIL',
      inlineRestorerManifest: true,
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
      intentType: 'evaluation',
      verdict: 'REJECTED',
      inlineRestorerManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
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
      intentType: 'evaluation',
      verdict: 'INDETERMINATE',
      inlineRestorerManifest: true,
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
      intentType: 'evaluation',
      verdict: 'PASS',
      inlineRestorerManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
    expect(resolveAgentId).toHaveBeenCalled();
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('restoration intent → never calls resolver / giveFeedback (evaluator-only path)', async () => {
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
      intentType: 'restoration',
      verdict: 'PASS',
      inlineRestorerManifest: false,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
    expect(resolveAgentId).not.toHaveBeenCalled();
    expect(registry.giveFeedback).not.toHaveBeenCalled();
  });

  it('no reputationFeedback configured → deliver completes without attempting feedback', async () => {
    const engine = new TestEngine(makeOpts(store));
    const requestId = '0xrid-no-fb-deps';
    await seedDelivering(engine, requestId, {
      intentType: 'evaluation',
      verdict: 'PASS',
      inlineRestorerManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
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
      intentType: 'evaluation',
      verdict: 'PASS',
      inlineRestorerManifest: true,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
    // submitEvaluatorFeedback already classifies arbitrary errors as `failed`,
    // so deliver finishes cleanly. The warn spy is just here to confirm we
    // didn't mistakenly route the throw through the engine's catch path.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('reputation feedback unexpected throw'),
    );
  });

  it('evaluator intent missing inlined restorationResult → skip feedback (warn) but still COMPLETE', async () => {
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
      intentType: 'evaluation',
      verdict: 'PASS',
      inlineRestorerManifest: false,
    });

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.COMPLETE);
    expect(resolveAgentId).not.toHaveBeenCalled();
    expect(registry.giveFeedback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not extract restorer manifest hash'),
    );
  });
});
