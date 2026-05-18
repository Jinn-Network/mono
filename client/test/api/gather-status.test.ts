import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JinnConfig } from '../../src/config.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import type { PredictionOperatorStatus } from '../../src/solver-nets/prediction-operator-ux.js';
import { withTempStore } from '@test/store.js';

describe('gatherStatusForApi', () => {
  afterEach(() => {
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
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          taskGenerator: { enabled: true },
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
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          taskGenerator: { enabled: true },
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
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          taskGenerator: { enabled: true },
          roles: ['solving', 'launching'],
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
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          taskGenerator: { enabled: true },
          roles: ['launching'],
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

      expect(apiStatus.predictionV1?.operator?.solverNet?.roles).toEqual([]);
    });
  });

  it("omits 'launching' from operator.solverNet.roles on the unavailable path", async () => {
    mockStatusRpc();
    const buildPredictionOperatorStatus = vi.fn(async () => {
      throw new Error('plugin hash failed');
    });
    vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
      buildPredictionOperatorStatus,
    }));
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
    const config = {
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          taskGenerator: { enabled: true },
          roles: ['solving', 'launching'],
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
});
