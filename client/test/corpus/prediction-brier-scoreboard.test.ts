import { describe, expect, it } from 'vitest';
import {
  aggregatePredictionBrierScoreboard,
  queryScoreablePredictionBrierVerdicts,
} from '../../src/corpus/index.js';
import type { EnvelopeProjection } from '../../src/corpus/types.js';
import { Store } from '../../src/store/store.js';

const DAY_MS = 86_400_000;
const AS_OF = Date.parse('2026-05-03T00:00:00.000Z');
const TASK_CID = 'bafy-task-shared';
const TASK_ID = 'prediction-v1-polymarket-abc';
const OPERATOR_A = `0x${'a'.repeat(40)}`;
const OPERATOR_B = `0x${'b'.repeat(40)}`;
const EVALUATOR_OPERATOR = `0x${'e'.repeat(40)}`;
const AGENT_A = `0x${'1'.repeat(40)}`;
const AGENT_B = `0x${'2'.repeat(40)}`;
const EVALUATOR_AGENT = `0x${'3'.repeat(40)}`;

describe('aggregatePredictionBrierScoreboard', () => {
  it('aggregates injected scoreable query rows by shared Task and attribution', () => {
    const store = new Store(':memory:');
    try {
      store.saveEnvelopeProjection(brierProjection({
        id: 'operator-a',
        generatedAt: AS_OF - DAY_MS,
        requestId: 'request-a',
        participantSafeAddress: OPERATOR_A,
        participantAgentEoa: AGENT_A,
        executorImplName: 'prediction-v1-baseline',
        executorImplVersion: '1.0.0',
        executorRuntimeBundleDigest: 'sha256:runtime-a',
        executorPlugins: ['prediction-baseline@1.0.0'],
        solverBrier: '0.090000',
        consensusBrier: '0.160000',
        brierSpread: '-0.070000',
      }));
      store.saveEnvelopeProjection(brierProjection({
        id: 'operator-b',
        generatedAt: AS_OF - 2 * DAY_MS,
        requestId: 'request-b',
        participantSafeAddress: OPERATOR_B,
        participantAgentEoa: AGENT_B,
        executorImplName: 'prediction-v1-claude',
        executorImplVersion: '2.1.0',
        executorRuntimeBundleDigest: 'sha256:runtime-b',
        executorPlugins: ['prediction-baseline@1.0.0', 'polymarket-tool@0.2.0'],
        solverBrier: '0.250000',
        consensusBrier: '0.160000',
        brierSpread: '0.090000',
      }));

      const scoreableRows = queryScoreablePredictionBrierVerdicts(store, { taskCid: TASK_CID });
      const scoreboard = aggregatePredictionBrierScoreboard(scoreableRows, { asOfGeneratedAt: AS_OF });

      expect(scoreboard.overall.scoredVerdictCount).toBe(2);
      expect(scoreboard.overall.distinctTaskCount).toBe(1);
      expect(scoreboard.overall.activeOperatorCount).toBe(2);
      expect(scoreboard.overall.meanBrierSpread).toBeCloseTo(0.01);
      expect(scoreboard.overall.meanSolverBrier).toBeCloseTo(0.17);
      expect(scoreboard.overall.meanConsensusBrier).toBeCloseTo(0.16);
      expect(scoreboard.excluded).toMatchObject({
        totalInputRows: 2,
        includedRows: 2,
        nonScoredVerdictRows: 0,
        missingScoreRows: 0,
        nonNumericScoreRows: 0,
      });

      expect(scoreboard.perOperator.map((summary) => summary.participantSafeAddress).sort()).toEqual([
        OPERATOR_A,
        OPERATOR_B,
      ]);
      expect(scoreboard.perHarness.map((summary) => ({
        implName: summary.implName,
        implVersion: summary.implVersion,
        runtimeBundleDigest: summary.runtimeBundleDigest,
        scoredVerdictCount: summary.scoredVerdictCount,
      }))).toEqual([
        {
          implName: 'prediction-v1-baseline',
          implVersion: '1.0.0',
          runtimeBundleDigest: 'sha256:runtime-a',
          scoredVerdictCount: 1,
        },
        {
          implName: 'prediction-v1-claude',
          implVersion: '2.1.0',
          runtimeBundleDigest: 'sha256:runtime-b',
          scoredVerdictCount: 1,
        },
      ]);
      expect(scoreboard.perPlugin.map((summary) => ({
        plugin: summary.plugin,
        count: summary.scoredVerdictCount,
        taskCount: summary.distinctTaskCount,
      }))).toEqual([
        { plugin: 'prediction-baseline@1.0.0', count: 2, taskCount: 1 },
        { plugin: 'polymarket-tool@0.2.0', count: 1, taskCount: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it('excludes rejected, invalid, unresolved, incomplete, and non-numeric Verdict rows', () => {
    const scoreboard = aggregatePredictionBrierScoreboard([
      brierProjection({
        id: 'valid',
        generatedAt: AS_OF,
        solverBrier: '0.100000',
        consensusBrier: '0.250000',
        brierSpread: '-0.150000',
      }),
      brierProjection({ id: 'rejected', generatedAt: AS_OF, verdict: 'REJECTED' }),
      brierProjection({ id: 'invalid', generatedAt: AS_OF, verdict: 'INVALID' }),
      brierProjection({ id: 'unresolved', generatedAt: AS_OF, verdict: 'INDETERMINATE' }),
      brierProjection({
        id: 'incomplete',
        generatedAt: AS_OF,
        solverBrier: '0.100000',
        consensusBrier: '0.250000',
        brierSpread: undefined,
      }),
      brierProjection({
        id: 'non-numeric',
        generatedAt: AS_OF,
        solverBrier: 'not-a-number',
        consensusBrier: '0.250000',
        brierSpread: '0.150000',
      }),
      brierProjection({
        id: 'non-prediction',
        generatedAt: AS_OF,
        solverType: 'portfolio.v0',
      }),
    ], { asOfGeneratedAt: AS_OF });

    expect(scoreboard.overall.scoredVerdictCount).toBe(1);
    expect(scoreboard.overall.meanBrierSpread).toBeCloseTo(-0.15);
    expect(scoreboard.excluded).toMatchObject({
      totalInputRows: 7,
      includedRows: 1,
      nonPredictionVerdictRows: 1,
      nonScoredVerdictRows: 3,
      missingScoreRows: 1,
      nonNumericScoreRows: 1,
      outsideWindowRows: 0,
    });
  });

  it('uses Verdict generatedAt for trailing 84-day windowing', () => {
    const asOf = Date.parse('2026-05-01T12:00:00.000Z');
    const scoreboard = aggregatePredictionBrierScoreboard([
      brierProjection({
        id: 'inside',
        generatedAt: asOf - 83 * DAY_MS,
        solverBrier: '0.050000',
        consensusBrier: '0.250000',
        brierSpread: '-0.200000',
      }),
      brierProjection({
        id: 'boundary',
        generatedAt: asOf - 84 * DAY_MS,
        solverBrier: '0.300000',
        consensusBrier: '0.250000',
        brierSpread: '0.050000',
      }),
      brierProjection({
        id: 'too-old',
        generatedAt: asOf - 84 * DAY_MS - 1,
        solverBrier: '1.000000',
        consensusBrier: '0.100000',
        brierSpread: '0.900000',
      }),
      brierProjection({
        id: 'future',
        generatedAt: asOf + 1,
        solverBrier: '0.000000',
        consensusBrier: '0.900000',
        brierSpread: '-0.900000',
      }),
    ], { asOfGeneratedAt: asOf });

    expect(scoreboard.windowStartGeneratedAt).toBe(asOf - 84 * DAY_MS);
    expect(scoreboard.overall.scoredVerdictCount).toBe(2);
    expect(scoreboard.overall.meanBrierSpread).toBeCloseTo(-0.075);
    expect(scoreboard.excluded.outsideWindowRows).toBe(2);
    expect(scoreboard.weeklyTrend.reduce((count, bucket) => count + bucket.scoredVerdictCount, 0)).toBe(2);
  });

  it('joins scored Verdict rows to Solution projections for solver attribution', () => {
    const scoreboard = aggregatePredictionBrierScoreboard([
      solutionProjection({
        id: 'solver-a',
        participantSafeAddress: OPERATOR_A,
        participantAgentEoa: AGENT_A,
        executorImplName: 'prediction-v1-baseline',
        executorImplVersion: '1.0.0',
        executorRuntimeBundleDigest: 'sha256:solver-runtime',
        executorPlugins: ['solver-plugin@1.0.0'],
      }),
      brierProjection({
        id: 'solver-a',
        generatedAt: AS_OF,
        participantSafeAddress: EVALUATOR_OPERATOR,
        participantAgentEoa: EVALUATOR_AGENT,
        executorImplName: 'prediction-v1-evaluator',
        executorImplVersion: '1.0.0',
        executorRuntimeBundleDigest: 'sha256:evaluator-runtime',
        executorPlugins: ['evaluator-plugin@1.0.0'],
        solverBrier: '0.100000',
        consensusBrier: '0.250000',
        brierSpread: '-0.150000',
      }),
    ], { asOfGeneratedAt: AS_OF });

    expect(scoreboard.overall.scoredVerdictCount).toBe(1);
    expect(scoreboard.excluded.nonPredictionVerdictRows).toBe(1);
    expect(scoreboard.perOperator).toMatchObject([
      {
        participantSafeAddress: OPERATOR_A,
        participantAgentEoa: AGENT_A,
        scoredVerdictCount: 1,
      },
    ]);
    expect(scoreboard.perHarness).toMatchObject([
      {
        implName: 'prediction-v1-baseline',
        implVersion: '1.0.0',
        runtimeBundleDigest: 'sha256:solver-runtime',
        scoredVerdictCount: 1,
      },
    ]);
    expect(scoreboard.perPlugin.map((summary) => summary.plugin)).toEqual(['solver-plugin@1.0.0']);
  });
});

function brierProjection(args: {
  id: string;
  generatedAt: number;
  requestId?: string;
  solverType?: string;
  role?: 'restoration' | 'verdict';
  taskCid?: string | null;
  taskId?: string | null;
  verdict?: string;
  participantSafeAddress?: string | null;
  participantAgentEoa?: string | null;
  executorImplName?: string | null;
  executorImplVersion?: string | null;
  executorRuntimeBundleDigest?: string | null;
  executorPlugins?: string[];
  solverBrier?: string | number;
  consensusBrier?: string | number;
  brierSpread?: string | number;
}): EnvelopeProjection {
  const metadata: EnvelopeProjection['metadata'] = {
    verdict: args.verdict ?? 'SCORED',
  };
  if (args.solverBrier !== undefined) metadata['scores.solverBrier'] = args.solverBrier;
  if (args.consensusBrier !== undefined) metadata['scores.consensusBrier'] = args.consensusBrier;
  if (args.brierSpread !== undefined) metadata['scores.brierSpread'] = args.brierSpread;

  return {
    envelopeId: `verdict-${args.id}`,
    envelopeCid: `bafy-verdict-${args.id}`,
    envelopeSha256: null,
    signatureHash: `0x${args.id.padEnd(64, '0').slice(0, 64)}`,
    solverType: args.solverType ?? 'prediction.v1',
    role: args.role ?? 'verdict',
    taskCid: args.taskCid === undefined ? TASK_CID : args.taskCid,
    taskId: args.taskId === undefined ? TASK_ID : args.taskId,
    requestId: args.requestId ?? `request-${args.id}`,
    generatedAt: args.generatedAt,
    evidenceTier: 'self-signed',
    participantSafeAddress: args.participantSafeAddress === undefined ? OPERATOR_A : args.participantSafeAddress,
    participantAgentEoa: args.participantAgentEoa === undefined ? AGENT_A : args.participantAgentEoa,
    executorImplName: args.executorImplName === undefined ? 'prediction-v1-evaluator' : args.executorImplName,
    executorImplVersion: args.executorImplVersion === undefined ? '1.0.0' : args.executorImplVersion,
    executorRuntimeBundleDigest: args.executorRuntimeBundleDigest === undefined
      ? 'sha256:runtime-default'
      : args.executorRuntimeBundleDigest,
    executorPlugins: args.executorPlugins ?? ['prediction-baseline@1.0.0'],
    solutionEnvelopeCid: `bafy-solution-${args.id}`,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: `bafy-solution-${args.id}`,
    metadata,
  };
}

function solutionProjection(args: {
  id: string;
  generatedAt?: number;
  participantSafeAddress?: string | null;
  participantAgentEoa?: string | null;
  executorImplName?: string | null;
  executorImplVersion?: string | null;
  executorRuntimeBundleDigest?: string | null;
  executorPlugins?: string[];
}): EnvelopeProjection {
  return {
    envelopeId: `solution-${args.id}`,
    envelopeCid: `bafy-solution-${args.id}`,
    envelopeSha256: `sha256-solution-${args.id}`,
    signatureHash: `0x${args.id.padEnd(64, '1').slice(0, 64)}`,
    solverType: 'prediction.v1',
    role: 'solution',
    taskCid: TASK_CID,
    taskId: TASK_ID,
    requestId: `request-${args.id}`,
    generatedAt: args.generatedAt ?? AS_OF - DAY_MS,
    evidenceTier: 'self-signed',
    participantSafeAddress: args.participantSafeAddress === undefined ? OPERATOR_A : args.participantSafeAddress,
    participantAgentEoa: args.participantAgentEoa === undefined ? AGENT_A : args.participantAgentEoa,
    executorImplName: args.executorImplName === undefined ? 'prediction-v1-baseline' : args.executorImplName,
    executorImplVersion: args.executorImplVersion === undefined ? '1.0.0' : args.executorImplVersion,
    executorRuntimeBundleDigest: args.executorRuntimeBundleDigest === undefined
      ? 'sha256:runtime-default'
      : args.executorRuntimeBundleDigest,
    executorPlugins: args.executorPlugins ?? ['prediction-baseline@1.0.0'],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
  };
}
