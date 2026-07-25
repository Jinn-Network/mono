import { describe, expect, it, vi } from 'vitest';
import {
  wireLaunchedRecordGenerators,
  type LaunchedRecordGeneratorFactories,
} from '../../src/solvernets/launched-record-dispatcher.js';
import type { PendingGeneratorSpawn } from '../../src/solvernets/daemon-init.js';
import type { LaunchedSolverNetRecord } from '../../src/solvernets/store.js';
import type { TaskGenerator } from '../../src/tasks/sources.js';

const FIXED_NOW_ISO = '2026-05-08T10:12:45.000Z';

function record(solverNetId: string, overrides: Partial<LaunchedSolverNetRecord> = {}): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId,
    manifestCid: `bafy-${solverNetId}`,
    manifestHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
    launcherAgentId: '5474',
    launcherSafeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
    launchedAt: FIXED_NOW_ISO,
    status: 'launched',
    statusUpdatedAt: FIXED_NOW_ISO,
    generatorEnabled: true,
    registry: {
      metadataTxHash: `0x${'bb'.repeat(32)}` as `0x${string}`,
      metadataBlockNumber: 1,
    },
    ...overrides,
  };
}

function pending(recordValue: LaunchedSolverNetRecord): PendingGeneratorSpawn {
  return {
    record: recordValue,
    recordRef: { current: recordValue },
    configRef: { current: recordValue.generatorConfig ?? {} },
  };
}

function noopGenerator(): TaskGenerator {
  return async () => null;
}

describe('launched-record generator dispatcher', () => {
  it('dispatches prediction and swe-rebench records, and skips unknown contracts', async () => {
    const predictionGenerator = Object.assign(noopGenerator(), { getState: () => ({}) });
    const sweGenerator = Object.assign(noopGenerator(), {
      getState: () => ({
        kind: 'swe-rebench-v2',
        lastPollAt: '2026-05-08T10:10:00.000Z',
        lastPollSummary: {
          poolSize: 42,
          posted: 1,
          unposted: 10,
          live: 20,
          repostable: 3,
          saturated: 4,
        },
        poolPublicationStale: true,
        totalPosted: 4,
        lastPostedInstanceId: 'astropy__astropy-14096',
        config: {
          N_target_successes: 5,
          posting_window_ms: 604_800_000,
          post_batch_size: 25,
          claimLeaseTtlSeconds: 3_600,
        },
      }),
    });
    const factories: LaunchedRecordGeneratorFactories = {
      predictionV1: vi.fn(() => predictionGenerator),
      sweRebenchV2: vi.fn(() => sweGenerator),
      jinnRepo: vi.fn(() => noopGenerator()),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const predictionRecord = record('5474_prediction-v1_8b226228');
    const sweRecord = record('5474_swe-rebench-v2-v1_edb172d3', {
      status: 'paused',
      generatorConfig: {
        N_target_successes: 5,
        posting_window_ms: 604_800_000,
        post_batch_size: 25,
      },
    });
    const unknownRecord = record('5474_unknown-v1_deadbeef');

    const result = await wireLaunchedRecordGenerators({
      pendingGenerators: [
        pending(predictionRecord),
        pending(sweRecord),
        pending(unknownRecord),
      ],
      staticConfig: {},
      factories,
      logger,
    });

    expect(factories.predictionV1).toHaveBeenCalledTimes(1);
    expect(factories.predictionV1).toHaveBeenCalledWith(expect.objectContaining({
      recordRef: expect.objectContaining({ current: predictionRecord }),
    }));
    expect(factories.sweRebenchV2).toHaveBeenCalledTimes(1);
    expect(factories.sweRebenchV2).toHaveBeenCalledWith(expect.objectContaining({
      recordRef: expect.objectContaining({ current: sweRecord }),
    }));
    expect(result.generators).toEqual([
      {
        solverType: 'prediction.v1',
        generator: predictionGenerator,
        getLauncherState: expect.any(Function),
      },
      {
        solverType: 'swe-rebench-v2.v1',
        generator: sweGenerator,
        getLauncherState: expect.any(Function),
      },
    ]);
    expect(result.predictionGeneratorRef).toBe(predictionGenerator);
    expect(result.generatorStatesBySolverType.get('swe-rebench-v2.v1')?.()).toEqual({
      lastPollAt: '2026-05-08T10:10:00.000Z',
      lastPollSummary: {
        poolSize: 42,
        posted: 1,
        unposted: 10,
        live: 20,
        repostable: 3,
        saturated: 4,
      },
      poolPublicationStale: true,
      totalPosted: 4,
      lastPostedInstanceId: 'astropy__astropy-14096',
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown.v1'));
    expect(logger.info).toHaveBeenCalledWith(
      '[main] launched-record generator wired: 5474_swe-rebench-v2-v1_edb172d3 (swe-rebench-v2.v1, status=paused)',
    );
  });

  it('dispatches a jinn-repo record through the jinnRepo factory', async () => {
    const jinnRepoGenerator = noopGenerator();
    const factories: LaunchedRecordGeneratorFactories = {
      predictionV1: vi.fn(() => noopGenerator()),
      sweRebenchV2: vi.fn(() => noopGenerator()),
      jinnRepo: vi.fn(() => jinnRepoGenerator),
    };
    const jinnRepoRecord = record('5474_jinn-repo-v1_abc12345');

    const result = await wireLaunchedRecordGenerators({
      pendingGenerators: [pending(jinnRepoRecord)],
      staticConfig: {},
      factories,
    });

    expect(factories.jinnRepo).toHaveBeenCalledTimes(1);
    expect(factories.jinnRepo).toHaveBeenCalledWith(
      expect.objectContaining({ recordRef: expect.objectContaining({ current: jinnRepoRecord }) }),
    );
    expect(result.generators).toEqual([
      { solverType: 'jinn-repo.v1', generator: jinnRepoGenerator, getLauncherState: undefined },
    ]);
  });

  it('wires the live-issue generator ALONGSIDE the retrospective one when factories.jinnRepoLive is supplied (issue #1893)', async () => {
    const jinnRepoGenerator = noopGenerator();
    const jinnRepoLiveGenerator = noopGenerator();
    const factories: LaunchedRecordGeneratorFactories = {
      predictionV1: vi.fn(() => noopGenerator()),
      sweRebenchV2: vi.fn(() => noopGenerator()),
      jinnRepo: vi.fn(() => jinnRepoGenerator),
      jinnRepoLive: vi.fn(() => jinnRepoLiveGenerator),
    };
    const jinnRepoRecord = record('5474_jinn-repo-v1_abc12345');

    const result = await wireLaunchedRecordGenerators({
      pendingGenerators: [pending(jinnRepoRecord)],
      staticConfig: {},
      factories,
    });

    expect(factories.jinnRepo).toHaveBeenCalledTimes(1);
    expect(factories.jinnRepoLive).toHaveBeenCalledTimes(1);
    expect(factories.jinnRepoLive).toHaveBeenCalledWith(
      expect.objectContaining({ recordRef: expect.objectContaining({ current: jinnRepoRecord }) }),
    );
    expect(result.generators).toEqual([
      { solverType: 'jinn-repo.v1', generator: jinnRepoGenerator, getLauncherState: undefined },
      { solverType: 'jinn-repo.v1', generator: jinnRepoLiveGenerator, getLauncherState: undefined },
    ]);
  });

  it('omitting factories.jinnRepoLive wires ONLY the retrospective generator (back-compat)', async () => {
    const jinnRepoGenerator = noopGenerator();
    const factories: LaunchedRecordGeneratorFactories = {
      predictionV1: vi.fn(() => noopGenerator()),
      sweRebenchV2: vi.fn(() => noopGenerator()),
      jinnRepo: vi.fn(() => jinnRepoGenerator),
      // jinnRepoLive deliberately omitted
    };
    const jinnRepoRecord = record('5474_jinn-repo-v1_def67890');

    const result = await wireLaunchedRecordGenerators({
      pendingGenerators: [pending(jinnRepoRecord)],
      staticConfig: {},
      factories,
    });

    expect(result.generators).toEqual([
      { solverType: 'jinn-repo.v1', generator: jinnRepoGenerator, getLauncherState: undefined },
    ]);
  });
});
