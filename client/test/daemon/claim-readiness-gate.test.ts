// client/test/daemon/claim-readiness-gate.test.ts
//
// Regression: the daemon must not claim tasks against a SolverNet whose
// harness reports not-ready. A fresh operator who joined SWE-rebench v2
// without installing/authing Hermes would otherwise burn failed claims —
// every claim landed because the gate was wired but `HermesHarness` had no
// `isReady()`, so the registry treated it as always-ready.
//
// The test spins up a real `Daemon` against a `LocalAdapter`, posts a task
// whose `solverNetManifestCid` matches a joined entry, and verifies the
// claim path observes a not-ready harness and skips. The reverse path
// (registry transitions to ready → claims resume) is also covered.
//
// Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
// Task 16): the solution path retired — `_runEngineWatcherLoop` now skips any
// announcement whose task.role isn't 'evaluation' before it ever reaches the
// readiness gate this suite pins. Every posted task below now carries
// `role: 'evaluation'` so the announcement still reaches the gate under test;
// the gate itself is harness-agnostic and unchanged.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { PREDICTION_V1_SOLVER_NET_CONTRACT } from '../../src/solver-nets/contracts.js';
import { SolverNetRegistry } from '../../src/solver-nets/registry.js';
import {
  _resetReadinessGateMemoForTests,
} from '../../src/daemon/readiness-gate.js';
import type { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-daemon-readiness-test-'));
  const implRegistry = new HarnessRegistry({ default: 'legacy-claude' });
  const solverNetRegistry = new SolverNetRegistry();
  for (const manifestCid of ['bafkrei.fake-cid', 'bafkrei.codex-cid']) {
    solverNetRegistry.register({
      name: manifestCid,
      manifestCid,
      enabled: true,
      solverType: 'prediction.v1',
      // Cutover stage 1 (see the file-level comment above): every posted
      // task now carries role: 'evaluation', so the fixture registers both
      // operator roles rather than narrowing to 'solving' only.
      roles: ['solving', 'evaluating'],
      contract: PREDICTION_V1_SOLVER_NET_CONTRACT,
      harness: 'legacy-claude',
      runtimePlugins: [],
      taskGenerator: { enabled: false },
    });
  }
  return {
    implRegistry,
    solverNetRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

/** Fake registry that returns whatever the controllable callback says. */
function controlledRegistry(getReady: () => { ready: boolean; reason?: string }) {
  return {
    isReadyForClaim: vi.fn(() => getReady()),
    getSnapshot: vi.fn(() => ({ lastRefreshedAt: '', harnesses: [] })),
    refreshNow: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as HarnessReadinessRegistry;
}

beforeEach(() => {
  _resetReadinessGateMemoForTests();
});

describe('Daemon — claim readiness gate', () => {
  it('does NOT call adapter.claimTask when registry reports the harness not ready', async () => {
    const adapter = new LocalAdapter();
    const claimSpy = vi.spyOn(adapter, 'claimTask');

    const registry = controlledRegistry(() => ({
      ready: false,
      reason: 'hermes binary not installed',
    }));

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (d) => `done: ${d}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
      harnessReadinessRegistry: registry,
    });
    await daemon.start();

    // Post a task carrying a manifestCid so the gate path activates.
    await adapter.postTask({
      id: 'task-not-ready',
      description: 'should be skipped',
      solverNetManifestCid: 'bafkrei.fake-cid',
      role: 'evaluation',
    });

    // Give the engine-watcher loop a few ticks to observe the announcement.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(registry.isReadyForClaim).toHaveBeenCalledWith('bafkrei.fake-cid');
    expect(claimSpy).not.toHaveBeenCalled();

    await daemon.stop();
  });

  it('claims when registry transitions from not-ready to ready', async () => {
    const adapter = new LocalAdapter();
    const claimSpy = vi.spyOn(adapter, 'claimTask');

    // Flip from not-ready to ready between announcements.
    let ready = false;
    const registry = controlledRegistry(() =>
      ready
        ? { ready: true }
        : { ready: false, reason: 'hermes binary not installed' },
    );

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (d) => `done: ${d}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
      harnessReadinessRegistry: registry,
    });
    await daemon.start();

    // Round 1 — not ready, no claim.
    await adapter.postTask({
      id: 'task-skip-1',
      description: 'first task — gate not ready',
      solverNetManifestCid: 'bafkrei.fake-cid',
      role: 'evaluation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimSpy).not.toHaveBeenCalled();

    // Round 2 — flip to ready, post a fresh task, expect a claim.
    ready = true;
    await adapter.postTask({
      id: 'task-claim-2',
      description: 'second task — gate ready',
      solverNetManifestCid: 'bafkrei.fake-cid',
      role: 'evaluation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claimSpy).toHaveBeenCalled();
    const args = claimSpy.mock.calls[0]!;
    expect(args[0]).toBe('2');  // LocalAdapter assigns sequential string ids

    await daemon.stop();
  });

  it('does NOT claim for a Codex SolverNet when the codex harness reports not ready', async () => {
    // Same-shape regression as the Hermes case above: a Codex-harness
    // SolverNet whose `codex` CLI is missing must not have tasks claimed
    // against it. The gate is harness-agnostic — it reads whatever reason
    // the registry surfaces — so a codex-flavoured not-ready reason must
    // block claims exactly as the hermes one does.
    const adapter = new LocalAdapter();
    const claimSpy = vi.spyOn(adapter, 'claimTask');

    const registry = controlledRegistry(() => ({
      ready: false,
      reason: 'codex binary not installed',
    }));

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (d) => `done: ${d}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
      harnessReadinessRegistry: registry,
    });
    await daemon.start();

    await adapter.postTask({
      id: 'task-codex-not-ready',
      description: 'codex SolverNet — gate not ready',
      solverNetManifestCid: 'bafkrei.codex-cid',
      role: 'evaluation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(registry.isReadyForClaim).toHaveBeenCalledWith('bafkrei.codex-cid');
    expect(claimSpy).not.toHaveBeenCalled();

    await daemon.stop();
  });

  it('does NOT claim when Hermes reports OpenRouter not connected', async () => {
    // `hermes doctor` exits 0 even when every model provider is logged out, so
    // HermesHarness.isReady() also gates on OpenRouter auth. The gate is
    // harness-agnostic — it just reads the reason — so an "OpenRouter not
    // connected" not-ready must block claims exactly like the missing-binary
    // case.
    const adapter = new LocalAdapter();
    const claimSpy = vi.spyOn(adapter, 'claimTask');

    const registry = controlledRegistry(() => ({
      ready: false,
      reason: 'OpenRouter not connected — Hermes has no usable model provider',
    }));

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (d) => `done: ${d}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
      harnessReadinessRegistry: registry,
    });
    await daemon.start();

    await adapter.postTask({
      id: 'task-hermes-no-openrouter',
      description: 'hermes SolverNet — OpenRouter not connected',
      solverNetManifestCid: 'bafkrei.fake-cid',
      role: 'evaluation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(registry.isReadyForClaim).toHaveBeenCalledWith('bafkrei.fake-cid');
    expect(claimSpy).not.toHaveBeenCalled();

    await daemon.stop();
  });

  it('surfaces the not-ready reason via a warn log on first transition', async () => {
    const adapter = new LocalAdapter();

    const registry = controlledRegistry(() => ({
      ready: false,
      reason: 'hermes doctor exit 1: provider not configured',
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (d) => `done: ${d}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
      harnessReadinessRegistry: registry,
    });
    await daemon.start();

    await adapter.postTask({
      id: 'task-log',
      description: 'gate skip with operator-visible reason',
      solverNetManifestCid: 'bafkrei.fake-cid',
      role: 'evaluation',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const matched = warnSpy.mock.calls.some((call) => {
      const msg = String(call[0] ?? '');
      return msg.includes('hermes doctor exit 1') && msg.includes('skipping');
    });
    expect(matched).toBe(true);

    warnSpy.mockRestore();
    await daemon.stop();
  });
});
