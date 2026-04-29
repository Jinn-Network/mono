import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { RestorationEngine, NotImplementedError, type RestorationEngineOptions, type RecoveryReport } from '../../../src/restorer/engine/engine.js';
import { IntentPersistence, type PersistedIntent, type PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import { recoverInFlight } from '../../../src/restorer/engine/recovery.js';
import type { RestorationOutput } from '../../../src/restorer/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpts(store: Store): RestorationEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  };
}

function makeInput(id: string, overrides: Partial<PersistedIntentInput> = {}): PersistedIntentInput {
  const now = Date.now();
  return {
    requestId: id,
    intentCid: `bafycid-${id}`,
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    restorationJob: { id, description: 'test' },
    ...overrides,
  };
}

/** Engine subclass that records which stubs were invoked, keyed by requestId. */
class SpyEngine extends RestorationEngine {
  readonly called: Map<string, string[]> = new Map();

  private record(intent: PersistedIntent, name: string): void {
    if (!this.called.has(intent.requestId)) this.called.set(intent.requestId, []);
    this.called.get(intent.requestId)!.push(name);
  }

  get testPersistence(): IntentPersistence { return this.persistence; }

  override async claim(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'claim');
    throw new NotImplementedError('claim');
  }
  override async takePreSnapshot(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'takePreSnapshot');
    throw new NotImplementedError('takePreSnapshot');
  }
  override async runImpl(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'runImpl');
    throw new NotImplementedError('runImpl');
  }
  override async takePostSnapshot(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'takePostSnapshot');
    throw new NotImplementedError('takePostSnapshot');
  }
  override async pack(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'pack');
    throw new NotImplementedError('pack');
  }
  override async deliver(intent: PersistedIntent): Promise<void> {
    this.record(intent, 'deliver');
    throw new NotImplementedError('deliver');
  }
}

// ── Recovery tests ────────────────────────────────────────────────────────────

describe('recoverInFlight', () => {
  let store: Store;
  let engine: SpyEngine;
  let p: IntentPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    engine = new SpyEngine(makeOpts(store));
    p = engine.testPersistence;
  });

  afterEach(() => {
    store.close();
  });

  it('returns empty array when nothing is in-flight', async () => {
    const reports = await recoverInFlight(engine);
    expect(reports).toHaveLength(0);
  });

  it('DISCOVERED → dispatches to claim()', async () => {
    p.insertDiscovered(makeInput('r-disc'));
    await recoverInFlight(engine);
    expect(engine.called.get('r-disc')).toContain('claim');
    // Stub throws → intent marked FAILED
    expect(p.getByRequestId('r-disc')!.state).toBe(IntentState.FAILED);
  });

  it('CLAIMED → advances to WAITING without stub call (future window)', async () => {
    p.insertDiscovered(makeInput('r-claimed'));
    p.transition('r-claimed', IntentState.CLAIMED);
    await recoverInFlight(engine);
    // WAITING but startTs is in the future → no further dispatch
    expect(p.getByRequestId('r-claimed')!.state).toBe(IntentState.WAITING);
    expect(engine.called.has('r-claimed')).toBe(false);
  });

  it('WAITING (past start) → advances to PRE_SNAPSHOT and dispatches takePreSnapshot', async () => {
    const now = Date.now();
    p.insertDiscovered(makeInput('r-waiting', { windowStartTs: now - 1000, windowEndTs: now + 86_400_000 }));
    p.transition('r-waiting', IntentState.CLAIMED);
    p.transition('r-waiting', IntentState.WAITING);
    await recoverInFlight(engine);
    expect(engine.called.get('r-waiting')).toContain('takePreSnapshot');
  });

  it('WAITING (future start) → stays in WAITING, no stub', async () => {
    p.insertDiscovered(makeInput('r-waiting-future'));
    p.transition('r-waiting-future', IntentState.CLAIMED);
    p.transition('r-waiting-future', IntentState.WAITING);
    await recoverInFlight(engine);
    expect(p.getByRequestId('r-waiting-future')!.state).toBe(IntentState.WAITING);
    expect(engine.called.has('r-waiting-future')).toBe(false);
  });

  it('PRE_SNAPSHOT (no payload) → dispatches takePreSnapshot', async () => {
    p.insertDiscovered(makeInput('r-pre'));
    p.transition('r-pre', IntentState.CLAIMED);
    p.transition('r-pre', IntentState.WAITING);
    p.transition('r-pre', IntentState.PRE_SNAPSHOT);
    await recoverInFlight(engine);
    expect(engine.called.get('r-pre')).toContain('takePreSnapshot');
  });

  it('PRE_SNAPSHOT (payload present) → advances to RUNNING and dispatches runImpl', async () => {
    p.insertDiscovered(makeInput('r-pre-snap'));
    p.transition('r-pre-snap', IntentState.CLAIMED);
    p.transition('r-pre-snap', IntentState.WAITING);
    p.transition('r-pre-snap', IntentState.PRE_SNAPSHOT, {
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { equity: '1000' },
    });
    await recoverInFlight(engine);
    expect(engine.called.get('r-pre-snap')).toContain('runImpl');
  });

  it('RUNNING → dispatches runImpl', async () => {
    p.insertDiscovered(makeInput('r-run'));
    p.transition('r-run', IntentState.CLAIMED);
    p.transition('r-run', IntentState.WAITING);
    p.transition('r-run', IntentState.PRE_SNAPSHOT);
    p.transition('r-run', IntentState.RUNNING);
    await recoverInFlight(engine);
    expect(engine.called.get('r-run')).toContain('runImpl');
  });

  it('POST_SNAPSHOT (no payload) → dispatches takePostSnapshot', async () => {
    p.insertDiscovered(makeInput('r-post'));
    p.transition('r-post', IntentState.CLAIMED);
    p.transition('r-post', IntentState.WAITING);
    p.transition('r-post', IntentState.PRE_SNAPSHOT);
    p.transition('r-post', IntentState.RUNNING);
    p.transition('r-post', IntentState.POST_SNAPSHOT);
    await recoverInFlight(engine);
    expect(engine.called.get('r-post')).toContain('takePostSnapshot');
  });

  it('POST_SNAPSHOT (payload present) → advances to PACKAGING and dispatches pack', async () => {
    p.insertDiscovered(makeInput('r-post-snap'));
    p.transition('r-post-snap', IntentState.CLAIMED);
    p.transition('r-post-snap', IntentState.WAITING);
    p.transition('r-post-snap', IntentState.PRE_SNAPSHOT);
    p.transition('r-post-snap', IntentState.RUNNING);
    p.transition('r-post-snap', IntentState.POST_SNAPSHOT, {
      postSnapshotCapturedAt: Date.now(),
      postSnapshotPayload: { equity: '1100' },
    });
    await recoverInFlight(engine);
    expect(engine.called.get('r-post-snap')).toContain('pack');
  });

  it('PACKAGING → dispatches pack', async () => {
    p.insertDiscovered(makeInput('r-pack'));
    p.transition('r-pack', IntentState.CLAIMED);
    p.transition('r-pack', IntentState.WAITING);
    p.transition('r-pack', IntentState.PRE_SNAPSHOT);
    p.transition('r-pack', IntentState.RUNNING);
    p.transition('r-pack', IntentState.POST_SNAPSHOT);
    p.transition('r-pack', IntentState.PACKAGING);
    await recoverInFlight(engine);
    expect(engine.called.get('r-pack')).toContain('pack');
  });

  it('DELIVERING → dispatches deliver', async () => {
    p.insertDiscovered(makeInput('r-deliver'));
    p.transition('r-deliver', IntentState.CLAIMED);
    p.transition('r-deliver', IntentState.WAITING);
    p.transition('r-deliver', IntentState.PRE_SNAPSHOT);
    p.transition('r-deliver', IntentState.RUNNING);
    p.transition('r-deliver', IntentState.POST_SNAPSHOT);
    p.transition('r-deliver', IntentState.PACKAGING);
    p.transition('r-deliver', IntentState.DELIVERING);
    await recoverInFlight(engine);
    expect(engine.called.get('r-deliver')).toContain('deliver');
  });

  it('COMPLETE → no dispatch (terminal)', async () => {
    p.insertDiscovered(makeInput('r-complete'));
    p.transition('r-complete', IntentState.CLAIMED);
    p.transition('r-complete', IntentState.WAITING);
    p.transition('r-complete', IntentState.PRE_SNAPSHOT);
    p.transition('r-complete', IntentState.RUNNING);
    p.transition('r-complete', IntentState.POST_SNAPSHOT);
    p.transition('r-complete', IntentState.PACKAGING);
    p.transition('r-complete', IntentState.DELIVERING);
    p.transition('r-complete', IntentState.COMPLETE);
    await recoverInFlight(engine);
    expect(engine.called.has('r-complete')).toBe(false);
  });

  it('FAILED → no dispatch (terminal)', async () => {
    p.insertDiscovered(makeInput('r-failed'));
    p.markFailed('r-failed', 'already done');
    await recoverInFlight(engine);
    expect(engine.called.has('r-failed')).toBe(false);
  });

  it('processes multiple in-flight intents in parallel (allSettled)', async () => {
    // Two intents, both DISCOVERED — both should have claim() called
    p.insertDiscovered(makeInput('r-a'));
    p.insertDiscovered(makeInput('r-b'));
    await recoverInFlight(engine);
    expect(engine.called.get('r-a')).toContain('claim');
    expect(engine.called.get('r-b')).toContain('claim');
  });

  it('one failing intent does not block others', async () => {
    p.insertDiscovered(makeInput('r-ok'));
    p.insertDiscovered(makeInput('r-err'));
    // r-ok: CLAIMED (safe; advances to WAITING with future start → no stub)
    p.transition('r-ok', IntentState.CLAIMED);
    // r-err: DISCOVERED (claim() will throw)
    await recoverInFlight(engine);
    // r-err is FAILED
    expect(p.getByRequestId('r-err')!.state).toBe(IntentState.FAILED);
    // r-ok advanced to WAITING safely
    expect(p.getByRequestId('r-ok')!.state).toBe(IntentState.WAITING);
  });

  describe('RecoveryReport return shape', () => {
    it('returns ok report for intent that needs no stub (CLAIMED → WAITING)', async () => {
      p.insertDiscovered(makeInput('r-claimed'));
      p.transition('r-claimed', IntentState.CLAIMED);
      const reports = await recoverInFlight(engine);
      expect(reports).toHaveLength(1);
      const report = reports[0] as RecoveryReport;
      expect(report.requestId).toBe('r-claimed');
      expect(report.outcome).toBe('ok');
      expect(report.error).toBeUndefined();
    });

    it('returns failed report for intent whose stub throws', async () => {
      p.insertDiscovered(makeInput('r-disc'));
      const reports = await recoverInFlight(engine);
      expect(reports).toHaveLength(1);
      const report = reports[0] as RecoveryReport;
      expect(report.requestId).toBe('r-disc');
      expect(report.outcome).toBe('failed');
      expect(report.error).toContain('NotImplemented');
    });

    it('returns per-intent reports for mixed batch', async () => {
      p.insertDiscovered(makeInput('r-ok'));
      p.insertDiscovered(makeInput('r-err'));
      p.transition('r-ok', IntentState.CLAIMED); // will advance to WAITING → ok
      const reports = await recoverInFlight(engine);
      expect(reports).toHaveLength(2);
      const ok = reports.find((r) => r.requestId === 'r-ok');
      const err = reports.find((r) => r.requestId === 'r-err');
      expect(ok?.outcome).toBe('ok');
      expect(err?.outcome).toBe('failed');
    });
  });
});

// ── PACKAGING recovery: implOutputs hydrated from DB (#6) ─────────────────────

describe('PACKAGING recovery: implOutputs persisted and hydrated on restart', () => {
  /**
   * Engine subclass that:
   * - Exposes persistence for test setup
   * - Records what implOutput pack() received via its in-memory map
   * - Overrides pack() to record the hydrated implOutput, then marks DELIVERING
   *   (simulates pack completing successfully without needing IPFS)
   */
  class PackHydrationEngine extends RestorationEngine {
    /** The implOutput that pack() found in the in-memory map (may have been hydrated from DB). */
    capturedImplOutput: RestorationOutput | undefined = undefined;

    get testPersistence(): IntentPersistence { return this.persistence; }

    /**
     * Access the internal implOutputs map (read-only) for test assertions.
     * Cast to any to access the private field — acceptable in test code.
     */
    getImplOutputsMap(): Map<string, RestorationOutput> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this as any).implOutputs as Map<string, RestorationOutput>;
    }

    override async pack(intent: PersistedIntent): Promise<void> {
      // Trigger the hydration logic by calling the real pack() ... but we
      // don't have IPFS/manifest deps wired up. Instead, we call the
      // hydration logic indirectly: check that the map is populated.
      //
      // Hydration happens inside the real pack() when packagingDeps is absent;
      // we can't easily call super.pack() without the full deps. So instead we
      // replicate the hydration path from engine.ts here and then inspect the map.
      //
      // Actually, the hydration code in engine.ts runs unconditionally at the
      // start of pack() before the packagingDeps guard. So we call super.pack()
      // which will throw NotImplementedError (no packagingDeps), but by then
      // the hydration has already populated the map.
      try {
        await super.pack(intent);
      } catch (err) {
        // NotImplementedError is expected — packagingDeps not wired.
        // What matters is that implOutputs was populated before the throw.
      }
      // Read from the map AFTER the (partial) super.pack() invocation
      this.capturedImplOutput = this.getImplOutputsMap().get(intent.requestId);
    }
  }

  it('pack() hydrates implOutputs from DB when in-memory map is empty (crash recovery)', async () => {
    const store = new Store(':memory:');
    try {
      const now = Date.now() - 1000;
      const requestId = 'pkg-recovery-1';

      // ── Phase 1: initial run ──────────────────────────────────────────────
      const engine1 = new PackHydrationEngine({
        store,
        paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
      });
      const p = engine1.testPersistence;

      p.insertDiscovered({
        requestId,
        intentCid: 'bafyintent',
        onchainCreationTx: '0xdeadbeef',
        onchainCreationBlock: 1,
        windowStartTs: now,
        windowEndTs: now + 86_400_000,
        restorationJob: { id: requestId, description: 'test' },
      });

      // Advance to PACKAGING state, with implOutputsJson persisted
      // (simulates what runImpl does in production)
      const deterministicOutput: RestorationOutput = {
        postSnapshot: { capturedAt: 1000, hlTime: 0, payload: { equity: '1234.56' } },
        fills: [{ coin: 'ETH', amount: '1.0', price: '3000', side: 'buy' }],
        gating: { passed: true, checks: [] },
        rationale: 'Deterministic test output',
        artifacts: [],
      };

      p.transition(requestId, IntentState.CLAIMED);
      p.transition(requestId, IntentState.WAITING);
      p.transition(requestId, IntentState.PRE_SNAPSHOT, {
        preSnapshotCapturedAt: 999,
        preSnapshotPayload: { provisioned: true },
      });
      // Simulate runImpl: transition to POST_SNAPSHOT with implOutputsJson persisted
      p.transition(requestId, IntentState.RUNNING);
      p.transition(requestId, IntentState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: 1000,
        postSnapshotPayload: deterministicOutput.postSnapshot,
        fillsPayload: deterministicOutput.fills ?? [],
        gatingClaim: deterministicOutput.gating,
        implOutputsJson: JSON.stringify(deterministicOutput),
      });
      p.transition(requestId, IntentState.PACKAGING);

      // ── Phase 2: "crash" — new engine instance (implOutputs map is empty) ─
      // engine1 is discarded (its implOutputs map is lost).
      // engine2 has the same DB but empty in-memory map.
      const engine2 = new PackHydrationEngine({
        store,
        paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
      });

      // Verify the in-memory map is empty on the new engine
      expect(engine2.getImplOutputsMap().has(requestId)).toBe(false);

      // Drive pack() — it should hydrate from implOutputsJson in the DB
      await engine2.pack(p.getOrThrow(requestId));

      // The hydrated output must match the original deterministic output
      expect(engine2.capturedImplOutput).toBeDefined();
      expect(engine2.capturedImplOutput?.rationale).toBe(deterministicOutput.rationale);
      expect(engine2.capturedImplOutput?.gating).toEqual(deterministicOutput.gating);
      expect(engine2.capturedImplOutput?.postSnapshot?.payload).toEqual(
        deterministicOutput.postSnapshot?.payload,
      );
    } finally {
      store.close();
    }
  });

  it('pack() uses in-memory implOutputs when available (non-recovery path)', async () => {
    const store = new Store(':memory:');
    try {
      const now = Date.now() - 1000;
      const requestId = 'pkg-mem-1';

      const engine = new PackHydrationEngine({
        store,
        paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
      });
      const p = engine.testPersistence;

      p.insertDiscovered({
        requestId,
        intentCid: 'bafyintent',
        onchainCreationTx: '0xdeadbeef',
        onchainCreationBlock: 1,
        windowStartTs: now,
        windowEndTs: now + 86_400_000,
        restorationJob: { id: requestId, description: 'test' },
      });

      const output: RestorationOutput = {
        postSnapshot: { capturedAt: 2000, hlTime: 0, payload: { equity: '9999' } },
        fills: [],
        gating: { passed: false, checks: [] },
        rationale: 'In-memory output',
        artifacts: [],
      };

      // Manually populate in-memory map (simulates what runImpl does)
      engine.getImplOutputsMap().set(requestId, output);

      p.transition(requestId, IntentState.CLAIMED);
      p.transition(requestId, IntentState.WAITING);
      p.transition(requestId, IntentState.PRE_SNAPSHOT, {
        preSnapshotCapturedAt: 1999,
        preSnapshotPayload: { provisioned: true },
      });
      p.transition(requestId, IntentState.RUNNING);
      p.transition(requestId, IntentState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: 2000,
        postSnapshotPayload: output.postSnapshot,
        fillsPayload: [],
        gatingClaim: output.gating,
        // Note: no implOutputsJson — tests that in-memory path doesn't need it
      });
      p.transition(requestId, IntentState.PACKAGING);

      await engine.pack(p.getOrThrow(requestId));

      // Must have used the in-memory output, not a DB hydration
      expect(engine.capturedImplOutput).toBeDefined();
      expect(engine.capturedImplOutput?.rationale).toBe('In-memory output');
    } finally {
      store.close();
    }
  });
});
