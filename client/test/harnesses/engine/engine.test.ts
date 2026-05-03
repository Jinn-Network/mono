import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  NotImplementedError,
  type TaskEngineOptions,
  type RecoveryReport,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRun, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, ReadyStatus, Solution } from '../../../src/harnesses/types.js';

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeOpts(store: Store): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  };
}

function makeInput(overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: 'req-001',
    taskCid: 'bafyabc123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1000,
    solverType: 'portfolio.v0',
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    task: { id: 'req-001', description: 'test', solverType: 'portfolio.v0', role: 'restoration' },
    ...overrides,
  };
}

/** Subclass that exposes overrideable stubs and records which transitions were called. */
class TestEngine extends TaskEngine {
  calls: string[] = [];
  delegateClaimToSuper = false;
  claimFn?: (intent: PersistedTaskRun) => Promise<void>;
  preSnapshotFn?: (intent: PersistedTaskRun) => Promise<void>;
  runImplFn?: (intent: PersistedTaskRun) => Promise<void>;
  postSnapshotFn?: (intent: PersistedTaskRun) => Promise<void>;
  packFn?: (intent: PersistedTaskRun) => Promise<void>;
  deliverFn?: (intent: PersistedTaskRun) => Promise<void>;

  override async claim(intent: PersistedTaskRun): Promise<void> {
    this.calls.push('claim');
    if (this.claimFn) return this.claimFn(intent);
    if (this.delegateClaimToSuper) return super.claim(intent);
    throw new NotImplementedError('claim');
  }
  override async takePreSnapshot(intent: PersistedTaskRun): Promise<void> {
    this.calls.push('takePreSnapshot');
    if (this.preSnapshotFn) return this.preSnapshotFn(intent);
    throw new NotImplementedError('takePreSnapshot');
  }
  override async runImpl(intent: PersistedTaskRun): Promise<void> {
    this.calls.push('runImpl');
    if (this.runImplFn) return this.runImplFn(intent);
    throw new NotImplementedError('runImpl');
  }
  override async takePostSnapshot(intent: PersistedTaskRun): Promise<void> {
    this.calls.push('takePostSnapshot');
    if (this.postSnapshotFn) return this.postSnapshotFn(intent);
    throw new NotImplementedError('takePostSnapshot');
  }
  override async pack(intent: PersistedTaskRun): Promise<void> {
    this.calls.push('pack');
    if (this.packFn) return this.packFn(intent);
    throw new NotImplementedError('pack');
  }
  override async deliver(intent: PersistedTaskRun): Promise<void> {
    this.calls.push('deliver');
    if (this.deliverFn) return this.deliverFn(intent);
    throw new NotImplementedError('deliver');
  }

  // Expose persistence for test assertions
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }

  // Expose private dataDrivenAdvance for unit testing
  testDataDrivenAdvance(intent: PersistedTaskRun): TaskRunState | null {
    // Access via index to bypass TypeScript's private modifier
    return (this as unknown as { dataDrivenAdvance(i: PersistedTaskRun): TaskRunState | null }).dataDrivenAdvance(intent);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskEngine', () => {
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
      expect(intent!.state).toBe(TaskRunState.DISCOVERED);
    });

    it('is idempotent — observing twice is a no-op', async () => {
      await engine.observe(makeInput());
      await engine.observe(makeInput({ taskCid: 'different' }));
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.taskCid).toBe('bafyabc123'); // first wins
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
      expect(intent!.state).toBe(TaskRunState.FAILED);
      expect(intent!.failureReason).toContain('claim');
    });

    it('advances to CLAIMED when claim() succeeds', async () => {
      await engine.observe(makeInput());
      engine.claimFn = async () => {
        engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      };
      await engine.process('req-001');
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(TaskRunState.CLAIMED);
    });
  });

  describe('process — CLAIMED state', () => {
    it('advances CLAIMED → WAITING without calling any stub', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      await engine.process('req-001');
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(TaskRunState.WAITING);
      expect(engine.calls).toHaveLength(0);
    });
  });

  describe('process — WAITING state', () => {
    it('stays in WAITING when window has not started yet', async () => {
      const futureStart = Date.now() + 10_000_000;
      await engine.observe(makeInput({ windowStartTs: futureStart, windowEndTs: futureStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      await engine.process('req-001');
      const intent = engine.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(TaskRunState.WAITING);
      expect(engine.calls).toHaveLength(0);
    });

    it('advances to PRE_SNAPSHOT and calls takePreSnapshot when window has started', async () => {
      const pastStart = Date.now() - 1_000;
      await engine.observe(makeInput({ windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      // takePreSnapshot is a stub — will throw NotImplementedError
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('takePreSnapshot');
    });
  });

  describe('process — PRE_SNAPSHOT state', () => {
    it('calls takePreSnapshot when snapshot is absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('takePreSnapshot');
    });

    it('advances to RUNNING and calls runImpl when snapshot is already present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT, {
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
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('runImpl');
    });
  });

  describe('process — POST_SNAPSHOT state', () => {
    it('calls takePostSnapshot when post snapshot absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      engine.testPersistence.transition('req-001', TaskRunState.POST_SNAPSHOT);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('takePostSnapshot');
    });

    it('advances to PACKAGING and calls pack when post snapshot present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      engine.testPersistence.transition('req-001', TaskRunState.POST_SNAPSHOT, {
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
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      engine.testPersistence.transition('req-001', TaskRunState.POST_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.PACKAGING);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('pack');
    });
  });

  describe('process — DELIVERING state', () => {
    it('calls deliver', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      engine.testPersistence.transition('req-001', TaskRunState.POST_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.PACKAGING);
      engine.testPersistence.transition('req-001', TaskRunState.DELIVERING);
      await expect(engine.process('req-001')).rejects.toThrow(NotImplementedError);
      expect(engine.calls).toContain('deliver');
    });
  });

  describe('emitCycleArtifact', () => {
    function callEmit(
      e: TestEngine,
      intent: PersistedTaskRun,
      manifestCid = 'bafkreitestmanifest',
      evidenceHash: `0x${string}` | null = '0xabcd',
    ): void {
      (e as unknown as {
        emitCycleArtifact(i: PersistedTaskRun, m: string, h: `0x${string}` | null): void;
      }).emitCycleArtifact(intent, manifestCid, evidenceHash);
    }

    function makePersistedTaskRun(overrides: Partial<PersistedTaskRun> = {}): PersistedTaskRun {
      return {
        requestId: '0xreq1',
        taskCid: 'bafyabc',
        onchainCreationTx: '0xtx',
        onchainCreationBlock: 1,
        solverType: 'prediction.v0',
        taskRole: 'restoration',
        implName: 'prediction-v0-baseline',
        state: TaskRunState.COMPLETE,
        stateUpdatedAt: 0,
        workingDir: null,
        implStateDir: null,
        windowStartTs: 0,
        windowEndTs: 0,
        preSnapshotCapturedAt: null,
        preSnapshotPayload: null,
        postSnapshotCapturedAt: null,
        postSnapshotPayload: null,
        fillsPayload: null,
        gatingClaim: null,
        informationalClaim: null,
        artifactCids: null,
        manifestCid: null,
        deliveryTxHash: null,
        manifestGeneratedAt: null,
        evidenceHash: null,
        task: { id: 'pred-v0-auto-1714400000000', description: 'test', solverType: 'prediction.v0', role: 'restoration' },
        solutionOutputsJson: null,
        failureReason: null,
        failureAt: null,
        ...overrides,
      };
    }

    it('writes a restoration-result row for a successful restoration cycle', () => {
      callEmit(engine, makePersistedTaskRun());
      const row = store.getArtifactByRequestId('0xreq1', 'restoration-result');
      expect(row).not.toBeNull();
      expect(row!.outcome).toBe('SUCCESS');
      expect(row!.tags).toContain('restoration-result');
      expect(row!.tags).toContain('success');
    });

    it('writes an evaluation-verdict row for an evaluation cycle', () => {
      callEmit(engine, makePersistedTaskRun({
        requestId: '0xreq2',
        taskRole: 'evaluation',
        implName: 'prediction-v0-evaluator',
      }));
      const restored = store.getArtifactByRequestId('0xreq2', 'restoration-result');
      const evaluated = store.getArtifactByRequestId('0xreq2', 'evaluation-verdict');
      expect(restored).toBeNull();
      expect(evaluated).not.toBeNull();
      expect(evaluated!.tags).toContain('evaluation-verdict');
    });

    it('is idempotent — second call leaves the existing row alone', () => {
      const intent = makePersistedTaskRun();
      callEmit(engine, intent, 'bafkreifirst');
      const first = store.getArtifactByRequestId('0xreq1', 'restoration-result');
      expect(first).not.toBeNull();
      const firstId = first!.id;
      callEmit(engine, intent, 'bafkreisecond');
      const second = store.getArtifactByRequestId('0xreq1', 'restoration-result');
      expect(second!.id).toBe(firstId);
      // Content reflects the FIRST insert (legacy MCP rows must not be clobbered).
      expect(second!.content).not.toContain('bafkreisecond');
    });

    it('skips rows when task is null (legacy pre-migration intents)', () => {
      callEmit(engine, makePersistedTaskRun({ task: null }));
      const row = store.getArtifactByRequestId('0xreq1', 'restoration-result');
      expect(row).toBeNull();
    });
  });

  describe('process — COMPLETE / FAILED (terminal)', () => {
    it('is a no-op for COMPLETE', async () => {
      await engine.observe(makeInput());
      // Advance to COMPLETE manually
      const p = engine.testPersistence;
      p.transition('req-001', TaskRunState.CLAIMED);
      p.transition('req-001', TaskRunState.WAITING);
      p.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      p.transition('req-001', TaskRunState.RUNNING);
      p.transition('req-001', TaskRunState.POST_SNAPSHOT);
      p.transition('req-001', TaskRunState.PACKAGING);
      p.transition('req-001', TaskRunState.DELIVERING);
      p.transition('req-001', TaskRunState.COMPLETE);
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
      engine.testPersistence.transition('r-claimed', TaskRunState.CLAIMED);
      // RUNNING
      await engine.observe(makeInput({ requestId: 'r-running', windowStartTs: now - 1000, windowEndTs: now + 86_400_000 }));
      engine.testPersistence.transition('r-running', TaskRunState.CLAIMED);
      engine.testPersistence.transition('r-running', TaskRunState.WAITING);
      engine.testPersistence.transition('r-running', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('r-running', TaskRunState.RUNNING);
      // PACKAGING
      await engine.observe(makeInput({ requestId: 'r-packaging' }));
      engine.testPersistence.transition('r-packaging', TaskRunState.CLAIMED);
      engine.testPersistence.transition('r-packaging', TaskRunState.WAITING);
      engine.testPersistence.transition('r-packaging', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('r-packaging', TaskRunState.RUNNING);
      engine.testPersistence.transition('r-packaging', TaskRunState.POST_SNAPSHOT);
      engine.testPersistence.transition('r-packaging', TaskRunState.PACKAGING);

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
      expect(intent!.state).toBe(TaskRunState.FAILED);
      expect(intent!.failureReason).toContain('NotImplemented');
    });

    it('CLAIMED → WAITING is driven without stub call', async () => {
      await engine.observe(makeInput({ requestId: 'r-claimed' }));
      engine.testPersistence.transition('r-claimed', TaskRunState.CLAIMED);
      // WAITING has future startTs, so recovery stops there without stub call
      const reports = await engine.recoverInFlight();
      const intent = engine.testPersistence.getByRequestId('r-claimed');
      expect(intent!.state).toBe(TaskRunState.WAITING);
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
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns PRE_SNAPSHOT for WAITING when window has started', async () => {
      const pastStart = Date.now() - 1_000;
      await engine.observe(makeInput({ windowStartTs: pastStart, windowEndTs: pastStart + 86_400_000 }));
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBe(TaskRunState.PRE_SNAPSHOT);
    });

    it('returns null for PRE_SNAPSHOT when payload is absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns RUNNING for PRE_SNAPSHOT when payload is present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT, {
        preSnapshotCapturedAt: Date.now(),
        preSnapshotPayload: { equity: '1000' },
      });
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBe(TaskRunState.RUNNING);
    });

    it('returns null for POST_SNAPSHOT when payload is absent', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      engine.testPersistence.transition('req-001', TaskRunState.POST_SNAPSHOT);
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBeNull();
    });

    it('returns PACKAGING for POST_SNAPSHOT when payload is present', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
      engine.testPersistence.transition('req-001', TaskRunState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: Date.now(),
        postSnapshotPayload: { equity: '1100' },
      });
      const intent = engine.testPersistence.getByRequestId('req-001')!;
      expect(engine.testDataDrivenAdvance(intent)).toBe(TaskRunState.PACKAGING);
    });

    it('returns null for RUNNING state (no data-driven advance)', async () => {
      await engine.observe(makeInput());
      engine.testPersistence.transition('req-001', TaskRunState.CLAIMED);
      engine.testPersistence.transition('req-001', TaskRunState.WAITING);
      engine.testPersistence.transition('req-001', TaskRunState.PRE_SNAPSHOT);
      engine.testPersistence.transition('req-001', TaskRunState.RUNNING);
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

  describe('claim() clean-break gate', () => {
    function stubImpl(
      overrides: Partial<Harness> & {
        isReady?: (ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }) => Promise<ReadyStatus>;
      } = {},
    ): Harness {
      return {
        name: 'stub-impl',
        version: '1.0.0',
        supports: () => true,
        run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
        ...overrides,
      };
    }

    it('advances DISCOVERED → CLAIMED after the adapter has already claimed the Task', async () => {
      const eng = new TestEngine(makeOpts(store));
      eng.delegateClaimToSuper = true;

      await eng.observe(makeInput());
      await eng.process('req-001');

      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(TaskRunState.CLAIMED);
    });

    it('marks FAILED when no Harness is registered for the solverType', async () => {
      const eng = new TestEngine({
        ...makeOpts(store),
        implRegistry: { findFor: () => undefined },
      });
      eng.delegateClaimToSuper = true;

      await eng.observe(makeInput());
      await expect(eng.process('req-001')).rejects.toThrow(/no Harness registered or enabled/);

      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(TaskRunState.FAILED);
      expect(intent!.failureReason).toMatch(/jinn solver-nets set-harness <name> <harness>/);
    });

    it('marks FAILED when the selected Harness is not ready', async () => {
      const eng = new TestEngine({
        ...makeOpts(store),
        implRegistry: {
          findFor: () => stubImpl({
            isReady: async () => ({
              ready: false,
              reason: 'wallet not approved',
              nextStep: { description: 'approve wallet', cli: 'jinn solver-nets enable portfolio' },
            }),
          }),
        },
      });
      eng.delegateClaimToSuper = true;

      await eng.observe(makeInput());
      await expect(eng.process('req-001')).rejects.toThrow(/not ready/);

      const intent = eng.testPersistence.getByRequestId('req-001');
      expect(intent!.state).toBe(TaskRunState.FAILED);
      expect(intent!.failureReason).toMatch(/wallet not approved/);
      expect(intent!.failureReason).toMatch(/jinn solver-nets enable portfolio/);
    });
  });

  // ── releaseClaimedNotStarted ──────────────────────────────────────────────

  describe('releaseClaimedNotStarted()', () => {
    it('returns empty array; TaskCoordinator v1 does not release claimed attempts', async () => {
      const eng = new TestEngine(makeOpts(store));
      const released = await eng.releaseClaimedNotStarted();
      expect(released).toEqual([]);
    });
  });
});
