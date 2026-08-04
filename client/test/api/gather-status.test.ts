import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JinnConfig } from '../../src/config.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import type { PredictionOperatorStatus } from '../../src/solver-nets/prediction-operator-ux.js';
import { withTempStore } from '@test/store.js';

describe('gatherStatusForApi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.doUnmock('../../src/solver-nets/prediction-operator-ux.js');
    vi.resetModules();
  });

  function mockStatusRpc(): void {
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: () => ({
          getBlockNumber: async () => {
            throw new Error('rpc unavailable');
          },
          getChainId: async () => 84532,
          getBalance: async () => 0n,
          readContract: async () => 0n,
        }),
        http: () => ({}),
      };
    });
  }

  it('keeps core status available when prediction lifecycle rows cannot be read', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      persistence.insertDiscovered({
        requestId: 'bad-prediction-row',
        taskId: 'prediction-task',
        taskCid: 'bafy-bad-prediction-row',
        onchainCreationTx: '0xbad',
        onchainCreationBlock: 1,
        solverType: 'prediction.v1',
        taskRole: 'restoration',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: {
          id: 'prediction-task',
          description: 'bad prediction row',
          solverType: 'prediction.v1',
          role: 'restoration',
        },
      });
      store.db.prepare(
        `UPDATE task_runs
         SET task_payload = ?
         WHERE request_id = ?`,
      ).run('{', 'bad-prediction-row');

      const status = await gatherStatusForApi(store, undefined);

      expect(status.statusMode).toBe('sqlite_only');
      expect(status.predictionV1?.operator).toBeNull();
      expect(status.predictionV1?.operatorError).toMatch(/Prediction lifecycle unavailable/);
      expect(status.predictionV1?.totals).toEqual({
        observedTasks: 0,
        activeTaskRuns: 0,
        solutions: 0,
        verdicts: 0,
        failed: 0,
        settledFailed: 0,
        localErrors: 0,
        raceLost: 0,
      });
    });
  });

  it('reuses cached Prediction operator diagnostics for repeated status polls', async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async (): Promise<PredictionOperatorStatus> => ({
      kind: 'prediction.v1.operatorStatus',
      ok: true,
      configPath: '/tmp/config.json',
      solverNet: {
        name: 'prediction',
        enabled: true,
        solverType: 'prediction.v1',
        roles: ['solving'],
        harness: 'prediction-v1-baseline',
        taskGeneratorEnabled: true,
      },
      runtimePlugins: [],
      diagnostics: [],
      nextAction: { description: 'Run', cli: 'jinn run' },
    }));
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;

    await withTempStore(async (store) => {
      const status = {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config,
        configPath: '/tmp/config.json',
      };

      await gatherStatusForApi(store, status);
      await gatherStatusForApi(store, status);
    });

    expect(buildPredictionOperatorStatus).toHaveBeenCalledTimes(1);
  });

  it('exposes generic task-run status for active non-prediction work', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      persistence.insertDiscovered({
        requestId: 'swe-request-1',
        taskId: '15',
        taskCid: 'bafy-swe-task',
        onchainCreationTx: '0xabc',
        onchainCreationBlock: 1,
        solverType: 'swe-rebench-v2.v1',
        taskRole: 'restoration',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: {
          id: 'swe-task',
          description: 'SWE-rebench task',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
        },
      });
      store.db.prepare(
        `UPDATE task_runs
         SET state = 'RUNNING',
             state_updated_at = ?
         WHERE request_id = ?`,
      ).run(1_500, 'swe-request-1');

      const status = await gatherStatusForApi(store, undefined);

      expect(status.taskRuns?.totals.activeTaskRuns).toBe(1);
      expect(status.taskRuns?.inFlight[0]).toMatchObject({
        requestId: 'swe-request-1',
        taskId: '15',
        solverType: 'swe-rebench-v2.v1',
        state: 'RUNNING',
        taskRole: 'restoration',
      });
      expect(status.predictionV1?.totals.activeTaskRuns).toBe(0);
    });
  });

  it('enriches COMPLETE solve run outcomes from discovery.getVerdictTallies (#502)', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      persistence.insertDiscovered({
        requestId: 'swe-complete',
        taskId: '42',
        taskCid: 'bafy-swe-complete',
        onchainCreationTx: '0xabc',
        onchainCreationBlock: 1,
        solverType: 'swe-rebench-v2.v1',
        taskRole: 'restoration',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: {
          id: 'swe-complete',
          description: 'SWE task',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
        },
      });
      store.db.prepare(
        `UPDATE task_runs SET state = 'COMPLETE', state_updated_at = ? WHERE request_id = ?`,
      ).run(2_500, 'swe-complete');

      const getVerdictTallies = vi.fn(async () =>
        new Map([['42', { pass: 0, fail: 2 }]]),
      );
      const discovery = { getVerdictTallies } as unknown as import('../../src/discovery/types.js').DiscoveryAPI;

      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        discovery,
      });

      expect(getVerdictTallies).toHaveBeenCalledWith({ taskIds: ['42'] });
      const row = status.taskRuns?.recentTasks.find((r) => r.requestId === 'swe-complete');
      expect(row?.outcome).toBe('fail');
    });
  });

  it('leaves outcome null when no discovery is supplied (#502)', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      persistence.insertDiscovered({
        requestId: 'swe-complete-nodisc',
        taskId: '43',
        taskCid: 'bafy-swe-complete-nodisc',
        onchainCreationTx: '0xabc',
        onchainCreationBlock: 1,
        solverType: 'swe-rebench-v2.v1',
        taskRole: 'restoration',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: {
          id: 'swe-complete-nodisc',
          description: 'SWE task',
          solverType: 'swe-rebench-v2.v1',
          role: 'restoration',
        },
      });
      store.db.prepare(
        `UPDATE task_runs SET state = 'COMPLETE', state_updated_at = ? WHERE request_id = ?`,
      ).run(2_500, 'swe-complete-nodisc');

      const status = await gatherStatusForApi(store, undefined);
      const row = status.taskRuns?.recentTasks.find((r) => r.requestId === 'swe-complete-nodisc');
      expect(row?.outcome).toBeNull();
    });
  });

  it('caches Prediction operator diagnostic failures for repeated status polls', async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async () => {
      throw new Error('plugin hash failed');
    });
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;

    await withTempStore(async (store) => {
      const status = {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config,
        configPath: '/tmp/config.json',
      };

      const first = await gatherStatusForApi(store, status);
      const second = await gatherStatusForApi(store, status);

      expect(first.predictionV1?.operator?.ok).toBe(false);
      expect(first.predictionV1?.operator?.diagnostics[0]?.message).toBe('plugin hash failed');
      expect(second.predictionV1?.operator?.diagnostics[0]?.message).toBe('plugin hash failed');
    });

    expect(buildPredictionOperatorStatus).toHaveBeenCalledTimes(1);
  });

  it("omits 'launching' from operator.solverNet.roles", async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async (): Promise<PredictionOperatorStatus> => ({
      kind: 'prediction.v1.operatorStatus',
      ok: true,
      configPath: '/tmp/config.json',
      solverNet: {
        name: 'prediction',
        enabled: true,
        solverType: 'prediction.v1',
        // Source returns the full operator-role array (includes launching).
        roles: ['solving', 'launching'],
        harness: 'prediction-v1-baseline',
        taskGeneratorEnabled: true,
      },
      runtimePlugins: [],
      diagnostics: [],
      nextAction: { description: 'Run', cli: 'jinn run' },
    }));
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;

    await withTempStore(async (store) => {
      const apiStatus = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config,
        configPath: '/tmp/config.json',
      });

      expect(apiStatus.predictionV1?.operator?.solverNet?.roles).toEqual(['solving']);
    });
  });

  it("returns empty operator.solverNet.roles when only 'launching' is enabled", async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async (): Promise<PredictionOperatorStatus> => ({
      kind: 'prediction.v1.operatorStatus',
      ok: true,
      configPath: '/tmp/config.json',
      solverNet: {
        name: 'prediction',
        enabled: true,
        solverType: 'prediction.v1',
        roles: ['launching'],
        harness: 'prediction-v1-baseline',
        taskGeneratorEnabled: true,
      },
      runtimePlugins: [],
      diagnostics: [],
      nextAction: { description: 'Run', cli: 'jinn run' },
    }));
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      // Operator config no longer carries the 'launching' role (issue #421);
      // an empty joinedSolverNets is the modern analogue of "launching-only".
      joinedSolverNets: {},
    } as unknown as JinnConfig;

    await withTempStore(async (store) => {
      const apiStatus = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config,
        configPath: '/tmp/config.json',
      });

      expect(apiStatus.predictionV1?.operator?.solverNet?.roles).toEqual([]);
    });
  });

  it('derives SolverNet name from joinedSolverNets when solverNets is empty (jinn-mono-hjex.2)', async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async (): Promise<PredictionOperatorStatus> => ({
      kind: 'prediction.v1.operatorStatus',
      ok: true,
      configPath: '/tmp/config.json',
      solverNet: {
        name: 'SWE-rebench v2',
        enabled: true,
        solverType: 'prediction.v1',
        roles: ['solving'],
        harness: 'claude-code',
        taskGeneratorEnabled: false,
      },
      runtimePlugins: [],
      diagnostics: [],
      nextAction: { description: 'Run', cli: 'jinn run' },
    }));
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      joinedSolverNets: {
        'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi': {
          manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
          name: 'SWE-rebench v2',
          roles: ['solver'],
          harness: 'claude-code',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;

    await withTempStore(async (store) => {
      await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config,
        configPath: '/tmp/config.json',
      });
    });

    // gather-status must have called buildPredictionOperatorStatus exactly
    // once (the `name` parameter was retired in issue #421 — joined-only).
    expect(buildPredictionOperatorStatus).toHaveBeenCalledTimes(1);
    const [callArgs] = buildPredictionOperatorStatus.mock.calls;
    expect((callArgs as [{ name?: string }])[0].name).toBeUndefined();
  });

  it('defaults status.harness to ready when no harnessReadiness getter is supplied', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, undefined);
      expect(status.harness).toEqual({ ready: true, name: null, reason: null });
    });
  });

  it('reports running version and null latestVersion when no getter is supplied (#641)', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const { buildInfo } = await import('../../src/build-info.js');

    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, undefined);
      expect(status.version).toBe(buildInfo.implVersion);
      expect(status.latestVersion).toBeNull();
    });
  });

  it('threads latestVersion from the getter, and null when it throws (#641)', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const ok = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        latestVersion: () => '9.9.9',
      });
      expect(ok.latestVersion).toBe('9.9.9');

      const thrown = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        latestVersion: () => {
          throw new Error('holder not ready');
        },
      });
      expect(thrown.latestVersion).toBeNull();
    });
  });

  it('threads effectiveMode from the resolved decision, defaulting to legacy when absent (#2380)', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const withoutMode = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      expect(withoutMode.effectiveMode).toBe('legacy');

      const withMode = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        effectiveMode: 'native-v1',
      });
      expect(withMode.effectiveMode).toBe('native-v1');
    });
  });

  it('threads status.harness from the harnessReadiness getter when supplied', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        harnessReadiness: () => ({
          snapshot: {
            lastRefreshedAt: '2026-05-26T00:00:00.000Z',
            harnesses: [
              {
                harnessName: 'claude-code',
                manifestCids: ['bafkre-a'],
                ready: false,
                reason: 'not authenticated',
              },
            ],
          },
          joinedHarnessesByCid: {
            'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
          },
        }),
      });

      expect(status.harness).toEqual({
        ready: false,
        name: 'claude-code',
        reason: 'not authenticated',
      });
    });
  });

  it("surfaces joined-entry roles on the unavailable path (joined-only after issue #421)", async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async () => {
      throw new Error('plugin hash failed');
    });
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;

    await withTempStore(async (store) => {
      const apiStatus = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet' as const,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config,
        configPath: '/tmp/config.json',
      });

      expect(apiStatus.predictionV1?.operator?.ok).toBe(false);
      expect(apiStatus.predictionV1?.operator?.solverNet?.roles).toEqual(['solving']);
    });
  });

  // ── #959: loop-completion + impl-state commit cadence on /v1/status ──────────

  /** Seed a task_runs row with explicit solution_outputs_json + delivery_tx_hash. */
  function seedGatingRow(
    store: { db: import('better-sqlite3').Database },
    args: {
      requestId: string;
      solutionOutputsJson: string | null;
      deliveryTxHash?: string | null;
    },
  ): void {
    const persistence = new TaskRunPersistence(store.db);
    persistence.insertDiscovered({
      requestId: args.requestId,
      taskId: args.requestId,
      taskCid: `bafy-${args.requestId}`,
      onchainCreationTx: `0x${args.requestId}`,
      onchainCreationBlock: 1,
      solverType: 'swe-rebench-v2.v1',
      taskRole: 'restoration',
      windowStartTs: 1_000,
      windowEndTs: 2_000,
    });
    store.db
      .prepare(
        `UPDATE task_runs
         SET solution_outputs_json = ?, delivery_tx_hash = ?
         WHERE request_id = ?`,
      )
      .run(args.solutionOutputsJson, args.deliveryTxHash ?? null, args.requestId);
  }

  it('rolls up loop-completion phases across task_runs.solution_outputs_json', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    // Exercises the SQL `json_extract` path in getGatingRows: each seeded
    // `solution_outputs_json` is read through `json_valid`-guarded extraction,
    // so the no-gating, malformed-JSON, and present-array cases all resolve in
    // SQLite (malformed ⇒ NULL ⇒ [], never a query-aborting throw).
    await withTempStore(async (store) => {
      // Reached execute only.
      seedGatingRow(store, {
        requestId: 'row-execute',
        solutionOutputsJson: JSON.stringify({
          gating: { phasesCompleted: ['plan', 'execute'] },
        }),
      });
      // Full self-improvement loop (improve + memory-consolidation), delivered.
      seedGatingRow(store, {
        requestId: 'row-fullloop',
        solutionOutputsJson: JSON.stringify({
          gating: {
            phasesCompleted: ['plan', 'execute', 'improve', 'memory-consolidation'],
          },
        }),
        deliveryTxHash: '0xdelivered',
      });
      // No gating block at all.
      seedGatingRow(store, {
        requestId: 'row-nogating',
        solutionOutputsJson: JSON.stringify({ something: 'else' }),
      });
      // Malformed JSON.
      seedGatingRow(store, {
        requestId: 'row-malformed',
        solutionOutputsJson: '{not json',
      });

      const status = await gatherStatusForApi(store, undefined);

      expect(status.loopCompletion).toEqual({
        total: 4,
        delivered: 1,
        withGating: 2,
        reachedExecute: 2,
        reachedImprove: 1,
        reachedMemoryConsolidation: 1,
        fullLoop: 1,
        phaseCounts: {
          plan: 2,
          execute: 2,
          improve: 1,
          'memory-consolidation': 1,
        },
      });
    });
  });

  it('reports per-repo impl-state commit cadence under the impl-state root', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    const implStateDirRoot = mkdtempSync(join(tmpdir(), 'jinn-impl-state-'));
    const repoDir = join(implStateDirRoot, 'swe-impl');
    mkdirSync(repoDir, { recursive: true });
    // Deterministic git repo with three commits + fixed author/committer/date.
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Test Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.com',
    } as NodeJS.ProcessEnv;
    execFileSync('git', ['-C', repoDir, 'init', '-q'], { env: gitEnv, stdio: 'pipe' });
    for (const [n, date] of [
      ['first commit', '2026-01-01T00:00:00Z'],
      ['second commit', '2026-01-02T00:00:00Z'],
      ['third commit', '2026-01-03T00:00:00Z'],
    ] as const) {
      execFileSync('git', ['-C', repoDir, 'commit', '--allow-empty', '-q', '-m', n], {
        env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        stdio: 'pipe',
      });
    }
    const expectedShortHash = execFileSync(
      'git',
      ['-C', repoDir, 'rev-parse', '--short', 'HEAD'],
      { env: gitEnv, encoding: 'utf8' },
    ).trim();
    // The committer unix timestamp for the third commit (2026-01-03T00:00:00Z).
    const expectedTimestamp = Math.floor(Date.parse('2026-01-03T00:00:00Z') / 1000);
    // A sibling dir that is NOT a git repo — must be ignored.
    mkdirSync(join(implStateDirRoot, 'not-a-repo'), { recursive: true });

    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        engine: {
          workingDirRoot: join(implStateDirRoot, 'work'),
          implStateDirRoot,
        },
      });

      expect(status.implStateCadence).toBeDefined();
      expect(status.implStateCadence!.repos).toHaveLength(1);
      const repo = status.implStateCadence!.repos[0];
      expect(repo.name).toBe('swe-impl');
      expect(repo.commits).toBe(3);
      // The commit subject is deliberately NOT surfaced on the un-authed
      // /v1/status endpoint (LLM-authored, may carry task content). Assert the
      // count + short hash + timestamp the AC asked for, and that no subject leaks.
      expect(repo.lastCommit).toEqual({
        shortHash: expectedShortHash,
        timestamp: expectedTimestamp,
        date: '2026-01-03T00:00:00Z',
      });
      expect(repo.lastCommit).not.toHaveProperty('subject');
    });
  });

  it('degrades loop-completion + impl-state cadence to zeroes/empty with no throw', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    const emptyRoot = mkdtempSync(join(tmpdir(), 'jinn-impl-state-empty-'));

    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-status-test-')),
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        engine: { workingDirRoot: join(emptyRoot, 'work'), implStateDirRoot: emptyRoot },
      });

      expect(status.loopCompletion).toEqual({
        total: 0,
        delivered: 0,
        withGating: 0,
        reachedExecute: 0,
        reachedImprove: 0,
        reachedMemoryConsolidation: 0,
        fullLoop: 0,
        phaseCounts: {},
      });
      expect(status.implStateCadence).toBeDefined();
      expect(status.implStateCadence!.repos).toEqual([]);
    });
  });

  it('always emits security.lastPasswordRotationAt (null when no rotation config)', async () => {
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, undefined);
      expect(status.security).toEqual({ lastPasswordRotationAt: null });
    });
  });

  it('security.lastPasswordRotationAt is the keystore-password file mtime (file source)', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const { writeFileSync, utimesSync } = await import('node:fs');
    await withTempStore(async (store) => {
      const dir = mkdtempSync(join(tmpdir(), 'jinn-pw-'));
      const pwPath = join(dir, 'keystore-password');
      writeFileSync(pwPath, 'deadbeef\n', { mode: 0o600 });
      // Pin mtime to a known instant (2024-01-02T03:04:05Z).
      const when = new Date('2024-01-02T03:04:05.000Z');
      utimesSync(pwPath, when, when);

      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-earn-')),
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        passwordRotation: { source: 'file', filePath: pwPath },
      });

      expect(status.security.lastPasswordRotationAt).toBe('2024-01-02T03:04:05.000Z');
    });
  });

  it('security.lastPasswordRotationAt is null when the password is env-sourced', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-earn-')),
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        passwordRotation: { source: 'env' },
      });
      expect(status.security.lastPasswordRotationAt).toBeNull();
    });
  });

  it('security.lastPasswordRotationAt is null when the keystore-password file is missing', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    await withTempStore(async (store) => {
      const status = await gatherStatusForApi(store, {
        earningDir: mkdtempSync(join(tmpdir(), 'jinn-earn-')),
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        passwordRotation: {
          source: 'file',
          filePath: join(tmpdir(), 'definitely-absent-jinn-keystore-password'),
        },
      });
      expect(status.security.lastPasswordRotationAt).toBeNull();
    });
  });
});

describe('gatherStatusForApi — no staking reads on the hot path (#992)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.resetModules();
  });

  it('never calls calculateStakingReward / getStakingState / getServiceInfo / getNextRewardCheckpointTimestamp', async () => {
    const stakingFns = new Set([
      'calculateStakingReward',
      'getStakingState',
      'getServiceInfo',
      'getNextRewardCheckpointTimestamp',
    ]);
    const calledStakingFns: string[] = [];
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          multicall: async (req: { contracts: ReadonlyArray<{ functionName: string }> }) =>
            req.contracts.map((c) => {
              if (stakingFns.has(c.functionName)) calledStakingFns.push(c.functionName);
              return { status: 'success' as const, result: 0n };
            }),
          readContract: async (req: { functionName: string }) => {
            if (stakingFns.has(req.functionName)) {
              calledStakingFns.push(req.functionName);
              throw new Error(`staking read ${req.functionName} must not run on the hot path`);
            }
            return 0n;
          },
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });

    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-no-staking-test-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base-sepolia');
      await fleetStore.save({
        ...state,
        master_address: '0x1111111111111111111111111111111111111111',
        services: [
          {
            index: 1,
            agent_address: '0x2222222222222222222222222222222222222222',
            safe_address: '0x3333333333333333333333333333333333333333',
            service_id: 41,
            mech_address: null,
            staking_address: '0x5555555555555555555555555555555555555555',
            step: 'complete',
            error: null,
          },
        ],
      });

      const apiStatus = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      expect(calledStakingFns).toEqual([]);
      expect(apiStatus.statusMode).toBe('full');
      expect(apiStatus.fleet.services).toHaveLength(1);
    });
  });
});

// Regression coverage for spec §14.2 item 2 / issue #2402: `maskRpcHost`
// only ever ran on the boot/preflight *log* path. The status error path
// returned a caught viem error's raw `.message` — and a viem
// `HttpRequestError` embeds the full request URL — so a failing paid RPC
// (key-in-path) leaked its key into the unauthenticated `/v1/status`
// response, AND into the SQLite balance cache that gets replayed on later
// status calls.
describe('gather-status RPC error masking (spec §14.2 item 2, issue #2402)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.resetModules();
  });

  const LEAKY_URL = 'https://base-mainnet.g.alchemy.com/v2/SECRETKEY123';

  function mockLeakyViem(): void {
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      const throwLeaky = () => {
        throw new actual.HttpRequestError({
          url: LEAKY_URL,
          body: { method: 'eth_call' },
          details: 'fetch failed',
        });
      };
      return {
        ...actual,
        createPublicClient: () => ({
          getBlockNumber: async () => throwLeaky(),
          getChainId: async () => throwLeaky(),
          getBalance: async () => throwLeaky(),
          readContract: async () => throwLeaky(),
        }),
        http: () => ({}),
      };
    });
  }

  it('masks the RPC key out of raw.rpc / masterGas / l1MasterGas / balances.eth.master and out of the persisted balance cache', async () => {
    mockLeakyViem();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-mask-test-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base-sepolia');
      await fleetStore.save({
        ...state,
        master_address: '0x1111111111111111111111111111111111111111',
        services: [
          {
            index: 1,
            agent_address: '0x2222222222222222222222222222222222222222',
            safe_address: '0x3333333333333333333333333333333333333333',
            service_id: 41,
            mech_address: null,
            staking_address: '0x5555555555555555555555555555555555555555',
            step: 'complete',
            error: null,
          },
        ],
      });

      const status = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: LEAKY_URL,
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      // Nothing in the serialized /v1/status response should ever contain
      // the secret — this is the end-to-end assertion the issue asks for.
      expect(JSON.stringify(status)).not.toContain('SECRETKEY123');

      expect(status.rpc.ok).toBe(false);
      expect(status.rpc.error).toContain('base-mainnet.g.alchemy.com');
      expect(status.rpc.error).not.toContain('SECRETKEY123');

      expect(status.masterGas.error).toContain('base-mainnet.g.alchemy.com');
      expect(status.masterGas.error).not.toContain('SECRETKEY123');

      expect(status.l1MasterGas?.error).toContain('base-mainnet.g.alchemy.com');
      expect(status.l1MasterGas?.error).not.toContain('SECRETKEY123');

      expect(status.balances.eth.master.error).toContain('base-mainnet.g.alchemy.com');
      expect(status.balances.eth.master.error).not.toContain('SECRETKEY123');

      // Mask-before-persistence: the balance cache row written during this
      // call must already carry the masked message, not the raw one.
      const cacheEntry = store
        .getBalanceCache()
        .find((e) => e.role === 'service.0.agent');
      expect(cacheEntry?.error).toContain('base-mainnet.g.alchemy.com');
      expect(cacheEntry?.error).not.toContain('SECRETKEY123');
    });
  });
});

describe('gather-status autoRestake gating (#651)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.useRealTimers();
    vi.resetModules();
  });

  /**
   * Plain viem mock for the gather. The staking-read branches were removed
   * with the hot-path staking deletion (#992), so the mock no longer needs to
   * answer getStakingState / getServiceInfo / calculateStakingReward.
   */
  function mockGatherViem(): void {
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          multicall: async (req: {
            contracts: ReadonlyArray<{ functionName: string }>;
          }) => req.contracts.map(() => ({ status: 'success' as const, result: 0n })),
          readContract: async () => 0n,
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });
  }

  async function setupFleet(): Promise<string> {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-evict-test-'));
    const fleetStore = new FleetStateStore(earningDir);
    const state = await fleetStore.load('base-sepolia');
    await fleetStore.save({
      ...state,
      master_address: '0x1111111111111111111111111111111111111111',
      services: [
        {
          index: 1,
          agent_address: '0x2222222222222222222222222222222222222222',
          safe_address: '0x3333333333333333333333333333333333333333',
          service_id: 41,
          mech_address: null,
          staking_address: '0x5555555555555555555555555555555555555555',
          step: 'complete',
          error: null,
        },
      ],
    });
    return earningDir;
  }

  it('emits autoRestake.enabled=true only when all three predicate clauses are met', async () => {
    mockGatherViem();
    const { gatherStatusForApi } = await import(
      '../../src/api/gather-status.js'
    );

    await withTempStore(async (store) => {
      const earningDir = await setupFleet();

      const enabled = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        stOlasDistributorAddress: '0xdead000000000000000000000000000000000000',
        config: { evictionCheckIntervalMs: 60_000, stakingMode: 'standard' } as unknown as JinnConfig,
      });
      expect(enabled.autoRestake).toEqual({ enabled: true, checkIntervalMs: 60_000 });

      const noInterval = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        stOlasDistributorAddress: '0xdead000000000000000000000000000000000000',
        config: { evictionCheckIntervalMs: 0, stakingMode: 'standard' } as unknown as JinnConfig,
      });
      expect(noInterval.autoRestake.enabled).toBe(false);

      const nonStandard = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        stOlasDistributorAddress: '0xdead000000000000000000000000000000000000',
        config: { evictionCheckIntervalMs: 60_000, stakingMode: 'self-bond' } as unknown as JinnConfig,
      });
      expect(nonStandard.autoRestake.enabled).toBe(false);

      const noDistributor = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config: { evictionCheckIntervalMs: 60_000, stakingMode: 'standard' } as unknown as JinnConfig,
      });
      expect(noDistributor.autoRestake.enabled).toBe(false);
    });
  });

  // The autoRestake gate must mirror `main.ts`'s `evictionCheck` predicate,
  // which keys off `CHAIN_CONFIG.distributorAddress` (the stOLAS L2
  // distributor).
  it('gates autoRestake on stOLAS distributor presence', async () => {
    mockGatherViem();
    const { gatherStatusForApi } = await import(
      '../../src/api/gather-status.js'
    );

    await withTempStore(async (store) => {
      const earningDir = await setupFleet();

      // No distributor set → must NOT enable. Mirrors `main.ts:2520-2523`:
      // when `CHAIN_CONFIG.distributorAddress` is absent the EvictionLoop is
      // not constructed, so the SPA must NOT open the suppression window.
      const noDistributor = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        config: {
          evictionCheckIntervalMs: 60_000,
          stakingMode: 'standard',
        } as unknown as JinnConfig,
      });
      expect(noDistributor.autoRestake.enabled).toBe(false);

      // stOLAS distributor set → must enable.
      const stOlasOnly = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        stOlasDistributorAddress: '0xbeef000000000000000000000000000000000000',
        config: {
          evictionCheckIntervalMs: 60_000,
          stakingMode: 'standard',
        } as unknown as JinnConfig,
      });
      expect(stOlasOnly.autoRestake).toEqual({
        enabled: true,
        checkIntervalMs: 60_000,
      });
    });
  });
});

describe('derivePredictionSolverNetName (#446)', () => {
  function makeConfig(
    joinedSolverNets: Record<string, unknown>,
  ): JinnConfig {
    return { joinedSolverNets } as unknown as JinnConfig;
  }

  it("returns 'prediction' when the operator has only non-prediction joined entries", async () => {
    const { derivePredictionSolverNetName } = await import(
      '../../src/api/gather-status.js'
    );
    const config = makeConfig({
      'bafy-restoration': {
        manifestCid: 'bafy-restoration',
        name: 'Restoration Net',
        contract: { id: 'restoration', version: 'v1' },
        roles: ['solver'],
      },
      'bafy-no-contract': {
        manifestCid: 'bafy-no-contract',
        name: 'Some Other Net',
        roles: ['solver'],
      },
    });

    expect(derivePredictionSolverNetName(config)).toBe('prediction');
  });

  it("returns the prediction entry's name when a prediction SolverNet is joined", async () => {
    const { derivePredictionSolverNetName } = await import(
      '../../src/api/gather-status.js'
    );
    const config = makeConfig({
      'bafy-restoration': {
        manifestCid: 'bafy-restoration',
        name: 'Restoration Net',
        contract: { id: 'restoration', version: 'v1' },
        roles: ['solver'],
      },
      'bafy-prediction': {
        manifestCid: 'bafy-prediction',
        name: 'SWE-rebench v2',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
      },
    });

    expect(derivePredictionSolverNetName(config)).toBe('SWE-rebench v2');
  });

  it('falls back to the manifestCid when the prediction entry has no name', async () => {
    const { derivePredictionSolverNetName } = await import(
      '../../src/api/gather-status.js'
    );
    const config = makeConfig({
      'bafy-prediction-cid': {
        manifestCid: 'bafy-prediction-cid',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
      },
    });

    expect(derivePredictionSolverNetName(config)).toBe('bafy-prediction-cid');
  });

  it("returns 'prediction' when joinedSolverNets is empty", async () => {
    const { derivePredictionSolverNetName } = await import(
      '../../src/api/gather-status.js'
    );
    expect(derivePredictionSolverNetName(makeConfig({}))).toBe('prediction');
  });
});
