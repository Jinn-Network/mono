import { describe, expect, it, vi } from 'vitest';
import { createJoinApplier } from '../../src/daemon/join-applier.js';
import { SolverNetRegistry } from '../../src/solver-nets/registry.js';
import { createMutableJoinedSolverNetsView } from '../../src/harnesses/engine/joined-solver-nets-view.js';
import type { JoinedSolverNetConfig } from '../../src/solver-nets/registry.js';

const CID = 'bafyapplier1037';
const joined: JoinedSolverNetConfig = {
  manifestCid: CID,
  name: 'swe-isolated',
  contract: { id: 'swe-rebench-v2', version: 'v1' },
  roles: ['solver'],
  harness: 'codex',
  plugins: [],
  disabledDefaultPlugins: [],
};

function harnessFixture() {
  return {
    name: 'codex',
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: async () => ({ ready: true }),
  };
}

describe('createJoinApplier', () => {
  it('updates all four live surfaces + in-memory config', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const cids: string[] = [];
    const taskDiscovery = { solverNetManifestCids: cids };
    const view = createMutableJoinedSolverNetsView({});
    const registry = new SolverNetRegistry();
    const readiness = new HarnessReadinessRegistry({
      harnessesByName: { codex: harnessFixture() },
      joinedHarnessesByCid: {},
    });
    await readiness.refreshNow();
    const config: { joinedSolverNets?: Record<string, JoinedSolverNetConfig> } = {};

    const applyJoin = createJoinApplier({
      taskDiscovery,
      view,
      readiness,
      registry,
      config,
    });

    await applyJoin(joined);

    // (a) task-discovery cid set
    expect(taskDiscovery.solverNetManifestCids).toEqual([CID]);
    // (b) engine view
    expect(view.get(CID)).toEqual({ roles: ['solver'] });
    // (c) readiness
    expect(readiness.isReadyForClaim(CID).ready).toBe(true);
    // (d) registry
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')?.name).toBe('swe-isolated');
    // in-memory config
    expect(config.joinedSolverNets?.[CID]).toEqual(joined);
  });

  it('does not push the cid for an evaluator-only join (no solver discovery)', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const taskDiscovery = { solverNetManifestCids: [] as string[] };
    const view = createMutableJoinedSolverNetsView({});
    const registry = new SolverNetRegistry();
    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();
    const applyJoin = createJoinApplier({ taskDiscovery, view, readiness, registry, config: {} });

    await applyJoin({ ...joined, roles: ['evaluator'] });

    expect(taskDiscovery.solverNetManifestCids).toEqual([]);
    expect(view.get(CID)).toEqual({ roles: ['evaluator'] });
  });

  it('gives an evaluator-only join carrying a harness a readiness entry (boot parity)', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const taskDiscovery = { solverNetManifestCids: [] as string[] };
    const view = createMutableJoinedSolverNetsView({});
    const registry = new SolverNetRegistry();
    const readiness = new HarnessReadinessRegistry({
      harnessesByName: { codex: harnessFixture() },
      joinedHarnessesByCid: {},
    });
    await readiness.refreshNow();
    const applyJoin = createJoinApplier({ taskDiscovery, view, readiness, registry, config: {} });

    // Evaluator-only join that still carries a harness — the endpoint persists
    // `harness` regardless of role, and boot's readiness builder adds an entry
    // whenever `entry.harness` is truthy (role-agnostic).
    await applyJoin({ ...joined, roles: ['evaluator'], harness: 'codex' });

    const status = readiness.isReadyForClaim(CID);
    expect(status.reason ?? '').not.toContain('not in joinedSolverNets');
    expect(status.ready).toBe(true);
  });

  it('flips the evaluator gate on live for an evaluator-role join, but not for a solver-only join (#547)', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();

    const makeApplier = (enableEvaluator: () => void) =>
      createJoinApplier({
        taskDiscovery: { solverNetManifestCids: [] as string[] },
        view: createMutableJoinedSolverNetsView({}),
        readiness,
        registry: new SolverNetRegistry(),
        config: {},
        enableEvaluator,
      });

    const solverEnable = vi.fn();
    await makeApplier(solverEnable)({ ...joined, roles: ['solver'] });
    expect(solverEnable).not.toHaveBeenCalled();

    const evaluatorEnable = vi.fn();
    await makeApplier(evaluatorEnable)({ ...joined, roles: ['solver', 'evaluator'] });
    expect(evaluatorEnable).toHaveBeenCalledOnce();
  });

  it('is idempotent on the cid set (re-apply does not duplicate)', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const taskDiscovery = { solverNetManifestCids: [] as string[] };
    const readiness = new HarnessReadinessRegistry({
      harnessesByName: { codex: harnessFixture() },
      joinedHarnessesByCid: {},
    });
    await readiness.refreshNow();
    const registry = new SolverNetRegistry();
    const applyJoin = createJoinApplier({
      taskDiscovery,
      view: createMutableJoinedSolverNetsView({}),
      readiness,
      registry,
      config: {},
    });
    await applyJoin(joined);
    await applyJoin(joined);
    expect(taskDiscovery.solverNetManifestCids).toEqual([CID]);
    // Re-apply must not phantom-duplicate the registry entry (boot rebuilds from
    // scratch and never has a duplicate).
    expect(registry.list()).toHaveLength(1);
    expect(registry.list().map((n) => n.name)).toEqual(['swe-isolated']);
    // forSolverType still resolves after the re-apply.
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')?.name).toBe('swe-isolated');
  });
});
