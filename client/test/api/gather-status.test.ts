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
    // `Claimed` events captured by `getLogs` for the 24h-minted sum. The
    // operator's three services each have one event in the window; service 41
    // also has a second event so the per-service sum is exercised.
    const claimedEvents: ReadonlyArray<{
      serviceId: bigint;
      operatorMinted: bigint;
    }> = [
      { serviceId: 41n, operatorMinted: 250000000000000000n },
      { serviceId: 41n, operatorMinted: 250000000000000000n },
      { serviceId: 42n, operatorMinted: 500000000000000000n },
      { serviceId: 43n, operatorMinted: 1000000000000000000n },
    ];
    const logReads: Array<{
      address: string;
      fromBlock: bigint;
      toBlock: bigint;
      serviceIds: bigint[];
    }> = [];
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
          getLogs: async (req: {
            address: `0x${string}`;
            fromBlock: bigint;
            toBlock: bigint;
            args?: { serviceId?: bigint[] };
          }) => {
            const allowed = new Set(
              (req.args?.serviceId ?? []).map((id) => id.toString()),
            );
            logReads.push({
              address: req.address,
              fromBlock: req.fromBlock,
              toBlock: req.toBlock,
              serviceIds: req.args?.serviceId ?? [],
            });
            return claimedEvents
              .filter((e) => allowed.has(e.serviceId.toString()))
              .map((e) => ({
                args: { serviceId: e.serviceId, operatorMinted: e.operatorMinted },
              }));
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
        // 0.25 + 0.25 + 0.5 + 1.0 = 2.0 tJINN minted across services in 24h
        operatorMintedLast24hWei: '2000000000000000000',
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
});

describe('gather-status eviction first-seen tracker (#651)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.useRealTimers();
    vi.resetModules();
  });

  /**
   * Mock viem with a controllable `evictedFn` for `getStakingState`. Each call
   * to the mock returns whatever `evictedFn()` returns at the time the read
   * happens — so the same fleet can be observed evicted on one read and not
   * on the next.
   */
  function mockEvictionViem(evictedFn: () => boolean): void {
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
          readContract: async (req: { functionName: string }) => {
            if (req.functionName === 'getStakingState') return evictedFn() ? 2 : 0;
            if (req.functionName === 'getServiceInfo') return { inactivity: 0n };
            if (req.functionName === 'calculateStakingReward') return 0n;
            if (req.functionName === 'getNextRewardCheckpointTimestamp') return 0n;
            return 0n;
          },
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

  it('sets evictedSince on first observation and preserves it across reads', async () => {
    let evicted = true;
    mockEvictionViem(() => evicted);
    const { gatherStatusForApi, __resetEvictionFirstSeenForTests } = await import(
      '../../src/api/gather-status.js'
    );
    __resetEvictionFirstSeenForTests();

    await withTempStore(async (store) => {
      const earningDir = await setupFleet();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-26T10:00:00.000Z'));

      const first = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      expect(first.fleet.services[0].evicted).toBe(true);
      expect(first.fleet.services[0].evictedSince).toBe('2026-05-26T10:00:00.000Z');

      vi.setSystemTime(new Date('2026-05-26T10:00:30.000Z'));
      const second = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      // Same ISO — the first-seen timestamp is sticky.
      expect(second.fleet.services[0].evictedSince).toBe('2026-05-26T10:00:00.000Z');
    });
  });

  it('clears the tracker entry when service is no longer evicted', async () => {
    let evicted = true;
    mockEvictionViem(() => evicted);
    const { gatherStatusForApi, __resetEvictionFirstSeenForTests } = await import(
      '../../src/api/gather-status.js'
    );
    __resetEvictionFirstSeenForTests();

    await withTempStore(async (store) => {
      const earningDir = await setupFleet();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-26T10:00:00.000Z'));

      await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });

      vi.setSystemTime(new Date('2026-05-26T10:01:00.000Z'));
      evicted = false;
      const recovered = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      expect(recovered.fleet.services[0].evicted).toBe(false);
      expect(recovered.fleet.services[0].evictedSince).toBeNull();

      // Re-eviction gets a fresh timestamp, not the old one.
      vi.setSystemTime(new Date('2026-05-26T10:02:00.000Z'));
      evicted = true;
      const reEvicted = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      expect(reEvicted.fleet.services[0].evictedSince).toBe('2026-05-26T10:02:00.000Z');
    });
  });

  it('emits autoRestake.enabled=true only when all three predicate clauses are met', async () => {
    mockEvictionViem(() => false);
    const { gatherStatusForApi, __resetEvictionFirstSeenForTests } = await import(
      '../../src/api/gather-status.js'
    );
    __resetEvictionFirstSeenForTests();

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

  // Finding A (review): the autoRestake gate must mirror `main.ts`'s
  // `evictionCheck` predicate, which keys off `CHAIN_CONFIG.distributorAddress`
  // (the stOLAS L2 distributor) — NOT `tjinnDistributorAddress` (the JINN MVI
  // L1 distributor). The two contracts happen to bundle together in our
  // current testnet deployment but they are semantically distinct.
  it('gates autoRestake on stOLAS distributor presence, not tJINN distributor presence', async () => {
    mockEvictionViem(() => false);
    const { gatherStatusForApi, __resetEvictionFirstSeenForTests } = await import(
      '../../src/api/gather-status.js'
    );
    __resetEvictionFirstSeenForTests();

    await withTempStore(async (store) => {
      const earningDir = await setupFleet();

      // tJINN distributor set, stOLAS distributor missing → must NOT enable.
      // Mirrors `main.ts:2520-2523`: when `CHAIN_CONFIG.distributorAddress`
      // is absent the EvictionLoop is not constructed, so the SPA must NOT
      // open the suppression window.
      const tjinnOnly = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
        tjinnDistributorAddress: '0xdead000000000000000000000000000000000000',
        config: {
          evictionCheckIntervalMs: 60_000,
          stakingMode: 'standard',
        } as unknown as JinnConfig,
      });
      expect(tjinnOnly.autoRestake.enabled).toBe(false);

      // stOLAS distributor set, tJINN distributor missing → must enable.
      // The tJINN distributor has no bearing on the EvictionLoop gate.
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

  // Finding B (review): transient RPC errors must not reset the
  // suppression window. The deletion branch should run ONLY on a confirmed
  // `false` read; a read failure must leave the prior `evictedSince`
  // untouched. Otherwise a single flap during transient RPC trouble
  // re-arms the 2 × checkIntervalMs silence window — exactly the
  // silent-failure shape the issue warned about.
  it('preserves evictedSince across a transient RPC failure', async () => {
    // Reads are sequenced: succeed (evicted), throw, succeed (evicted).
    let readNo = 0;
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
          readContract: async (req: { functionName: string }) => {
            if (req.functionName === 'getStakingState') {
              readNo += 1;
              if (readNo === 2) throw new Error('transient RPC error');
              return 2; // Evicted
            }
            if (req.functionName === 'getServiceInfo') return { inactivity: 0n };
            if (req.functionName === 'calculateStakingReward') return 0n;
            if (req.functionName === 'getNextRewardCheckpointTimestamp') return 0n;
            return 0n;
          },
          getLogs: async () => [],
        }),
        http: () => ({}),
      };
    });
    const { gatherStatusForApi, __resetEvictionFirstSeenForTests } = await import(
      '../../src/api/gather-status.js'
    );
    __resetEvictionFirstSeenForTests();

    await withTempStore(async (store) => {
      const earningDir = await setupFleet();
      vi.useFakeTimers();

      // T=0 — service observed evicted. evictedSince is set.
      vi.setSystemTime(new Date('2026-05-26T10:00:00.000Z'));
      const first = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      expect(first.fleet.services[0].evicted).toBe(true);
      expect(first.fleet.services[0].evictedSince).toBe('2026-05-26T10:00:00.000Z');

      // T=30s — RPC read fails. The tracker entry must be preserved so the
      // suppression window does not restart on the next successful read.
      vi.setSystemTime(new Date('2026-05-26T10:00:30.000Z'));
      const middle = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      // Read failed → evicted reverts to false (no info), but evictedSince
      // is preserved server-side. The wire shape may surface it or may not,
      // but the next successful read MUST NOT bump the timestamp.
      expect(middle.fleet.services[0].evicted).toBe(false);

      // T=60s — RPC recovers, service still evicted. evictedSince must
      // remain T=0, NOT be reset to T=60s.
      vi.setSystemTime(new Date('2026-05-26T10:01:00.000Z'));
      const third = await gatherStatusForApi(store, {
        earningDir,
        rpcUrl: 'http://base-sepolia.example',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      });
      expect(third.fleet.services[0].evicted).toBe(true);
      expect(third.fleet.services[0].evictedSince).toBe('2026-05-26T10:00:00.000Z');
    });
  });
});
