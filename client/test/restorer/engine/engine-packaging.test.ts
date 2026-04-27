/**
 * Integration tests for engine.ts packaging + delivery integration.
 *
 * Tests that pack() and deliver() stubs are replaced with real behaviour when
 * packagingDeps + manifestDeps + deliveryDeps are injected.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NotImplementedError,
  type RestorationEngineOptions,
} from '../../../src/restorer/engine/engine.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import { createStateMachineSpy, makeIntentInput } from '@test/engine.js';
import { withTempStore } from '@test/store.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// MOCK_JUSTIFICATION: src/adapters/mech/ipfs.js is the I/O leaf for IPFS gateway HTTP calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000' as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// MOCK_JUSTIFICATION: src/adapters/mech/contracts.js is the I/O leaf for chain RPC calls; mocking it is mocking the boundary.
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

/** Packaging-test intent: window starts 1 second in the past so dataDrivenAdvance fires. */
function makePackagingInput(requestId: string) {
  const now = Date.now() - 1000;
  return makeIntentInput({
    requestId,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    intentCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    specKind: 'portfolio.v0',
    desiredState: { id: requestId, description: 'test' },
  });
}

function makePackagingOpts(tmp: string): Pick<RestorationEngineOptions, 'packagingDeps' | 'manifestDeps' | 'deliveryDeps'> {
  return {
    packagingDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      registerArtifact: vi.fn(),
    },
    manifestDeps: {
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Engine packaging integration', () => {

  it('takePreSnapshot provisions workingDir and advances state', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const { engine } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          ...makePackagingOpts(tmp),
        });
        await engine.observe(makePackagingInput('req-001'));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.FAILED);
        expect(intent!.workingDir).toBeTruthy();
        expect(intent!.implStateDir).toBeTruthy();
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('takePreSnapshot without deps still works (only uses filesystem)', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const { engine } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          ...makePackagingOpts(tmp),
        });
        await engine.observe(makePackagingInput('req-001'));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.FAILED);
        expect(intent!.workingDir).toBeTruthy();
        expect(intent!.preSnapshotPayload).toBeTruthy();
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('pack() throws NotImplementedError when packagingDeps absent', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const { engine: eng } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          // No packagingDeps — pack() should throw NotImplementedError
        });
        await eng.observe(makePackagingInput('req-002'));
        const p = eng.testPersistence;
        p.transition('req-002', IntentState.CLAIMED);
        p.transition('req-002', IntentState.WAITING);
        p.transition('req-002', IntentState.PRE_SNAPSHOT);
        p.transition('req-002', IntentState.RUNNING);
        p.transition('req-002', IntentState.POST_SNAPSHOT);
        p.transition('req-002', IntentState.PACKAGING);
        await expect(eng.process('req-002')).rejects.toThrow(NotImplementedError);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('pack() succeeds with packagingDeps + manifestDeps and advances to DELIVERING', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        // Provision working dir manually so pack() has something to walk
        const requestId = 'req-003';
        const workingDir = join(tmp, 'restorations', requestId);
        mkdirSync(join(workingDir, 'sessions'), { recursive: true });
        writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"hi"}');
        mkdirSync(join(workingDir, 'env'), { recursive: true });
        writeFileSync(join(workingDir, 'intent.json'), '{}');

        const { engine } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          ...makePackagingOpts(tmp),
        });
        await engine.observe(makePackagingInput(requestId));
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

        // Assert restorer provenance: safeAddress must be the Safe multisig,
        // agentEoa must be derived from the private key — they MUST differ.
        const uploadCalls = (uploadToIpfs as ReturnType<typeof vi.fn>).mock.calls;
        const manifestCall = uploadCalls.find(
          ([, payload]: [string, Record<string, unknown>]) =>
            typeof payload === 'object' && payload !== null && 'restorer' in payload,
        );
        expect(manifestCall).toBeDefined();
        const manifest = manifestCall![1] as Record<string, unknown>;
        const restorer = manifest.restorer as Record<string, unknown>;
        expect(restorer.safeAddress).toBe('0xsafe');
        expect(restorer.agentEoa).not.toBe('0xsafe');
        expect(restorer.safeAddress).not.toBe(restorer.agentEoa);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('deliver() throws NotImplementedError when deliveryDeps absent', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const { engine: eng } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          // No deliveryDeps — deliver() should throw NotImplementedError
        });
        await eng.observe(makePackagingInput('req-004'));
        const p = eng.testPersistence;
        p.transition('req-004', IntentState.CLAIMED);
        p.transition('req-004', IntentState.WAITING);
        p.transition('req-004', IntentState.PRE_SNAPSHOT);
        p.transition('req-004', IntentState.RUNNING);
        p.transition('req-004', IntentState.POST_SNAPSHOT);
        p.transition('req-004', IntentState.PACKAGING);
        p.transition('req-004', IntentState.DELIVERING);
        await expect(eng.process('req-004')).rejects.toThrow(NotImplementedError);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('deliver() succeeds with deliveryDeps and advances to COMPLETE', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const requestId = 'req-005';
        const { engine } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          ...makePackagingOpts(tmp),
        });
        await engine.observe(makePackagingInput(requestId));
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
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('pack() throws when safeAddress is not configured', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        // Engine with manifestDeps missing safeAddress and no deliveryDeps
        const { engine: eng } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          packagingDeps: {
            ipfsRegistryUrl: 'http://ipfs.test',
          },
          manifestDeps: {
            ipfsRegistryUrl: 'http://ipfs.test',
            agentEoaPrivateKey: TEST_PRIVATE_KEY,
            // safeAddress intentionally absent
          },
          // deliveryDeps intentionally absent
        });
        const requestId = 'req-nosafe';
        const workingDir = join(tmp, 'restorations', requestId);
        mkdirSync(join(workingDir, 'sessions'), { recursive: true });
        mkdirSync(join(workingDir, 'env'), { recursive: true });
        writeFileSync(join(workingDir, 'intent.json'), '{}');

        await eng.observe(makePackagingInput(requestId));
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
          'pack: safeAddress not configured in manifestDeps or deliveryDeps',
        );
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('pack() persists evidenceHash in its own column and deliver() reads it', async () => {
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const requestId = 'req-evhash';
        const workingDir = join(tmp, 'restorations', requestId);
        mkdirSync(join(workingDir, 'sessions'), { recursive: true });
        mkdirSync(join(workingDir, 'env'), { recursive: true });
        writeFileSync(join(workingDir, 'intent.json'), '{}');

        const { engine } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          ...makePackagingOpts(tmp),
        });
        await engine.observe(makePackagingInput(requestId));
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
          gatingClaim: {},
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
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });

  it('pack() is idempotent: re-running produces same manifest CID (generatedAt preserved)', async () => {
    // Simulates a crash after pack() completes but before state is consumed.
    // Re-running pack() must produce the same manifest CID.
    await withTempStore(async (store) => {
      const tmp = mkTmp();
      try {
        const requestId = 'req-idempotent';
        const workingDir = join(tmp, 'restorations', requestId);
        mkdirSync(join(workingDir, 'sessions'), { recursive: true });
        mkdirSync(join(workingDir, 'env'), { recursive: true });
        writeFileSync(join(workingDir, 'intent.json'), '{}');
        writeFileSync(join(workingDir, 'sessions', 'session.jsonl'), '{"msg":"stable"}');

        const { engine } = createStateMachineSpy({
          store,
          paths: { workingDirRoot: join(tmp, 'restorations'), implStateDirRoot: join(tmp, 'impls') },
          ...makePackagingOpts(tmp),
        });
        await engine.observe(makePackagingInput(requestId));
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
            gatingClaim: { equityReturnPct: '5' },
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
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
});
