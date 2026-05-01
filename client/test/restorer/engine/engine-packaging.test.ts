/**
 * Integration tests for engine.ts packaging + delivery integration.
 *
 * Tests that pack() and deliver() stubs are replaced with real behaviour when
 * packagingDeps + envelopeDeps + deliveryDeps are injected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  NotImplementedError,
  type RestorationEngineOptions,
} from '../../../src/restorer/engine/engine.js';
import { IntentPersistence, type PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

vi.mock('../../../src/adapters/mech/contracts.js', () => ({
  callDeliverToMarketplace: vi.fn().mockResolvedValue('0xdeliverytx' as `0x${string}`),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;

function mkTmp(): string {
  const dir = join(tmpdir(), `eng-pkg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInput(requestId: string, tmp: string): PersistedIntentInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    intentCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    specKind: 'portfolio.v0',
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    restorationJob: { id: requestId, description: 'test' },
  };
}

function makeOpts(store: Store, tmp: string): RestorationEngineOptions {
  return {
    store,
    paths: {
      workingDirRoot: join(tmp, 'restorations'),
      implStateDirRoot: join(tmp, 'impls'),
    },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
    deliveryDeps: {
      publicClient: {} as import('viem').PublicClient,
      walletClient: {} as import('viem').WalletClient,
      safeAddress: '0xsafe' as `0x${string}`,
      mechContractAddress: '0xmech' as `0x${string}`,
      routerAddress: '0xrouter' as `0x${string}`,
      claimDeliveryVariant: 'v2',
    },
  };
}

// ── TestEngine subclass ───────────────────────────────────────────────────────

class TestEngine extends RestorationEngine {
  get testPersistence(): IntentPersistence {
    return this.persistence;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Engine packaging integration', () => {
  let store: Store;
  let tmp: string;
  let engine: TestEngine;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    engine = new TestEngine(makeOpts(store, tmp));
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('takePreSnapshot provisions workingDir and advances state', async () => {
    await engine.observe(makeInput('req-001', tmp));
    // Advance to CLAIMED → WAITING (window started in the past)
    engine.testPersistence.transition('req-001', IntentState.CLAIMED);
    engine.testPersistence.transition('req-001', IntentState.WAITING);
    // Process WAITING → dataDrivenAdvance says PRE_SNAPSHOT → transitions to
    // PRE_SNAPSHOT, then calls takePreSnapshot which transitions PRE_SNAPSHOT
    // → RUNNING. Per jinn-mono-sae, process() then re-dispatches into RUNNING;
    // with no impl registered runImpl throws NotImplementedError → FAILED.
    await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
    const intent = engine.testPersistence.getByRequestId('req-001');
    expect(intent!.state).toBe(IntentState.FAILED);
    expect(intent!.workingDir).toBeTruthy();
    expect(intent!.implStateDir).toBeTruthy();
  });

  it('takePreSnapshot without deps still works (only uses filesystem)', async () => {
    // takePreSnapshot has no external deps — always functional. It transitions
    // directly PRE_SNAPSHOT → RUNNING (snapshot is immediately ready).
    // Per jinn-mono-sae, process() re-dispatches against the post-transition
    // state so RUNNING fires in the same pass; with no impl registered the
    // re-dispatch hits runImpl → NotImplementedError → FAILED.
    await engine.observe(makeInput('req-001', tmp));
    engine.testPersistence.transition('req-001', IntentState.CLAIMED);
    engine.testPersistence.transition('req-001', IntentState.WAITING);
    engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
    await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
    const intent = engine.testPersistence.getByRequestId('req-001');
    expect(intent!.state).toBe(IntentState.FAILED);
    expect(intent!.workingDir).toBeTruthy();
    expect(intent!.preSnapshotPayload).toBeTruthy();
  });

  it('pack() throws NotImplementedError when packagingDeps absent', async () => {
    const optsNoPackaging: RestorationEngineOptions = {
      store,
      paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
    };
    const eng = new TestEngine(optsNoPackaging);
    await eng.observe(makeInput('req-002', tmp));
    const p = eng.testPersistence;
    p.transition('req-002', IntentState.CLAIMED);
    p.transition('req-002', IntentState.WAITING);
    p.transition('req-002', IntentState.PRE_SNAPSHOT);
    p.transition('req-002', IntentState.RUNNING);
    p.transition('req-002', IntentState.POST_SNAPSHOT);
    p.transition('req-002', IntentState.PACKAGING);
    await expect(eng.process('req-002')).rejects.toThrow(NotImplementedError);
  });

  it('pack() succeeds with packagingDeps + envelopeDeps and advances to DELIVERING', async () => {
    // Provision working dir manually so pack() has something to walk
    const requestId = 'req-003';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"hi"}');
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');

    await engine.observe(makeInput(requestId, tmp));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { equity: '1000', capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { equity: '1100', capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: { equityReturnPct: '10', maxDrawdownPct: '5', closedTradesCount: 25, tradedNotionalMultiple: '8' },
    });
    p.transition(requestId, IntentState.PACKAGING);

    // Process PACKAGING — should succeed and advance to DELIVERING
    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    await engine.process(requestId);
    const intent = engine.testPersistence.getByRequestId(requestId);
    expect(intent!.state).toBe(IntentState.DELIVERING);
    expect(intent!.manifestCid).toBe('bafymock123');

    // Assert participant provenance: safeAddress must be the Safe multisig,
    // agentEoa must be derived from the private key — they MUST differ.
    const uploadCalls = (uploadToIpfs as ReturnType<typeof vi.fn>).mock.calls;
    const envelopeCall = uploadCalls.find(
      ([, payload]: [string, Record<string, unknown>]) =>
        typeof payload === 'object' && payload !== null && 'participant' in payload,
    );
    expect(envelopeCall).toBeDefined();
    const envelope = envelopeCall![1] as Record<string, unknown>;
    const participant = envelope.participant as Record<string, unknown>;
    expect(participant.safeAddress).toBe('0xsafe');
    expect(participant.agentEoa).not.toBe('0xsafe');
    expect(participant.safeAddress).not.toBe(participant.agentEoa);
  });

  it('deliver() throws NotImplementedError when deliveryDeps absent', async () => {
    const optsNoDelivery: RestorationEngineOptions = {
      store,
      paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
    };
    const eng = new TestEngine(optsNoDelivery);
    await eng.observe(makeInput('req-004', tmp));
    const p = eng.testPersistence;
    p.transition('req-004', IntentState.CLAIMED);
    p.transition('req-004', IntentState.WAITING);
    p.transition('req-004', IntentState.PRE_SNAPSHOT);
    p.transition('req-004', IntentState.RUNNING);
    p.transition('req-004', IntentState.POST_SNAPSHOT);
    p.transition('req-004', IntentState.PACKAGING);
    p.transition('req-004', IntentState.DELIVERING);
    await expect(eng.process('req-004')).rejects.toThrow(NotImplementedError);
  });

  it('deliver() succeeds with deliveryDeps and advances to COMPLETE', async () => {
    const requestId = 'req-005';
    await engine.observe(makeInput(requestId, tmp));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT);
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT);
    p.transition(requestId, IntentState.PACKAGING);
    p.transition(requestId, IntentState.DELIVERING, {
      manifestCid: 'bafymanifest123',
      // evidenceHash required for v2 claimDelivery (fix #3: zero fallback removed)
      evidenceHash: '0xaabbccdd00000000000000000000000000000000000000000000000000000000',
    });

    await engine.process(requestId);
    const intent = engine.testPersistence.getByRequestId(requestId);
    expect(intent!.state).toBe(IntentState.COMPLETE);
    expect(intent!.deliveryTxHash).toBe('0xdeliverytx');
  });

  it('pack() throws when safeAddress is not configured', async () => {
    // Engine with envelopeDeps missing safeAddress and no deliveryDeps
    const optsNoSafe: RestorationEngineOptions = {
      store,
      paths: {
        workingDirRoot: join(tmp, 'restorations'),
        implStateDirRoot: join(tmp, 'impls'),
      },
      packagingDeps: {
        store,
        operatorEndpoint: 'https://op.test',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
      },
      envelopeDeps: {
        ipfsRegistryUrl: 'http://ipfs.test',
        agentEoaPrivateKey: TEST_PRIVATE_KEY,
        // safeAddress intentionally absent
      },
      // deliveryDeps intentionally absent
    };
    const eng = new TestEngine(optsNoSafe);
    const requestId = 'req-nosafe';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');

    await eng.observe(makeInput(requestId, tmp));
    const p = eng.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: {},
    });
    p.transition(requestId, IntentState.PACKAGING);

    await expect(eng.process(requestId)).rejects.toThrow(
      'pack: safeAddress not configured in envelopeDeps or deliveryDeps',
    );
  });

  it('pack() persists evidenceHash in its own column and deliver() reads it', async () => {
    const requestId = 'req-evhash';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');

    await engine.observe(makeInput(requestId, tmp));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: { equityReturnPct: '10', maxDrawdownPct: '5', closedTradesCount: 25, tradedNotionalMultiple: '8' },
    });
    p.transition(requestId, IntentState.PACKAGING);

    await engine.process(requestId);
    const afterPack = engine.testPersistence.getByRequestId(requestId)!;
    expect(afterPack.state).toBe(IntentState.DELIVERING);

    // evidenceHash must be in its own column (not in informationalClaim)
    expect(afterPack.evidenceHash).toBeTruthy();
    expect(afterPack.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    // informationalClaim must NOT contain _evidenceHash key
    const info = afterPack.informationalClaim as Record<string, unknown> | null;
    expect(info?._evidenceHash).toBeUndefined();
  });

  it('pack() is idempotent: re-running produces same manifest CID (generatedAt preserved)', async () => {
    // Simulates a crash after pack() completes but before state is consumed.
    // Re-running pack() must produce the same manifest CID.
    const requestId = 'req-idempotent';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');
    writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"stable"}');

    await engine.observe(makeInput(requestId, tmp));
    const p = engine.testPersistence;
    const baseTransitions = () => {
      p.transition(requestId, IntentState.CLAIMED);
      p.transition(requestId, IntentState.WAITING);
      p.transition(requestId, IntentState.PRE_SNAPSHOT, {
        workingDir,
        implStateDir: join(tmp, 'impls', 'test'),
        preSnapshotCapturedAt: 1000,
        preSnapshotPayload: { capturedAt: 1000, hlTime: 0 },
      });
      p.transition(requestId, IntentState.RUNNING);
      p.transition(requestId, IntentState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: 2000,
        postSnapshotPayload: { capturedAt: 2000, hlTime: 0 },
        fillsPayload: [],
        gatingClaim: { equityReturnPct: '5', maxDrawdownPct: '2', closedTradesCount: 10, tradedNotionalMultiple: '3' },
      });
      p.transition(requestId, IntentState.PACKAGING);
    };
    baseTransitions();

    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const uploadMock = uploadToIpfs as ReturnType<typeof vi.fn>;

    // Clear prior call records so this test counts from zero
    uploadMock.mockClear();

    // Track what manifests are uploaded
    const manifestCids: string[] = [];
    uploadMock.mockImplementation(async (_url: string, payload: unknown) => {
      if (typeof payload === 'object' && payload !== null && 'schemaVersion' in payload) {
        const cid = `bafymock-manifest-${manifestCids.length}`;
        manifestCids.push(cid);
        return cid;
      }
      return 'bafymock123';
    });

    // First pack run
    await engine.process(requestId);
    const afterFirst = engine.testPersistence.getByRequestId(requestId)!;
    expect(afterFirst.state).toBe(IntentState.DELIVERING);
    const generatedAtFirst = afterFirst.manifestGeneratedAt;
    expect(generatedAtFirst).toBeTruthy();

    // Simulate PACKAGING retry: reset state back to PACKAGING
    // (use raw DB because transition() would reject DELIVERING → PACKAGING)
    store.db.prepare(
      "UPDATE restoration_intents SET state = 'PACKAGING', manifest_cid = NULL, evidence_hash = NULL, delivery_tx_hash = NULL WHERE request_id = ?",
    ).run(requestId);

    // Re-run with same engine (generatedAt is preserved in DB)
    await engine.process(requestId);
    const afterSecond = engine.testPersistence.getByRequestId(requestId)!;
    expect(afterSecond.state).toBe(IntentState.DELIVERING);

    // generatedAt must be identical across both runs
    expect(afterSecond.manifestGeneratedAt).toBe(generatedAtFirst);

    // Both manifest uploads should have had the same generatedAt in the payload
    const manifestUploads = uploadMock.mock.calls.filter(
      ([, payload]: [string, unknown]) =>
        typeof payload === 'object' && payload !== null && 'schemaVersion' in (payload as Record<string, unknown>),
    );
    expect(manifestUploads).toHaveLength(2);
    const gen1 = (manifestUploads[0]![1] as Record<string, unknown>)['generatedAt'];
    const gen2 = (manifestUploads[1]![1] as Record<string, unknown>)['generatedAt'];
    expect(gen1).toBe(gen2);
  });

  // ── Verdict envelope (evaluation intent) ─────────────────────────────────────

  it('pack() emits role=verdict envelope for intentType=evaluation with verdictPayload', async () => {
    // An evaluation intent must produce a 'verdict' envelope, not 'restoration'.
    // The verdictPayload on implOutputsJson is passed through as the envelope payload
    // and validated against PortfolioV0VerdictPayloadSchema.
    const requestId = 'req-eval-001';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');
    // verdict.json must exist so walkArtifacts picks it up (evaluator impl writes it)
    writeFileSync(join(workingDir, 'verdict.json'), JSON.stringify({ verdict: 'PASS' }));

    // Build a minimal valid PortfolioV0VerdictPayload
    const verdictPayload = {
      restorationEnvelope: { cid: 'bafy-rest', sha256: '0'.repeat(64) },
      verificationOfRestoration: {
        claimedTier: 'self-signed',
        sdkVersion: '0.0.0-stub',
        timestamp: Date.now(),
        checks: [{ name: 'stub', passed: true }],
        overall: 'valid',
      },
      verdict: 'PASS',
      score: '0.5',
      scoreBasis: 'calmar.v1',
      scoreVersion: 'v1',
      rederived: {
        preSnapshot: { capturedAt: 1000, payload: {} },
        postSnapshot: { capturedAt: 2000, payload: {} },
        fills: [],
        gating: {},
      },
      claimed: {
        preSnapshot: { capturedAt: 1000, payload: {} },
        postSnapshot: { capturedAt: 2000, payload: {} },
        fillsHash: '0xff',
        fillsCount: 0,
        gating: {},
      },
      checks: [{ name: 'availability.x', status: 'PASS' }],
    };

    const implOutput = {
      venueRef: { name: 'hyperliquid' },
      gating: { verdict: 'PASS', score: '0.5' },
      verdictPayload,
      artifacts: [{ path: 'verdict.json', artifactType: 'evaluation_verdict', tags: ['verdict'], access: { priceUsdc: '0' } }],
    };

    await engine.observe({
      requestId,
      intentCid: 'bafyintent123',
      onchainCreationTx: '0xdeadbeef',
      onchainCreationBlock: 100,
      specKind: 'portfolio.v0',
      intentType: 'evaluation',
      windowStartTs: Date.now() - 1000,
      windowEndTs: Date.now() + 86_400_000,
      restorationJob: { id: requestId, description: 'test', type: 'evaluation' },
    });
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'portfolio-v0-evaluator'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: { verdict: 'PASS', score: '0.5' },
      implOutputsJson: JSON.stringify(implOutput),
    });
    p.transition(requestId, IntentState.PACKAGING);

    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const uploadMock = uploadToIpfs as ReturnType<typeof vi.fn>;
    // Reset mock to default implementation (the idempotency test may have patched it)
    uploadMock.mockResolvedValue('bafymock123');
    uploadMock.mockClear();

    await engine.process(requestId);

    const intent = engine.testPersistence.getByRequestId(requestId)!;
    expect(intent.state).toBe(IntentState.DELIVERING);
    expect(intent.manifestCid).toBe('bafymock123');

    // Find the uploaded envelope (has schemaVersion='jinn.execution.v1')
    const envelopeCall = uploadMock.mock.calls.find(
      ([, payload]: [string, unknown]) =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as Record<string, unknown>)['schemaVersion'] === 'jinn.execution.v1',
    );
    expect(envelopeCall).toBeDefined();
    const envelope = envelopeCall![1] as Record<string, unknown>;

    // role MUST be 'verdict'
    expect(envelope['role']).toBe('verdict');

    // payload must contain the verdict fields (not restoration snapshot fields)
    const payload = envelope['payload'] as Record<string, unknown>;
    expect(payload['verdict']).toBe('PASS');
    expect(payload['restorationEnvelope']).toBeDefined();
    expect(payload['verificationOfRestoration']).toBeDefined();
    expect(payload['rederived']).toBeDefined();
    expect(payload['claimed']).toBeDefined();
    expect(payload['checks']).toBeDefined();
    // Must NOT have restoration-specific fields
    expect(payload['preSnapshot']).toBeUndefined();
    expect(payload['postSnapshot']).toBeUndefined();
    expect(payload['fills']).toBeUndefined();
  });

  it('pack() throws when evaluation intent has no verdictPayload on implOutput', async () => {
    // Guard: if an evaluator impl forgot to set verdictPayload, pack() should throw
    // rather than silently assembling a malformed restoration-role envelope.
    const requestId = 'req-eval-no-vp';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');

    // implOutput with no verdictPayload field
    const implOutput = {
      venueRef: { name: 'hyperliquid' },
      gating: { verdict: 'PASS', score: '0.5' },
      // verdictPayload intentionally absent
      artifacts: [],
    };

    await engine.observe({
      requestId,
      intentCid: 'bafyintent123',
      onchainCreationTx: '0xdeadbeef',
      onchainCreationBlock: 100,
      specKind: 'portfolio.v0',
      intentType: 'evaluation',
      windowStartTs: Date.now() - 1000,
      windowEndTs: Date.now() + 86_400_000,
      restorationJob: { id: requestId, description: 'test', type: 'evaluation' },
    });
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'portfolio-v0-evaluator'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: { verdict: 'PASS' },
      implOutputsJson: JSON.stringify(implOutput),
    });
    p.transition(requestId, IntentState.PACKAGING);

    await expect(engine.process(requestId)).rejects.toThrow(
      /evaluator impl.*did not produce verdictPayload/,
    );
  });
});

// ── Task 16: trajectory↔artifact bidirectional linkage ────────────────────────

import { TrajectoryCollector } from '../../../src/trajectory/collector.js';

class TrajectoryTestEngine extends RestorationEngine {
  get testPersistence(): IntentPersistence {
    return this.persistence;
  }

  /** Inject a pre-built TrajectoryCollector for a given requestId (test helper). */
  injectCollector(requestId: string, collector: TrajectoryCollector): void {
    this.trajectoryCollectors.set(requestId, collector);
  }
}

describe('Engine pack() — trajectory↔artifact bidirectional linkage', () => {
  let store: Store;
  let tmp: string;
  let engine: TrajectoryTestEngine;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    engine = new TrajectoryTestEngine(makeOpts(store, tmp));
  });

  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('backfills trajectoryCid on artifact producedBy after emitTrajectory', async () => {
    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const uploadMock = uploadToIpfs as ReturnType<typeof vi.fn>;
    uploadMock.mockClear();

    // Return a distinct CID for the trajectory upload vs artifact uploads
    let callIndex = 0;
    uploadMock.mockImplementation(async (_url: string, payload: unknown) => {
      callIndex++;
      // The trajectory upload sends an object with a 'trajectory' field (signed blob)
      // but more reliably: it has a 'signature' field (from signCanonical in emit.ts).
      // Artifact uploads send { artifactType, sha256, data }.
      // Envelope uploads send { schemaVersion: 'jinn.execution.v1', ... }.
      if (typeof payload === 'object' && payload !== null && 'signature' in (payload as Record<string, unknown>)) {
        return 'bafy-trajectory-cid';
      }
      return `bafy-artifact-${callIndex}`;
    });

    const requestId = 'req-traj-link';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');
    writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"hi"}');

    await engine.observe(makeInput(requestId, tmp));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: { equityReturnPct: '10', maxDrawdownPct: '5', closedTradesCount: 25, tradedNotionalMultiple: '8' },
    });
    p.transition(requestId, IntentState.PACKAGING);

    // Inject a trajectory collector (simulates what runImpl would have set up)
    const collector = new TrajectoryCollector({ intentCid: 'bafyintent123', runId: 'run-test-1' });
    // Add a pre-existing span (simulates impl activity)
    collector.addSpan({
      name: 'phase.run',
      kind: 'INTERNAL',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2000000000',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'run' },
      events: [],
      status: { code: 'OK' },
    });
    engine.injectCollector(requestId, collector);

    // Run pack()
    await engine.process(requestId);

    // Verify state advanced to DELIVERING
    const intent = engine.testPersistence.getByRequestId(requestId);
    expect(intent!.state).toBe(IntentState.DELIVERING);

    // Verify the envelope's artifacts have producedBy.trajectoryCid populated
    const envelopeCall = uploadMock.mock.calls.find(
      ([, payload]: [string, unknown]) =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as Record<string, unknown>)['schemaVersion'] === 'jinn.execution.v1',
    );
    expect(envelopeCall).toBeDefined();

    const envelope = envelopeCall![1] as Record<string, unknown>;
    const envelopeArtifacts = envelope['artifacts'] as Array<Record<string, unknown>>;
    expect(Array.isArray(envelopeArtifacts)).toBe(true);

    // At least some artifacts should have producedBy set with a non-empty trajectoryCid
    const artifactsWithProducedBy = envelopeArtifacts.filter((a) => {
      const meta = a['metadata'] as Record<string, unknown> | undefined;
      return meta?.['producedBy'] != null;
    });
    expect(artifactsWithProducedBy.length).toBeGreaterThan(0);

    // Every producedBy.trajectoryCid must be the trajectory CID (non-empty)
    for (const art of artifactsWithProducedBy) {
      const meta = art['metadata'] as Record<string, unknown>;
      const pb = meta['producedBy'] as Record<string, unknown>;
      expect(typeof pb['trajectoryCid']).toBe('string');
      expect(pb['trajectoryCid']).not.toBe('');
      // The trajectoryCid must be the value returned by the trajectory upload
      expect(pb['trajectoryCid']).toBe('bafy-trajectory-cid');
    }
  });

  it('pack() works without a collector — no producedBy on artifacts', async () => {
    const { uploadToIpfs } = await import('../../../src/adapters/mech/ipfs.js');
    const uploadMock = uploadToIpfs as ReturnType<typeof vi.fn>;
    uploadMock.mockResolvedValue('bafymock123');
    uploadMock.mockClear();

    const requestId = 'req-no-collector';
    const workingDir = join(tmp, 'restorations', requestId);
    mkdirSync(join(workingDir, 'sessions'), { recursive: true });
    mkdirSync(join(workingDir, 'env'), { recursive: true });
    writeFileSync(join(workingDir, 'intent.json'), '{}');

    await engine.observe(makeInput(requestId, tmp));
    const p = engine.testPersistence;
    p.transition(requestId, IntentState.CLAIMED);
    p.transition(requestId, IntentState.WAITING);
    p.transition(requestId, IntentState.PRE_SNAPSHOT, {
      workingDir,
      implStateDir: join(tmp, 'impls', 'test'),
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
    });
    p.transition(requestId, IntentState.RUNNING);
    p.transition(requestId, IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0 },
      fillsPayload: [],
      gatingClaim: { equityReturnPct: '5', maxDrawdownPct: '2', closedTradesCount: 10, tradedNotionalMultiple: '3' },
    });
    p.transition(requestId, IntentState.PACKAGING);

    // No collector injected — emitTrajectory should not be called
    await engine.process(requestId);
    const intent = engine.testPersistence.getByRequestId(requestId);
    expect(intent!.state).toBe(IntentState.DELIVERING);

    // Envelope's trajectory field should be null (no collector → no trajectory)
    const envelopeCall = uploadMock.mock.calls.find(
      ([, payload]: [string, unknown]) =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as Record<string, unknown>)['schemaVersion'] === 'jinn.execution.v1',
    );
    expect(envelopeCall).toBeDefined();
    const envelope = envelopeCall![1] as Record<string, unknown>;
    expect(envelope['trajectory']).toBeNull();
  });
});
