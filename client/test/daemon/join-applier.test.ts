import { describe, expect, it, vi } from 'vitest';
import { createJoinApplier } from '../../src/daemon/join-applier.js';
import { SolverNetRegistry } from '../../src/solver-nets/registry.js';
import { createMutableJoinedSolverNetsView } from '../../src/harnesses/engine/engine.js';
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
  it('updates all five live surfaces + in-memory config', async () => {
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

    const learnerRouting = { solverTypes: [] as string[] };

    const applyJoin = createJoinApplier({
      taskDiscovery,
      view,
      learnerRouting,
      readiness,
      registry,
      config,
    });

    await applyJoin(joined);

    // (a) task-discovery cid set
    expect(taskDiscovery.solverNetManifestCids).toEqual([CID]);
    // (a2) learner routing allowlist
    expect(learnerRouting.solverTypes).toEqual(['swe-rebench-v2.v1']);
    // (b) engine view
    expect(view.get(CID)).toEqual({ roles: ['solver'] });
    // (c) readiness
    expect(readiness.isReadyForClaim(CID).ready).toBe(true);
    // (d) registry
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')?.name).toBe('swe-isolated');
    // in-memory config
    expect(config.joinedSolverNets?.[CID]).toEqual(joined);
  });

  it('makes a live join claimable by the learner without a restart', async () => {
    // The end-to-end assertion behind (a2). Since C6 the learner claims only the
    // SolverTypes it is routed to, so a hot join that updates discovery,
    // eligibility, readiness, and the registry but NOT routing lands a task no
    // harness will take — a stall that looks like a marketplace problem.
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
    const { NoOpHarnessAdapter } = await import(
      '../../src/harnesses/impls/learner/test-utils/noop-adapter.js'
    );

    // Exactly what main.ts hands both LearnerHarness instances and the applier:
    // one mutable array, shared by reference.
    const learnerRouting = { solverTypes: [] as string[] };
    const learnerHarness = new LearnerHarness({
      adapter: new NoOpHarnessAdapter(),
      pluginRoot: '/tmp/plugin-root',
      routing: learnerRouting,
    });

    expect(learnerHarness.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(false);

    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();
    await createJoinApplier({
      taskDiscovery: { solverNetManifestCids: [] as string[] },
      view: createMutableJoinedSolverNetsView({}),
      learnerRouting,
      readiness,
      registry: new SolverNetRegistry(),
      config: {},
    })(joined);

    expect(learnerHarness.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
    // Evaluation still routes elsewhere — a join never widens the role gate.
    expect(learnerHarness.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('does not widen routing for an evaluator-only join', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const learnerRouting = { solverTypes: [] as string[] };
    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();

    await createJoinApplier({
      taskDiscovery: { solverNetManifestCids: [] as string[] },
      view: createMutableJoinedSolverNetsView({}),
      learnerRouting,
      readiness,
      registry: new SolverNetRegistry(),
      config: {},
    })({ ...joined, roles: ['evaluator'] });

    expect(learnerRouting.solverTypes).toEqual([]);
  });

  it('leaves an operator-pinned allowlist alone (learnerRouting: null)', async () => {
    // Boot ignores joined nets entirely when the operator pinned an explicit
    // allowlist. Widening it live would make the running daemon route
    // differently from the same config after a restart.
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
    const { NoOpHarnessAdapter } = await import(
      '../../src/harnesses/impls/learner/test-utils/noop-adapter.js'
    );
    const pinned = { solverTypes: ['portfolio.v0'] };
    const learnerHarness = new LearnerHarness({
      adapter: new NoOpHarnessAdapter(),
      pluginRoot: '/tmp/plugin-root',
      routing: pinned,
    });
    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();

    await createJoinApplier({
      taskDiscovery: { solverNetManifestCids: [] as string[] },
      view: createMutableJoinedSolverNetsView({}),
      learnerRouting: null,
      readiness,
      registry: new SolverNetRegistry(),
      config: {},
    })(joined);

    expect(pinned.solverTypes).toEqual(['portfolio.v0']);
    expect(learnerHarness.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(false);
  });

  it('skips an entry with no contract — no SolverType to route, mirroring boot', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const learnerRouting = { solverTypes: [] as string[] };
    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();
    const { contract: _omitted, ...withoutContract } = joined;

    await createJoinApplier({
      taskDiscovery: { solverNetManifestCids: [] as string[] },
      view: createMutableJoinedSolverNetsView({}),
      learnerRouting,
      readiness,
      registry: new SolverNetRegistry(),
      config: {},
    })(withoutContract);

    expect(learnerRouting.solverTypes).toEqual([]);
  });

  it('does not push the cid for an evaluator-only join (no solver discovery)', async () => {
    const { HarnessReadinessRegistry } = await import('../../src/harnesses/readiness-registry.js');
    const taskDiscovery = { solverNetManifestCids: [] as string[] };
    const view = createMutableJoinedSolverNetsView({});
    const registry = new SolverNetRegistry();
    const readiness = new HarnessReadinessRegistry({ harnessesByName: {}, joinedHarnessesByCid: {} });
    await readiness.refreshNow();
    const applyJoin = createJoinApplier({ taskDiscovery, view, learnerRouting: null, readiness, registry, config: {} });

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
    const applyJoin = createJoinApplier({ taskDiscovery, view, learnerRouting: null, readiness, registry, config: {} });

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
        learnerRouting: null,
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
    const learnerRouting = { solverTypes: [] as string[] };
    const applyJoin = createJoinApplier({
      taskDiscovery,
      view: createMutableJoinedSolverNetsView({}),
      learnerRouting,
      readiness,
      registry,
      config: {},
    });
    await applyJoin(joined);
    await applyJoin(joined);
    expect(taskDiscovery.solverNetManifestCids).toEqual([CID]);
    expect(learnerRouting.solverTypes).toEqual(['swe-rebench-v2.v1']);
    // Re-apply must not phantom-duplicate the registry entry (boot rebuilds from
    // scratch and never has a duplicate).
    expect(registry.list()).toHaveLength(1);
    expect(registry.list().map((n) => n.name)).toEqual(['swe-isolated']);
    // forSolverType still resolves after the re-apply.
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')?.name).toBe('swe-isolated');
  });
});
