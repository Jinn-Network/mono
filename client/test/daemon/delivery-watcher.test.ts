import { describe, it, expect, vi } from 'vitest';
import { DeliveryWatcherLoop } from '../../src/daemon/delivery-watcher.js';
import type { ExecutionAdapter } from '../../src/adapters/adapter.js';
import type { DeliveredResult, Task } from '../../src/types/index.js';
import { Store } from '../../src/store/store.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid SignedEnvelope JSON for portfolio.v0 restoration. */
function makeSignedEnvelopeJson(overrides?: Partial<Record<string, unknown>>): string {
  const base: Record<string, unknown> = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'portfolio.v0',
    role: 'restoration',
    generatedAt: 1700000000000,
    task: {
      cid: 'bafy-task',
      onchainCreationTx: '0x' + 'ab'.repeat(32),
      onchainCreationBlock: 100,
      requestId: '0x' + 'cd'.repeat(32),
    },
    participant: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'claude-mcp-hyperliquid',
      implVersion: '1.0.0',
      clientGitSha: 'abc123',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      runtimeBundleDigest: 'sha256:' + 'cd'.repeat(32),
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: '0x2222222222222222222222222222222222222222' },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {
      preSnapshot: { capturedAt: 1, hlTime: 1, payload: {} },
      postSnapshot: { capturedAt: 2, hlTime: 2, payload: {} },
      fills: [],
      gating: {
        equityReturnPct: '0.05',
        maxDrawdownPct: '0.01',
        closedTradesCount: 25,
        tradedNotionalMultiple: '5.1',
      },
    },
    signature: {
      algo: 'secp256k1',
      signer: '0x2222222222222222222222222222222222222222',
      hash: '0x' + 'ef'.repeat(32),
      sig: '0x' + '12'.repeat(65),
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

function makeDelivery(resultData: string, requestId = 'req-001'): DeliveredResult {
  const job: Task = { id: requestId, description: 'test', role: 'restoration' };
  return {
    requestId,
    task: job,
    result: { data: resultData },
    deliveryMechAddress: '0xmech',
  };
}

/**
 * A delivery whose `task` carries NO `role` — mirrors the engine-recovery
 * self-delivery path where the adapter yields a task rebuilt from a map lost
 * across restart, so `task.role` is undefined (issue #575).
 */
function makeRolelessDelivery(resultData: string, requestId = 'req-001'): DeliveredResult {
  const job: Task = { id: requestId, description: 'test' };
  return {
    requestId,
    task: job,
    result: { data: resultData },
    deliveryMechAddress: '0xmech',
  };
}

/**
 * Build an adapter whose watchForDeliveries yields the supplied deliveries
 * then stops. The loop is signalled to stop after the generator exhausts
 * by calling onDone() — which is a hook that callers inject.
 */
function makeStubAdapter(
  deliveries: DeliveredResult[],
  onDone?: () => void,
): ExecutionAdapter {
  return {
    name: 'stub',
    initialize: vi.fn(),
    postTask: vi.fn().mockResolvedValue({ taskId: 'task-1', taskCid: 'local-task-1' }),
    watchForTasks: async function* () { /* no-op */ },
    claimTask: vi.fn().mockResolvedValue({
      requestId: 'req-001',
      taskId: 'task-1',
      attemptIndex: 0,
      task: { id: 'task-1', description: 'test' },
    }),
    submitResult: vi.fn(),
    watchForDeliveries: async function* () {
      for (const d of deliveries) yield d;
      onDone?.();
    },
    stop: vi.fn(),
  } satisfies ExecutionAdapter;
}

/**
 * Run the watcher loop, collecting console.error calls, then stop it.
 * The adapter's generator must call loop.stop() (via onDone) to allow
 * run() to exit the outer while loop.
 */
async function runAndCollectLogs(
  resultData: string,
): Promise<{ errors: string[]; threw: boolean }> {
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(a => String(a)).join(' '));
  };

  let threw = false;
  let loop!: DeliveryWatcherLoop;
  const delivery = makeDelivery(resultData);
  const adapter = makeStubAdapter([delivery], () => loop.stop());
  loop = new DeliveryWatcherLoop(adapter);

  try {
    await loop.run();
  } catch {
    threw = true;
  } finally {
    console.error = origErr;
  }

  return { errors, threw };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DeliveryWatcherLoop envelope parsing', () => {
  it('processes a valid jinn.execution.v1 envelope without throwing', async () => {
    const { threw } = await runAndCollectLogs(makeSignedEnvelopeJson());
    expect(threw).toBe(false);
  });

  it('logs "envelope ok" for a valid envelope', async () => {
    const { errors } = await runAndCollectLogs(makeSignedEnvelopeJson());
    expect(errors.some(e => e.includes('envelope ok'))).toBe(true);
  });

  it('processes a valid verdict-role envelope', async () => {
    const verdictData = makeSignedEnvelopeJson({
      role: 'verdict',
      payload: {
        restorationEnvelope: { cid: 'bafy-rest', sha256: '0'.repeat(64) },
        verificationOfRestoration: {
          claimedTier: 'self-signed',
          sdkVersion: '0.0.0-stub',
          timestamp: 1700000000000,
          checks: [{ name: 'sig', passed: true }],
          overall: 'valid',
        },
        verdict: 'PASS',
        score: '0.95',
        scoreBasis: 'equityReturnPct',
        scoreVersion: '1',
        rederived: {
          preSnapshot: { capturedAt: 1, payload: {} },
          postSnapshot: { capturedAt: 2, payload: {} },
          fills: [],
          gating: {},
        },
        claimed: {
          preSnapshot: { capturedAt: 1, payload: {} },
          postSnapshot: { capturedAt: 2, payload: {} },
          fillsHash: '0xff',
          fillsCount: 0,
          gating: {},
        },
        checks: [{ name: 'availability.x', status: 'PASS' }],
      },
    });
    const { threw } = await runAndCollectLogs(verdictData);
    expect(threw).toBe(false);
  });

  it('skips and logs error for envelope with invalid shape (missing required fields)', async () => {
    const invalidEnvelope = JSON.stringify({
      schemaVersion: 'jinn.execution.v1',
      solverType: 'portfolio.v0',
      role: 'restoration',
      // missing required fields — should fail SignedEnvelopeSchema.parse
    });
    const { threw, errors } = await runAndCollectLogs(invalidEnvelope);
    expect(threw).toBe(false);
    expect(errors.some(e => e.includes('envelope parse/validate failed'))).toBe(true);
  });

  it('skips and logs error for envelope with unknown solverType (validatePayload fails)', async () => {
    const unknownKind = makeSignedEnvelopeJson({ solverType: 'unknown.kind.v99' });
    const { threw, errors } = await runAndCollectLogs(unknownKind);
    expect(threw).toBe(false);
    expect(errors.some(e => e.includes('envelope parse/validate failed'))).toBe(true);
  });

  it('handles legacy non-JSON result.data gracefully (falls through to normal handling)', async () => {
    const { threw, errors } = await runAndCollectLogs('legacy plain text result');
    expect(threw).toBe(false);
    // Should process the delivery normally (no envelope error logged)
    expect(errors.some(e => e.includes('envelope parse/validate failed'))).toBe(false);
    expect(errors.some(e => e.includes('Processed'))).toBe(true);
  });

  it('handles legacy JSON without schemaVersion gracefully (falls through)', async () => {
    const legacyPayload = JSON.stringify({
      requestId: 'req-legacy',
      data: 'some result data',
      artifacts: [],
    });
    const { threw, errors } = await runAndCollectLogs(legacyPayload);
    expect(threw).toBe(false);
    expect(errors.some(e => e.includes('envelope parse/validate failed'))).toBe(false);
    expect(errors.some(e => e.includes('Processed'))).toBe(true);
  });

  it('does not log "envelope ok" for deliveries without schemaVersion', async () => {
    const { errors } = await runAndCollectLogs(JSON.stringify({ data: 'result', requestId: '1' }));
    expect(errors.some(e => e.includes('envelope ok'))).toBe(false);
  });

  it('processes multiple deliveries: valid first, invalid second — no throw', async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => String(a)).join(' '));
    };

    let threw = false;
    let loop!: DeliveryWatcherLoop;
    const deliveries = [
      makeDelivery(makeSignedEnvelopeJson(), 'req-valid'),
      makeDelivery(JSON.stringify({ schemaVersion: 'jinn.execution.v1', bad: true }), 'req-invalid'),
    ];
    const adapter = makeStubAdapter(deliveries, () => loop.stop());
    loop = new DeliveryWatcherLoop(adapter);

    try {
      await loop.run();
    } catch {
      threw = true;
    } finally {
      console.error = origErr;
    }

    expect(threw).toBe(false);
    expect(errors.some(e => e.includes('envelope ok'))).toBe(true);
    expect(errors.some(e => e.includes('envelope parse/validate failed'))).toBe(true);
  });
});

describe('DeliveryWatcherLoop self-delivery role resolution (issue #575)', () => {
  /**
   * Run the watcher against a single delivery with a real Store, returning the
   * collected console.error lines. The role on the delivery's `task` is left as
   * the caller supplied (use makeRolelessDelivery for the recovery path).
   */
  async function runWithStore(
    delivery: DeliveredResult,
    store: Store,
  ): Promise<string[]> {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => String(a)).join(' '));
    };

    let loop!: DeliveryWatcherLoop;
    const adapter = makeStubAdapter([delivery], () => loop.stop());
    loop = new DeliveryWatcherLoop(adapter, store);

    try {
      await loop.run();
    } finally {
      console.error = origErr;
    }
    return errors;
  }

  function seedTaskRun(
    store: Store,
    requestId: string,
    taskRole: 'restoration' | 'evaluation',
  ): void {
    const p = new TaskRunPersistence(store.db);
    p.insertDiscovered({
      requestId,
      taskCid: 'bafy-seed',
      onchainCreationTx: '0xseed',
      onchainCreationBlock: 1,
      solverType: 'portfolio.v0',
      taskRole,
      windowStartTs: Date.now(),
      windowEndTs: Date.now() + 86_400_000,
      task: { id: requestId, description: 'test', role: taskRole },
    });
  }

  it('Test A: resolves a recovered restoration self-delivery role from task_runs', async () => {
    const store = new Store(':memory:');
    try {
      seedTaskRun(store, 'req-575-a', 'restoration');
      const errors = await runWithStore(
        makeRolelessDelivery('legacy plain text result', 'req-575-a'),
        store,
      );
      expect(errors.some(e => e.includes('Processed restoration delivery'))).toBe(true);
      expect(errors.some(e => e.includes('Processed unknown delivery'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('Test B: resolves a recovered evaluation self-delivery role from task_runs', async () => {
    const store = new Store(':memory:');
    try {
      seedTaskRun(store, 'req-575-b', 'evaluation');
      const errors = await runWithStore(
        makeRolelessDelivery('legacy plain text result', 'req-575-b'),
        store,
      );
      expect(errors.some(e => e.includes('Processed evaluation delivery'))).toBe(true);
      expect(errors.some(e => e.includes('Processed unknown delivery'))).toBe(false);

      // The resolved role must also classify the emitted event as evaluation.
      const kinds = store.db
        .prepare('SELECT kind FROM activity_events WHERE request_id = ?')
        .all('req-575-b') as Array<{ kind: string }>;
      expect(kinds.some(k => k.kind === 'evaluation_submitted')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('Test C: still logs "unknown" when no task_runs row exists', async () => {
    const store = new Store(':memory:');
    try {
      // No seedTaskRun — the requestId is genuinely unknown.
      const errors = await runWithStore(
        makeRolelessDelivery('legacy plain text result', 'req-575-c'),
        store,
      );
      expect(errors.some(e => e.includes('Processed unknown delivery'))).toBe(true);
    } finally {
      store.close();
    }
  });
});
