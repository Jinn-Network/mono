import { mkdtempSync } from 'node:fs';
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

  it('reads real tJINN balances on Sepolia separately from pending staking rewards', async () => {
    const safeA = '0x3333333333333333333333333333333333333333';
    const safeB = '0x4444444444444444444444444444444444444444';
    const stakingProxy = '0x5555555555555555555555555555555555555555';
    const distributor = '0xaC9CD847660d05e77D82A3684aFC4EbFd94fBfe6';
    const balanceReads: Array<{ token: string; safe: string; chainId: number }> = [];
    const claimedReads: Array<{ distributor: string; serviceId: bigint; chainId: number }> = [];
    const balanceOf = (token: string, safe: string): bigint => {
      balanceReads.push({ token, safe, chainId: 11155111 });
      return safe.toLowerCase() === safeA.toLowerCase()
        ? 1500000000000000000n
        : 2000000000000000000n;
    };
    const totalClaimedOperator = (address: string, serviceId: bigint): bigint => {
      claimedReads.push({ distributor: address, serviceId, chainId: 11155111 });
      switch (serviceId) {
        case 41n:
          return 10000000000000000000n;
        case 42n:
          return 20000000000000000000n;
        case 43n:
          return 30000000000000000000n;
        default:
          return 0n;
      }
    };
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          // tJINN balances are read in one multicall3 round-trip (E2).
          multicall: async (req: {
            contracts: ReadonlyArray<{
              address: string;
              functionName: string;
              args?: readonly [`0x${string}`] | readonly [bigint];
            }>;
          }) =>
            req.contracts.map((c) => {
              if (chain.id === 11155111 && c.functionName === 'balanceOf') {
                return {
                  status: 'success' as const,
                  result: balanceOf(c.address, (c.args?.[0] as string | undefined) ?? '0x'),
                };
              }
              if (chain.id === 11155111 && c.functionName === 'totalClaimedOperator') {
                return {
                  status: 'success' as const,
                  result: totalClaimedOperator(c.address, (c.args?.[0] as bigint | undefined) ?? 0n),
                };
              }
              return { status: 'success' as const, result: 0n };
            }),
          readContract: async (req: {
            address: string;
            functionName: string;
            args?: readonly [`0x${string}`] | readonly [bigint];
          }) => {
            if (chain.id === 84532 && req.functionName === 'calculateStakingReward') {
              return 999000000000000000000n;
            }
            if (req.functionName === 'getNextRewardCheckpointTimestamp') return 0n;
            if (req.functionName === 'getStakingState') return 0;
            if (req.functionName === 'getServiceInfo') return { inactivity: 0n };
            return 0n;
          },
        }),
        http: () => ({}),
      };
    });
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-test-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base-sepolia');
      await fleetStore.save({
        ...state,
        master_address: '0x1111111111111111111111111111111111111111',
        services: [
          {
            index: 1,
            agent_address: '0x2222222222222222222222222222222222222222',
            safe_address: safeA,
            service_id: 41,
            mech_address: null,
            staking_address: stakingProxy,
            step: 'complete',
            error: null,
          },
          {
            index: 2,
            agent_address: '0x6666666666666666666666666666666666666666',
            safe_address: safeA,
            service_id: 42,
            mech_address: null,
            staking_address: stakingProxy,
            step: 'complete',
            error: null,
          },
          {
            index: 3,
            agent_address: '0x7777777777777777777777777777777777777777',
            safe_address: safeB,
            service_id: 43,
            mech_address: null,
            staking_address: stakingProxy,
            step: 'complete',
            error: null,
          },
        ],
      });

      const apiStatus = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        // The Sepolia tJINN RPC endpoint is read from config.ethereumRpcUrl.
        config: { ethereumRpcUrl: 'http://sepolia.example' } as unknown as JinnConfig,
        network: 'testnet',
        tjinnDistributorAddress: distributor,
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      expect(apiStatus.rewards.pendingStakingRewardsWei).toBe('2997000000000000000000');
      expect(apiStatus.tJinn).toMatchObject({
        state: 'ready',
        chainId: 11155111,
        tokenAddress: '0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A',
        safeBalanceWei: '3500000000000000000',
        operatorClaimedWei: '60000000000000000000',
        safeCount: 2,
        error: null,
      });
      expect(apiStatus.tJinn.safeBalanceWei).not.toBe(apiStatus.rewards.pendingStakingRewardsWei);
      expect(apiStatus.tJinn.services.map((svc) => svc.balanceWei)).toEqual([
        '1500000000000000000',
        '1500000000000000000',
        '2000000000000000000',
      ]);
      expect(apiStatus.tJinn.services.map((svc) => svc.operatorClaimedWei)).toEqual([
        '10000000000000000000',
        '20000000000000000000',
        '30000000000000000000',
      ]);
    });

    expect(balanceReads).toEqual([
      { token: '0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A', safe: safeA, chainId: 11155111 },
      { token: '0x0bc0B2f733bF4229FD58Baaac5ebFEf2AEc83C4A', safe: safeB, chainId: 11155111 },
    ]);
    expect(claimedReads).toEqual([
      { distributor, serviceId: 41n, chainId: 11155111 },
      { distributor, serviceId: 42n, chainId: 11155111 },
      { distributor, serviceId: 43n, chainId: 11155111 },
    ]);
  });

  it('marks tJINN balance pending when the Sepolia RPC URL is unavailable', async () => {
    mockStatusRpc();
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-test-'));
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
            service_id: null,
            mech_address: null,
            staking_address: null,
            step: 'awaiting_stake',
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

      expect(apiStatus.tJinn).toMatchObject({
        state: 'pending',
        safeBalanceWei: null,
        safeCount: 1,
        error: null,
      });
    });
  });

  it('keeps successful tJINN balances when one Safe read fails and redacts public errors', async () => {
    const safeA = '0x3333333333333333333333333333333333333333';
    const safeB = '0x4444444444444444444444444444444444444444';
    vi.doMock('viem', async (importOriginal) => {
      const actual = await importOriginal<typeof import('viem')>();
      return {
        ...actual,
        createPublicClient: ({ chain }: { chain: { id: number } }) => ({
          getBlockNumber: async () => 123n,
          getChainId: async () => chain.id,
          getBalance: async () => 0n,
          // tJINN balances read via multicall3 with allowFailure: true — a
          // per-Safe failure surfaces as a `{ status: 'failure' }` entry.
          multicall: async (req: {
            contracts: ReadonlyArray<{
              functionName: string;
              args?: readonly [`0x${string}`];
            }>;
          }) =>
            req.contracts.map((c) => {
              if (chain.id === 11155111 && c.functionName === 'balanceOf') {
                const safe = c.args?.[0] ?? '0x';
                if (safe.toLowerCase() === safeB.toLowerCase()) {
                  return {
                    status: 'failure' as const,
                    error: new Error(
                      'HTTP request failed for http://sepolia.example?apikey=secret',
                    ),
                  };
                }
                return { status: 'success' as const, result: 10n };
              }
              return { status: 'success' as const, result: 0n };
            }),
          readContract: async () => 0n,
        }),
        http: () => ({}),
      };
    });
    const { gatherStatusForApi } = await import('../../src/api/gather-status.js');

    await withTempStore(async (store) => {
      const earningDir = mkdtempSync(join(tmpdir(), 'jinn-status-test-'));
      const fleetStore = new FleetStateStore(earningDir);
      const state = await fleetStore.load('base-sepolia');
      await fleetStore.save({
        ...state,
        master_address: '0x1111111111111111111111111111111111111111',
        services: [
          {
            index: 1,
            agent_address: '0x2222222222222222222222222222222222222222',
            safe_address: safeA,
            service_id: null,
            mech_address: null,
            staking_address: null,
            step: 'awaiting_stake',
            error: null,
          },
          {
            index: 2,
            agent_address: '0x5555555555555555555555555555555555555555',
            safe_address: safeB,
            service_id: null,
            mech_address: null,
            staking_address: null,
            step: 'awaiting_stake',
            error: null,
          },
        ],
      });

      const apiStatus = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        // The Sepolia tJINN RPC endpoint is read from config.ethereumRpcUrl.
        config: { ethereumRpcUrl: 'http://sepolia.example' } as unknown as JinnConfig,
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      expect(apiStatus.tJinn.state).toBe('error');
      expect(apiStatus.tJinn.safeBalanceWei).toBe('10');
      expect(apiStatus.tJinn.error).toBe('Some Safe tJINN balances are temporarily unavailable.');
      expect(apiStatus.tJinn.services.map((svc) => svc.state)).toEqual(['ready', 'error']);
      expect(apiStatus.tJinn.services.map((svc) => svc.balanceWei)).toEqual(['10', null]);
      expect(JSON.stringify(apiStatus.tJinn)).not.toContain('apikey=secret');
      expect(JSON.stringify(apiStatus.tJinn)).not.toContain('sepolia.example');
    });
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
      solverNets: {},
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

    // gather-status must have called buildPredictionOperatorStatus with the name
    // from the joined entry ('SWE-rebench v2'), not the hard-coded 'prediction'.
    expect(buildPredictionOperatorStatus).toHaveBeenCalledTimes(1);
    const [callArgs] = buildPredictionOperatorStatus.mock.calls;
    expect((callArgs as [{ name?: string }])[0].name).toBe('SWE-rebench v2');
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
