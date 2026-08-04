/**
 * Tests for per-kind implStateDir partitioning.
 *
 * Spec: implStateDirRoot/<impl.name>/<kind> where kind has . and : replaced by _.
 * Two intents with the same kind share a state dir; different kinds get separate dirs.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import { HarnessRegistry } from '../../../src/harnesses/engine/registry.js';
import { SolverNetRegistry, registerJoinedNet } from '../../../src/solver-nets/registry.js';
import { TaskRunPersistence } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, HarnessContext, Solution } from '../../../src/harnesses/types.js';
import { withTempStore } from '@test/store.js';
import { makeIntentInput } from '@test/engine.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'jinn-impls-'));

function makeOpts(
  store: Parameters<TaskEngineOptions['store']['db']['prepare']>[0] extends never ? never : any,
  implRegistry: TaskEngineOptions['implRegistry'],
): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(ROOT, 'work'), implStateDirRoot: join(ROOT, 'impl') },
    implRegistry,
  };
}

function makeRecordingImpl(name: string, supportedKind: string) {
  const received: HarnessContext[] = [];
  const impl: Harness = {
    name,
    version: '0.0.1',
    supports: (s) => s.solverType === supportedKind || supportedKind === '*',
    async run(ctx): Promise<Solution> {
      received.push(ctx);
      return {
        venueRef: { name },
        gating: { ok: true },
        preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        fills: [],
      };
    },
  };
  return { impl, received };
}

async function runToPostPreSnapshot(
  store: any,
  implRegistry: TaskEngineOptions['implRegistry'],
  requestId: string,
  solverType: string,
): Promise<string | null> {
  const engine = new TaskEngine(makeOpts(store, implRegistry));
  const persistence = new TaskRunPersistence(store.db);

  // windowStartTs in the past so dataDrivenAdvance fires immediately.
  const now = Date.now();
  await engine.observe(
    makeIntentInput({ requestId, solverType, windowStartTs: now - 1000, windowEndTs: now + 86_400_000 }),
  );
  persistence.transition(requestId, TaskRunState.CLAIMED);
  persistence.transition(requestId, TaskRunState.WAITING);
  await engine.process(requestId);

  const persisted = persistence.getByRequestId(requestId);
  return persisted?.implStateDir ?? null;
}

describe('engine per-kind implStateDir partitioning', () => {
  it('two intents of the same kind share the same implStateDir', async () => {
    await withTempStore(async (store) => {
      const { impl } = makeRecordingImpl('test-impl', 'prediction.v0');
      const registry = { findFor: (s: { solverType: string }) => (impl.supports(s) ? impl : undefined) };

      const dir1 = await runToPostPreSnapshot(store, registry, 'same-kind-1', 'prediction.v0');
      const dir2 = await runToPostPreSnapshot(store, registry, 'same-kind-2', 'prediction.v0');

      expect(dir1).not.toBeNull();
      expect(dir2).not.toBeNull();
      expect(dir1).toBe(dir2);
    });
  });

  it('two intents of different kinds get separate implStateDirs', async () => {
    await withTempStore(async (store) => {
      const implA = makeRecordingImpl('test-impl', 'prediction.v0').impl;
      const implB = makeRecordingImpl('test-impl', 'portfolio.v0').impl;
      const catchAll: Harness = {
        name: 'test-impl',
        version: '0.0.1',
        supports: (s) => ['prediction.v0', 'portfolio.v0'].includes(s.solverType),
        run: async (ctx): Promise<Solution> => {
          void implA; void implB;
          return {
            venueRef: { name: 'test-impl' },
            gating: { ok: true },
            preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
            postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
            fills: [],
          };
        },
      };
      const registry = { findFor: (s: { solverType: string }) => (catchAll.supports(s) ? catchAll : undefined) };

      const dirPred = await runToPostPreSnapshot(store, registry, 'diff-kind-1', 'prediction.v0');
      const dirPort = await runToPostPreSnapshot(store, registry, 'diff-kind-2', 'portfolio.v0');

      expect(dirPred).not.toBeNull();
      expect(dirPort).not.toBeNull();
      expect(dirPred).not.toBe(dirPort);

      // Both must contain the impl name, then end with the sanitized kind.
      expect(dirPred).toContain('/test-impl/');
      expect(dirPred!.endsWith('/prediction_v0')).toBe(true);
      expect(dirPort).toContain('/test-impl/');
      expect(dirPort!.endsWith('/portfolio_v0')).toBe(true);
    });
  });

  it('sanitizes . and : in kind name', async () => {
    await withTempStore(async (store) => {
      // Use a kind with both . and : to confirm sanitization.
      const { impl } = makeRecordingImpl('test-impl', 'foo:bar.v1');
      const registry = { findFor: (s: { solverType: string }) => (impl.supports(s) ? impl : undefined) };

      const dir = await runToPostPreSnapshot(store, registry, 'sanitize-1', 'foo:bar.v1');

      expect(dir).not.toBeNull();
      expect(dir!.endsWith('/foo_bar_v1')).toBe(true);
      expect(dir).toContain('/test-impl/');
    });
  });

  it('legacy intent with no solverType adds no kind segment (backward-compatible path)', async () => {
    await withTempStore(async (store) => {
      // An impl that matches the empty-kind fallback.
      const { impl } = makeRecordingImpl('fallback-impl', '');
      const registry = { findFor: (s: { solverType: string }) => (s.solverType === '' ? impl : undefined) };

      const engine = new TaskEngine(makeOpts(store, registry));
      const persistence = new TaskRunPersistence(store.db);

      const now = Date.now();
      // solverType undefined → stored as null → implStateName falls back to 'default'
      await engine.observe(makeIntentInput({
        requestId: 'legacy-1',
        solverType: undefined as unknown as string,
        windowStartTs: now - 1000,
        windowEndTs: now + 86_400_000,
      }));
      persistence.transition('legacy-1', TaskRunState.CLAIMED);
      persistence.transition('legacy-1', TaskRunState.WAITING);
      await engine.process('legacy-1');

      const persisted = persistence.getByRequestId('legacy-1');
      // No kind segment — path is <root>/default (solverType was null → fallback name)
      expect(persisted?.implStateDir?.endsWith('/default')).toBe(true);
      // Must NOT have a trailing kind directory.
      expect(persisted?.implStateDir).not.toMatch(/\/default\/.+$/);
    });
  });

  it('two joined SolverNets sharing a solverType get separate implStateDirs, matching the manifest-pinned Harness (issue #2039)', async () => {
    await withTempStore(async (store) => {
      const CID_A = 'bafy-impl-state-dir-a';
      const CID_B = 'bafy-impl-state-dir-b';

      const implRegistry = new HarnessRegistry();
      implRegistry.register(makeRecordingImpl('harness-a', 'prediction.v1').impl);
      implRegistry.register(makeRecordingImpl('harness-b', 'prediction.v1').impl);

      const solverNetRegistry = new SolverNetRegistry();
      // Registered first, so registry-order (solverType-only) dispatch would
      // pick this one by default — exactly the bug this test guards against.
      await registerJoinedNet(solverNetRegistry, CID_A, {
        manifestCid: CID_A,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'harness-a',
        plugins: [],
      });
      await registerJoinedNet(solverNetRegistry, CID_B, {
        manifestCid: CID_B,
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'harness-b',
        plugins: [],
      });

      const engine = new TaskEngine({
        store,
        paths: { workingDirRoot: join(ROOT, 'work'), implStateDirRoot: join(ROOT, 'impl') },
        implRegistry,
        solverNetRegistry,
      });
      const persistence = new TaskRunPersistence(store.db);

      const now = Date.now();
      for (const [requestId, cid] of [['pinned-a', CID_A], ['pinned-b', CID_B]] as const) {
        await engine.observe(makeIntentInput({
          requestId,
          solverType: 'prediction.v1',
          windowStartTs: now - 1000,
          windowEndTs: now + 86_400_000,
          task: {
            id: requestId,
            description: 'test',
            solverType: 'prediction.v1',
            contractId: 'prediction',
            contractVersion: 'v1',
            solverNetManifestCid: cid,
            role: 'restoration',
          },
        }));
        persistence.transition(requestId, TaskRunState.CLAIMED);
        persistence.transition(requestId, TaskRunState.WAITING);
        await engine.process(requestId);
      }

      const dirA = persistence.getByRequestId('pinned-a')?.implStateDir;
      const dirB = persistence.getByRequestId('pinned-b')?.implStateDir;

      expect(dirA).not.toBeNull();
      expect(dirB).not.toBeNull();
      expect(dirA).not.toBe(dirB);
      expect(dirA).toContain('/harness-a/');
      expect(dirB).toContain('/harness-b/');
    });
  });
});
