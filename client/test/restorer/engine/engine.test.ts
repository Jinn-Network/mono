import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  NotImplementedError,
  type RestorationEngineOptions,
  type RestorerImplRegistry,
  type RecoveryReport,
} from '../../../src/restorer/engine/engine.js';
import { IntentPersistence, type PersistedIntent, type PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { ClaimRegistryClient } from '../../../src/adapters/claim-registry/client.js';
import type { MarketplaceClaimer } from '../../../src/restorer/engine/claim.js';

// ── Test doubles ──────────────────────────────────────────────────────────────

const noopRegistry: RestorerImplRegistry = {
  resolveImplName: () => null,
};

function makeOpts(store: Store): RestorationEngineOptions {
  return {
    store,
    registry: noopRegistry,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  };
}

function makeInput(overrides: Partial<PersistedIntentInput> = {}): PersistedIntentInput {
  const now = Date.now();
  return {
    requestId: 'req-001',
    intentCid: 'bafyabc123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1000,
    specKind: 'portfolio.v0',
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    desiredState: { id: 'req-001', description: 'test' },
    ...overrides,
  };
}

/** Subclass that exposes overrideable stubs and records which transitions were called. */
class TestEngine extends RestorationEngine {
  calls: string[] = [];
  claimFn?: (intent: PersistedIntent) => Promise<void>;
  preSnapshotFn?: (intent: PersistedIntent) => Promise<void>;
  runImplFn?: (intent: PersistedIntent) => Promise<void>;
  postSnapshotFn?: (intent: PersistedIntent) => Promise<void>;
  packFn?: (intent: PersistedIntent) => Promise<void>;
  deliverFn?: (intent: PersistedIntent) => Promise<void>;

  override async claim(intent: PersistedIntent): Promise<void> {
    this.calls.push('claim');
    if (this.claimFn) return this.claimFn(intent);
    // If claimDeps is injected, delegate to the real implementation.
    if (this.claimDeps) return super.claim(intent);
    throw new NotImplementedError('claim');
  }
  override async takePreSnapshot(intent: PersistedIntent): Promise<void> {
    this.calls.push('takePreSnapshot');
    if (this.preSnapshotFn) return this.preSnapshotFn(intent);
    throw new NotImplementedError('takePreSnapshot');
  }
  override async runImpl(intent: PersistedIntent): Promise<void> {
    this.calls.push('runImpl');
    if (this.runImplFn) return this.runImplFn(intent);
    throw new NotImplementedError('runImpl');
  }
  override async takePostSnapshot(intent: PersistedIntent): Promise<void> {
    this.calls.push('takePostSnapshot');
    if (this.postSnapshotFn) return this.postSnapshotFn(intent);
    throw new NotImplementedError('takePostSnapshot');
  }
  override async pack(intent: PersistedIntent): Promise<void> {
    this.calls.push('pack');
    if (this.packFn) return this.packFn(intent);
    throw new NotImplementedError('pack');
  }
  override async deliver(intent: PersistedIntent): Promise<void> {
    this.calls.push('deliver');
    if (this.deliverFn) return this.deliverFn(intent);
    throw new NotImplementedError('deliver');
  }

  // Expose persistence for test assertions
  get testPersistence(): IntentPersistence {
    return this.persistence;
  }

  // Expose private dataDrivenAdvance for unit testing
  testDataDrivenAdvance(intent: PersistedIntent): IntentState | null {
    // Access via index to bypass TypeScript's private modifier
    return (this as unknown as { dataDrivenAdvance(i: PersistedIntent): IntentState | null }).dataDrivenAdvance(intent);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RestorationEngine', () => {
  let store: Store;
  let engine: TestEngine;

  beforeEach(() => {
    store = new Store(':memory:');
    engine = new TestEngine(makeOpts(store));
  });

  afterEach(() => {
    store.close();
  });

  describe('observe', () => {
    it('inserts a DISCOVERED row', async () => {
      await engine.observe(makeInput());
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.DISCOVERED);
    });

    it('is idempotent — observing twice is a no-op', async () => {
      await engine.observe(makeInput());
      await engine.observe(makeInput({ intentCid: 'different' }));
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.intentCid).toBe('bafyabc123'); // first wins
    });
  });

  describe('process — DISCOVERED state', () => {
    it('calls claim() when processing a DISCOVERED intent', async () => {
      await engine.observe(makeInput());
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('claim');
    });

    it('marks intent FAILED when claim() throws', async () => {
      await engine.observe(makeInput());
      await expect(engine.process('req-001')).rejects.toThrow();
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.FAILED);
      expect(intent!.failureReason).toContain('claim');
    });

    it('advances to CLAIMED when claim() succeeds', async () => {
      await engine.observe(makeInput());
      engine.claimFn = async () => {
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      };
      await engine.process('req-001');
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.CLAIMED);
    });
  });

  describe('process — CLAIMED state', () => {
    it('advances CLAIMED → WAITING without calling any stub', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      await engine.process('req-001');
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.WAITING);
      expect(engine.calls).toHaveLength(0);
    });
  });

  describe('process — WAITING state', () => {
    it('stays in WAITING when window has not started yet', async () => {
      const futureStart = Date.now() + 10_000_000;
      await engine.observe(makeInput({ windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      await engine.process('req-001');
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.WAITING);
      expect(engine.calls).toHaveLength(0);
    });

    it('advances to PRE_SNAPSHOT and calls takePreSnapshot when window has started', async () => {
      const pastStart = Date.now() - 1_000;
      await engine.observe(makeInput({ windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      // takePreSnapshot is a stub — will throw NotImplementedError
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('takePreSnapshot');
    });
  });

  describe('process — PRE_SNAPSHOT state', () => {
    it('calls takePreSnapshot when snapshot is absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('takePreSnapshot');
    });

    it('advances to RUNNING and calls runImpl when snapshot is already present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT, {
        preSnapshotCapturedAt: Date.now(),
        preSnapshotPayload: { equity: '1000' },
      });
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('runImpl');
    });
  });

  describe('process — RUNNING state', () => {
    it('calls runImpl', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('runImpl');
    });
  });

  describe('process — POST_SNAPSHOT state', () => {
    it('calls takePostSnapshot when post snapshot absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('takePostSnapshot');
    });

    it('advances to PACKAGING and calls pack when post snapshot present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: Date.now(),
        postSnapshotPayload: { equity: '1100' },
      });
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('pack');
    });
  });

  describe('process — PACKAGING state', () => {
    it('calls pack', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.PACKAGING);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('pack');
    });
  });

  describe('process — DELIVERING state', () => {
    it('calls deliver', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.PACKAGING);
      engine.testPersistence.transition('req-001', IntentState.DELIVERING);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('deliver');
    });
  });

  describe('process — COMPLETE / FAILED (terminal)', () => {
    it('is a no-op for COMPLETE', async () => {
      await engine.observe(makeInput());
      // Advance to COMPLETE manually
      const p = engine.testPersistence;
      p.transition('req-001', IntentState.CLAIMED);
      p.transition('req-001', IntentState.WAITING);
      p.transition('req-001', IntentState.PRE_SNAPSHOT);
      p.transition('req-001', IntentState.RUNNING);
      p.transition('req-001', IntentState.POST_SNAPSHOT);
      p.transition('req-001', IntentState.PACKAGING);
      p.transition('req-001', IntentState.DELIVERING);
      p.transition('req-001', IntentState.COMPLETE);
      await engine.process('req-001');
      expect(engine.calls).toHaveLength(0);
    });

    it('is a no-op for FAILED', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.markFailed('req-001', 'boom');
      await engine.process('req-001');
      expect(engine.calls).toHaveLength(0);
    });
  });

  describe('process — unknown requestId', () => {
    it('throws for a missing intent', async () => {
      await expect(engine.process('no-such-id')).rejects.toThrow(/not found/);
    });
  });

  describe('recoverInFlight', () => {
    it('dispatches each in-flight intent to the appropriate transition stub', async () => {
      const now = Date.now();
      // DISCOVERED
      await engine.observe(makeInput({ requestId: 'r-discovered' }));
      // CLAIMED
      await engine.observe(makeInput({ requestId: 'r-claimed' }));
      engine.testPersistence.transition('r-claimed', IntentState.CLAIMED);
      // RUNNING
      await engine.observe(makeInput({ requestId: 'r-running', windowStartTs: now - 1000, windowEndTs: now + 86_400_000 }));
      engine.testPersistence.transition('r-running', IntentState.CLAIMED);
      engine.testPersistence.transition('r-running', IntentState.WAITING);
      engine.testPersistence.transition('r-running', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('r-running', IntentState.RUNNING);
      // PACKAGING
      await engine.observe(makeInput({ requestId: 'r-packaging' }));
      engine.testPersistence.transition('r-packaging', IntentState.CLAIMED);
      engine.testPersistence.transition('r-packaging', IntentState.WAITING);
      engine.testPersistence.transition('r-packaging', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('r-packaging', IntentState.RUNNING);
      engine.testPersistence.transition('r-packaging', IntentState.POST_SNAPSHOT);
      engine.testPersistence.transition('r-packaging', IntentState.PACKAGING);

      // recoverInFlight should not throw (errors are caught per-intent)
      const reports = await engine.recoverInFlight();

      // claim called for DISCOVERED (stub throws, intent marked failed)
      expect(engine.calls).toContain('claim');
      // runImpl called for RUNNING
      expect(engine.calls).toContain('runImpl');
      // pack called for PACKAGING
      expect(engine.calls).toContain('pack');

      // Reports should be per-intent
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.every((r: RecoveryReport) => r.requestId && r.outcome)).toBe(true);
    });

    it('marks FAILED intents that throw during recovery', async () => {
      await engine.observe(makeInput({ requestId: 'r1' }));
      await engine.recoverInFlight();
      const intent = engine.testPersistence.getByRequestId('r1');
      // claim stub threw NotImplementedError → should be marked FAILED
      expect(intent!.state).toBe(IntentState.FAILED);
      expect(intent!.failureReason).toContain('NotImplemented');
    });

    it('CLAIMED → WAITING is driven without stub call', async () => {
      await engine.observe(makeInput({ requestId: 'r-claimed' }));
      engine.testPersistence.transition('r-claimed', IntentState.CLAIMED);
      // WAITING has future startTs, so recovery stops there without stub call
      const reports = await engine.recoverInFlight();
      const intent = engine.testPersistence.getByRequestId('r-claimed');
      expect(intent!.state).toBe(IntentState.WAITING);
      expect(engine.calls).toHaveLength(0);
      // The CLAIMED→WAITING advance is a success
      expect(reports[0]?.outcome).toBe('ok');
    });

    it('returns per-intent RecoveryReport with outcome field', async () => {
      await engine.observe(makeInput({ requestId: 'r-disc' }));
      const reports = await engine.recoverInFlight();
      expect(reports).toHaveLength(1);
      const r = reports[0] as RecoveryReport;
      expect(r.requestId).toBe('r-disc');
      expect(r.outcome).toBe('failed');
      expect(typeof r.error).toBe('string');
    });
  });

  describe('dataDrivenAdvance', () => {
    it('returns null for DISCOVERED state', async () => {
      await engine.observe(makeInput());
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns null for WAITING when window is in the future', async () => {
      const futureStart = Date.now() + 10_000_000;
      await engine.observe(makeInput({ windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns PRE_SNAPSHOT for WAITING when window has started', async () => {
      const pastStart = Date.now() - 1_000;
      await engine.observe(makeInput({ windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBe(IntentState.PRE_SNAPSHOT);
    });

    it('returns null for PRE_SNAPSHOT when payload is absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns RUNNING for PRE_SNAPSHOT when payload is present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT, {
        preSnapshotCapturedAt: Date.now(),
        preSnapshotPayload: { equity: '1000' },
      });
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBe(IntentState.RUNNING);
    });

    it('returns null for POST_SNAPSHOT when payload is absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns PACKAGING for POST_SNAPSHOT when payload is present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: Date.now(),
        postSnapshotPayload: { equity: '1100' },
      });
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBe(IntentState.PACKAGING);
    });

    it('returns null for RUNNING state (no data-driven advance)', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', IntentState.CLAIMED);
      engine.testPersistence.transition('req-001', IntentState.WAITING);
      engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', IntentState.RUNNING);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });
  });

  describe('NotImplementedError', () => {
    it('has the right name and transitionName', () => {
      const err = new NotImplementedError('claim');
      expect(err.name).toBe('NotImplementedError');
      expect(err.transitionName).toBe('claim');
      expect(err.message).toContain('claim');
    });

    it('is an instance of Error', () => {
      expect(new NotImplementedError('foo')).toBeInstanceOf(Error);
    });
  });

  // ── claim() integration ───────────────────────────────────────────────────

  describe('claim() with injected claimDeps', () => {
    /** Builds a mock ClaimRegistryClient. */
    function makeRegistryClient(opts: {
      weAlreadyClaimed?: boolean;
      claimResult?: { txHash: string; claimed: boolean };
      releaseResult?: boolean;
    } = {}): ClaimRegistryClient {
      return {
        weAlreadyClaimed: vi.fn().mockResolvedValue(opts.weAlreadyClaimed ?? false),
        claimJob: vi.fn().mockResolvedValue(
          opts.claimResult ?? { txHash: '0xabc', claimed: true }
        ),
        releaseClaim: vi.fn().mockResolvedValue(opts.releaseResult ?? true),
        getJobClaim: vi.fn().mockResolvedValue({ claimer: '0x0', expiresAt: 0n, isActive: false }),
        expireClaim: vi.fn().mockResolvedValue(true),
      } as unknown as ClaimRegistryClient;
    }

    function makeMarketplaceClaimer(failWith?: Error): MarketplaceClaimer {
      if (failWith) {
        return { claimRequest: vi.fn().mockRejectedValue(failWith) };
      }
      return { claimRequest: vi.fn().mockResolvedValue(undefined) };
    }

    it('advances DISCOVERED → CLAIMED when both layers succeed', async () => {
      const registryClient = makeRegistryClient();
      const marketplace = makeMarketplaceClaimer();
      const opts: RestorationEngineOptions = {
        ...makeOpts(store),
        claimDeps: { registryClient, marketplaceClaimer: marketplace },
      };
      const eng = new TestEngine(opts);

      await eng.observe(makeInput());
      await eng.process('req-001');

      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.CLAIMED);
      expect(registryClient.claimJob).toHaveBeenCalledOnce();
      expect(marketplace.claimRequest).toHaveBeenCalledOnce();
    });

    it('marks FAILED when ClaimRegistry claim fails', async () => {
      const registryClient = makeRegistryClient({
        claimResult: { txHash: '', claimed: false },
      });
      const marketplace = makeMarketplaceClaimer();
      const opts: RestorationEngineOptions = {
        ...makeOpts(store),
        claimDeps: { registryClient, marketplaceClaimer: marketplace },
      };
      const eng = new TestEngine(opts);

      await eng.observe(makeInput());
      await expect(eng.process('req-001')).rejects.toThrow(/ClaimRegistry claim failed/);

      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.FAILED);
      expect(marketplace.claimRequest).not.toHaveBeenCalled();
    });

    it('marks FAILED when marketplace claim fails', async () => {
      const registryClient = makeRegistryClient();
      const marketplace = makeMarketplaceClaimer(new Error('Claim policy rejected'));
      const opts: RestorationEngineOptions = {
        ...makeOpts(store),
        claimDeps: { registryClient, marketplaceClaimer: marketplace },
      };
      const eng = new TestEngine(opts);

      await eng.observe(makeInput());
      await expect(eng.process('req-001')).rejects.toThrow('Claim policy rejected');

      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.FAILED);
      // ClaimRegistry claim should have been released
      expect(registryClient.releaseClaim).toHaveBeenCalledOnce();
    });

    it('is idempotent on resume: skips claimJob when weAlreadyClaimed=true', async () => {
      const registryClient = makeRegistryClient({ weAlreadyClaimed: true });
      const marketplace = makeMarketplaceClaimer();
      const opts: RestorationEngineOptions = {
        ...makeOpts(store),
        claimDeps: { registryClient, marketplaceClaimer: marketplace },
      };
      const eng = new TestEngine(opts);

      await eng.observe(makeInput());
      await eng.process('req-001');

      expect(registryClient.claimJob).not.toHaveBeenCalled();
      expect(marketplace.claimRequest).toHaveBeenCalledOnce();
      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(IntentState.CLAIMED);
    });

    it('falls back to NotImplementedError when claimDeps is absent', async () => {
      // Engine without claimDeps — original stub behaviour
      const eng = new TestEngine(makeOpts(store));
      await eng.observe(makeInput());
      await expect(eng.process('req-001')).rejects.toThrow(NotImplementedError);
    });
  });

  // ── releaseClaimedNotStarted ──────────────────────────────────────────────

  describe('releaseClaimedNotStarted()', () => {
    function makeRegistryClient(releaseResult = true): ClaimRegistryClient {
      return {
        weAlreadyClaimed: vi.fn().mockResolvedValue(true),
        claimJob: vi.fn().mockResolvedValue({ txHash: '0xabc', claimed: true }),
        releaseClaim: vi.fn().mockResolvedValue(releaseResult),
        getJobClaim: vi.fn().mockResolvedValue({
          claimer: '0xaaaa',
          expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
          isActive: true,
        }),
        expireClaim: vi.fn().mockResolvedValue(true),
      } as unknown as ClaimRegistryClient;
    }

    it('releases CLAIMED intents whose window has not started', async () => {
      const registryClient = makeRegistryClient();
      const opts: RestorationEngineOptions = {
        ...makeOpts(store),
        claimDeps: {
          registryClient,
          marketplaceClaimer: { claimRequest: vi.fn().mockResolvedValue(undefined) },
        },
      };
      const eng = new TestEngine(opts);

      // Insert a CLAIMED intent with future windowStartTs
      const futureStart = Date.now() + 60_000;
      await eng.observe(makeInput({ windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
      eng.testPersistence.transition('req-001', IntentState.CLAIMED);

      const released = await eng.releaseClaimedNotStarted();
      expect(released).toContain('req-001');
      expect(registryClient.releaseClaim).toHaveBeenCalledOnce();
    });

    it('does not release CLAIMED intents whose window has already started', async () => {
      const registryClient = makeRegistryClient();
      const opts: RestorationEngineOptions = {
        ...makeOpts(store),
        claimDeps: {
          registryClient,
          marketplaceClaimer: { claimRequest: vi.fn().mockResolvedValue(undefined) },
        },
      };
      const eng = new TestEngine(opts);

      // Insert a CLAIMED intent with PAST windowStartTs (window started)
      const pastStart = Date.now() - 1_000;
      await eng.observe(makeInput({ windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
      eng.testPersistence.transition('req-001', IntentState.CLAIMED);

      const released = await eng.releaseClaimedNotStarted();
      expect(released).toHaveLength(0);
      expect(registryClient.releaseClaim).not.toHaveBeenCalled();
    });

    it('returns empty array when claimDeps is absent', async () => {
      const eng = new TestEngine(makeOpts(store));
      const released = await eng.releaseClaimedNotStarted();
      expect(released).toEqual([]);
    });
  });
});
