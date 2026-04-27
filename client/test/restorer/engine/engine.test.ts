import { describe, it, expect, vi } from 'vitest';
import {
  NotImplementedError,
  type RecoveryReport,
} from '../../../src/restorer/engine/engine.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { ClaimRegistryClient } from '../../../src/adapters/claim-registry/client.js';
import type { MarketplaceClaimer } from '../../../src/restorer/engine/claim.js';
import { withTempStore } from '@test/store.js';
import { makeIntentInput, createStateMachineSpy } from '@test/engine.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RestorationEngine', () => {
  describe('observe', () => {
    it('inserts a DISCOVERED row', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.DISCOVERED);
      });
    });

    it('is idempotent — observing twice is a no-op', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001', intentCid: 'bafyabc123' }));
        await engine.observe(makeIntentInput({ requestId: 'req-001', intentCid: 'different' }));
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.intentCid).toBe('bafyabc123'); // first wins
      });
    });
  });

  describe('process — DISCOVERED state', () => {
    it('calls claim() when processing a DISCOVERED intent', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('claim');
      });
    });

    it('marks intent FAILED when claim() throws', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await expect(engine.process('req-001')).rejects.toThrow();
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.FAILED);
        expect(intent!.failureReason).toContain('claim');
      });
    });

    it('advances to CLAIMED when claim() succeeds', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({
          store,
          onClaim: async () => {
            engine.testPersistence.transition('req-001', IntentState.CLAIMED);
          },
        });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await engine.process('req-001');
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.CLAIMED);
      });
    });

    it('does not fail when a concurrent claim already advanced DISCOVERED → CLAIMED', async () => {
      await withTempStore(async (store) => {
        const registry = {
          weAlreadyClaimed: vi.fn().mockResolvedValue(true),
          claimJob: vi.fn(),
          releaseClaim: vi.fn(),
        } as unknown as ClaimRegistryClient;
        let engineRef: ReturnType<typeof createStateMachineSpy>['engine'] | undefined;
        const marketplace = {
          claimRequest: vi.fn().mockImplementation(async () => {
            engineRef!.testPersistence.transition('req-001', IntentState.CLAIMED);
          }),
        } satisfies MarketplaceClaimer;
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: { registryClient: registry, marketplaceClaimer: marketplace },
        });
        engineRef = engine;

        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await engine.process('req-001');

        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.CLAIMED);
        expect(intent!.failureReason).toBeNull();
        expect(marketplace.claimRequest).toHaveBeenCalledOnce();
      });
    });
  });

  describe('process — CLAIMED state', () => {
    it('advances CLAIMED → WAITING without calling any stub', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        await engine.process('req-001');
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.WAITING);
        expect(calls).toHaveLength(0);
      });
    });
  });

  describe('process — WAITING state', () => {
    it('stays in WAITING when window has not started yet', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        const futureStart = Date.now() + 10_000_000;
        await engine.observe(makeIntentInput({ requestId: 'req-001', windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        await engine.process('req-001');
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.WAITING);
        expect(calls).toHaveLength(0);
      });
    });

    it('advances to PRE_SNAPSHOT and calls takePreSnapshot when window has started', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        const pastStart = Date.now() - 1_000;
        await engine.observe(makeIntentInput({ requestId: 'req-001', windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        // takePreSnapshot is a stub — will throw NotImplementedError
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('takePreSnapshot');
      });
    });
  });

  describe('process — PRE_SNAPSHOT state', () => {
    it('calls takePreSnapshot when snapshot is absent', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('takePreSnapshot');
      });
    });

    it('advances to RUNNING and calls runImpl when snapshot is already present', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT, {
          preSnapshotCapturedAt: Date.now(),
          preSnapshotPayload: { equity: '1000' },
        });
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('runImpl');
      });
    });
  });

  describe('process — RUNNING state', () => {
    it('calls runImpl', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('runImpl');
      });
    });
  });

  describe('process — POST_SNAPSHOT state', () => {
    it('calls takePostSnapshot when post snapshot absent', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('takePostSnapshot');
      });
    });

    it('advances to PACKAGING and calls pack when post snapshot present', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT, {
          postSnapshotCapturedAt: Date.now(),
          postSnapshotPayload: { equity: '1100' },
        });
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('pack');
      });
    });
  });

  describe('process — PACKAGING state', () => {
    it('calls pack', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.PACKAGING);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('pack');
      });
    });
  });

  describe('process — DELIVERING state', () => {
    it('calls deliver', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.PACKAGING);
        engine.testPersistence.transition('req-001', IntentState.DELIVERING);
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
        expect(calls).toContain('deliver');
      });
    });
  });

  describe('process — COMPLETE / FAILED (terminal)', () => {
    it('is a no-op for COMPLETE', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
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
        expect(calls).toHaveLength(0);
      });
    });

    it('is a no-op for FAILED', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.markFailed('req-001', 'boom');
        await engine.process('req-001');
        expect(calls).toHaveLength(0);
      });
    });
  });

  describe('process — unknown requestId', () => {
    it('throws for a missing intent', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await expect(engine.process('no-such-id')).rejects.toThrow(/not found/);
      });
    });
  });

  describe('recoverInFlight', () => {
    it('dispatches each in-flight intent to the appropriate transition stub', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        const now = Date.now();
        // DISCOVERED
        await engine.observe(makeIntentInput({ requestId: 'r-discovered' }));
        // CLAIMED
        await engine.observe(makeIntentInput({ requestId: 'r-claimed' }));
        engine.testPersistence.transition('r-claimed', IntentState.CLAIMED);
        // RUNNING
        await engine.observe(makeIntentInput({ requestId: 'r-running', windowStartTs: now - 1000, windowEndTs: now + 86_400_000 }));
        engine.testPersistence.transition('r-running', IntentState.CLAIMED);
        engine.testPersistence.transition('r-running', IntentState.WAITING);
        engine.testPersistence.transition('r-running', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('r-running', IntentState.RUNNING);
        // PACKAGING
        await engine.observe(makeIntentInput({ requestId: 'r-packaging' }));
        engine.testPersistence.transition('r-packaging', IntentState.CLAIMED);
        engine.testPersistence.transition('r-packaging', IntentState.WAITING);
        engine.testPersistence.transition('r-packaging', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('r-packaging', IntentState.RUNNING);
        engine.testPersistence.transition('r-packaging', IntentState.POST_SNAPSHOT);
        engine.testPersistence.transition('r-packaging', IntentState.PACKAGING);

        // recoverInFlight should not throw (errors are caught per-intent)
        const reports = await engine.recoverInFlight();

        // claim called for DISCOVERED (stub throws, intent marked failed)
        expect(calls).toContain('claim');
        // runImpl called for RUNNING
        expect(calls).toContain('runImpl');
        // pack called for PACKAGING
        expect(calls).toContain('pack');

        // Reports should be per-intent
        expect(reports.length).toBeGreaterThan(0);
        expect(reports.every((r: RecoveryReport) => r.requestId && r.outcome)).toBe(true);
      });
    });

    it('marks FAILED intents that throw during recovery', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'r1' }));
        await engine.recoverInFlight();
        const intent = engine.testPersistence.getByRequestId('r1');
        // claim stub threw NotImplementedError → should be marked FAILED
        expect(intent!.state).toBe(IntentState.FAILED);
        expect(intent!.failureReason).toContain('NotImplemented');
      });
    });

    it('CLAIMED → WAITING is driven without stub call', async () => {
      await withTempStore(async (store) => {
        const { engine, calls } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'r-claimed' }));
        engine.testPersistence.transition('r-claimed', IntentState.CLAIMED);
        // WAITING has future startTs, so recovery stops there without stub call
        const reports = await engine.recoverInFlight();
        const intent = engine.testPersistence.getByRequestId('r-claimed');
        expect(intent!.state).toBe(IntentState.WAITING);
        expect(calls).toHaveLength(0);
        // The CLAIMED→WAITING advance is a success
        expect(reports[0]?.outcome).toBe('ok');
      });
    });

    it('returns per-intent RecoveryReport with outcome field', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'r-disc' }));
        const reports = await engine.recoverInFlight();
        expect(reports).toHaveLength(1);
        const r = reports[0] as RecoveryReport;
        expect(r.requestId).toBe('r-disc');
        expect(r.outcome).toBe('failed');
        expect(typeof r.error).toBe('string');
      });
    });
  });

  describe('dataDrivenAdvance', () => {
    it('returns null for DISCOVERED state', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBeNull();
      });
    });

    it('returns null for WAITING when window is in the future', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        const futureStart = Date.now() + 10_000_000;
        await engine.observe(makeIntentInput({ requestId: 'req-001', windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBeNull();
      });
    });

    it('returns PRE_SNAPSHOT for WAITING when window has started', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        const pastStart = Date.now() - 1_000;
        await engine.observe(makeIntentInput({ requestId: 'req-001', windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBe(IntentState.PRE_SNAPSHOT);
      });
    });

    it('returns null for PRE_SNAPSHOT when payload is absent', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBeNull();
      });
    });

    it('returns RUNNING for PRE_SNAPSHOT when payload is present', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT, {
          preSnapshotCapturedAt: Date.now(),
          preSnapshotPayload: { equity: '1000' },
        });
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBe(IntentState.RUNNING);
      });
    });

    it('returns null for POST_SNAPSHOT when payload is absent', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        engine.testPersistence.transition('req-001', IntentState.POST_SNAPSHOT);
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBeNull();
      });
    });

    it('returns PACKAGING for POST_SNAPSHOT when payload is present', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
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
    });

    it('returns null for RUNNING state (no data-driven advance)', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);
        engine.testPersistence.transition('req-001', IntentState.WAITING);
        engine.testPersistence.transition('req-001', IntentState.PRE_SNAPSHOT);
        engine.testPersistence.transition('req-001', IntentState.RUNNING);
        const intent = engine.testPersistence.getByRequestId('req-001')!;
        expect(engine.testDataDrivenAdvance(intent)).toBeNull();
      });
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
      await withTempStore(async (store) => {
        const registryClient = makeRegistryClient();
        const marketplace = makeMarketplaceClaimer();
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: { registryClient, marketplaceClaimer: marketplace },
        });

        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await engine.process('req-001');

        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.CLAIMED);
        expect(registryClient.claimJob).toHaveBeenCalledOnce();
        expect(marketplace.claimRequest).toHaveBeenCalledOnce();
      });
    });

    it('marks FAILED when ClaimRegistry claim fails', async () => {
      await withTempStore(async (store) => {
        const registryClient = makeRegistryClient({
          claimResult: { txHash: '', claimed: false },
        });
        const marketplace = makeMarketplaceClaimer();
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: { registryClient, marketplaceClaimer: marketplace },
        });

        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await expect(engine.process('req-001')).rejects.toThrow(/ClaimRegistry claim failed/);

        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.FAILED);
        expect(marketplace.claimRequest).not.toHaveBeenCalled();
      });
    });

    it('marks FAILED when marketplace claim fails', async () => {
      await withTempStore(async (store) => {
        const registryClient = makeRegistryClient();
        const marketplace = makeMarketplaceClaimer(new Error('Claim policy rejected'));
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: { registryClient, marketplaceClaimer: marketplace },
        });

        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await expect(engine.process('req-001')).rejects.toThrow('Claim policy rejected');

        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.FAILED);
        // ClaimRegistry claim should have been released
        expect(registryClient.releaseClaim).toHaveBeenCalledOnce();
      });
    });

    it('is idempotent on resume: skips claimJob when weAlreadyClaimed=true', async () => {
      await withTempStore(async (store) => {
        const registryClient = makeRegistryClient({ weAlreadyClaimed: true });
        const marketplace = makeMarketplaceClaimer();
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: { registryClient, marketplaceClaimer: marketplace },
        });

        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await engine.process('req-001');

        expect(registryClient.claimJob).not.toHaveBeenCalled();
        expect(marketplace.claimRequest).toHaveBeenCalledOnce();
        const intent = engine.testPersistence.getByRequestId('req-001');
        expect(intent!.state).toBe(IntentState.CLAIMED);
      });
    });

    it('falls back to NotImplementedError when claimDeps is absent', async () => {
      await withTempStore(async (store) => {
        // Engine without claimDeps — original stub behaviour
        const { engine } = createStateMachineSpy({ store });
        await engine.observe(makeIntentInput({ requestId: 'req-001' }));
        await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      });
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
      await withTempStore(async (store) => {
        const registryClient = makeRegistryClient();
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: {
            registryClient,
            marketplaceClaimer: { claimRequest: vi.fn().mockResolvedValue(undefined) },
          },
        });

        // Insert a CLAIMED intent with future windowStartTs
        const futureStart = Date.now() + 60_000;
        await engine.observe(makeIntentInput({ requestId: 'req-001', windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);

        const released = await engine.releaseClaimedNotStarted();
        expect(released).toContain('req-001');
        expect(registryClient.releaseClaim).toHaveBeenCalledOnce();
      });
    });

    it('does not release CLAIMED intents whose window has already started', async () => {
      await withTempStore(async (store) => {
        const registryClient = makeRegistryClient();
        const { engine } = createStateMachineSpy({
          store,
          claimDeps: {
            registryClient,
            marketplaceClaimer: { claimRequest: vi.fn().mockResolvedValue(undefined) },
          },
        });

        // Insert a CLAIMED intent with PAST windowStartTs (window started)
        const pastStart = Date.now() - 1_000;
        await engine.observe(makeIntentInput({ requestId: 'req-001', windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
        engine.testPersistence.transition('req-001', IntentState.CLAIMED);

        const released = await engine.releaseClaimedNotStarted();
        expect(released).toHaveLength(0);
        expect(registryClient.releaseClaim).not.toHaveBeenCalled();
      });
    });

    it('returns empty array when claimDeps is absent', async () => {
      await withTempStore(async (store) => {
        const { engine } = createStateMachineSpy({ store });
        const released = await engine.releaseClaimedNotStarted();
        expect(released).toEqual([]);
      });
    });
  });
});
