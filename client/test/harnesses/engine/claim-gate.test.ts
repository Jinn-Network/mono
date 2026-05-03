import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../../../src/store/store.js';
import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import type { PersistedTaskRun, PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, Solution, ReadyStatus } from '../../../src/harnesses/types.js';

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

function makeInput(id = 'req-gate'): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: id,
    taskCid: 'bafy',
    onchainCreationTx: '0xtx' as `0x${string}`,
    onchainCreationBlock: 1,
    solverType: 'portfolio.v0',
    windowStartTs: now + 1000,
    windowEndTs: now + 60_000,
    task: { id, description: 'test' },
  };
}

class TestEngine extends TaskEngine {
  async callClaim(intent: PersistedTaskRun): Promise<void> {
    return this.claim(intent);
  }
  get db(): import('../../../src/harnesses/engine/persistence.js').TaskRunPersistence {
    return this.persistence;
  }
}

describe('TaskEngine.claim — impl gate', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-claim-gate-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to claim when no impl is registered for the intent\'s kind', async () => {
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => undefined },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await expect(engine.callClaim(persisted)).rejects.toThrow(/no Harness registered or enabled/);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.FAILED);
    expect(after.failureReason).toMatch(/jinn solver-nets set-harness <name> <harness>/);
  });

  it('refuses to claim when impl reports not-ready', async () => {
    const notReadyImpl = stubImpl({
      isReady: async (ctx) => {
        expect(ctx).toEqual({ solverType: 'portfolio.v0', role: 'restoration' });
        return {
          ready: false,
          reason: 'api-wallet not approved',
          nextStep: { description: 'do the thing', cli: 'jinn solver-nets enable portfolio --confirm-approved' },
        };
      },
    });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => notReadyImpl },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await expect(engine.callClaim(persisted)).rejects.toThrow(/not ready/);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.FAILED);
    expect(after.failureReason).toMatch(/api-wallet not approved/);
    expect(after.failureReason).toMatch(/jinn solver-nets enable portfolio --confirm-approved/);
  });

  it('proceeds with claim when impl is registered and ready', async () => {
    const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      implRegistry: { findFor: () => readyImpl },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await engine.callClaim(persisted);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.CLAIMED);
  });

  it('does not gate when implRegistry is absent (legacy test-mode path)', async () => {
    const engine = new TestEngine({
      store,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      // No implRegistry — gate must no-op so raw claim path works.
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await engine.callClaim(persisted);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(TaskRunState.CLAIMED);
  });
});
