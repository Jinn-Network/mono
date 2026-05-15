import { describe, expect, it } from 'vitest';
import {
  aggregatePredictionBrierScoreboard,
  buildPredictionBrierScoreboard,
  renderPredictionBrierScoreboardMarkdown,
} from '../../src/corpus/index.js';
import type { EnvelopeProjection } from '../../src/corpus/types.js';
import { Store } from '../../src/store/store.js';

const AS_OF = Date.parse('2026-05-03T00:00:00.000Z');
const DAY_MS = 86_400_000;

describe('renderPredictionBrierScoreboardMarkdown', () => {
  it('bounds historical report queries before limit and fetches Solution attribution separately', () => {
    const store = new Store(':memory:');
    try {
      store.saveEnvelopeProjection(solutionProjection('a', {
        safe: `0x${'a'.repeat(40)}`,
        agent: `0x${'1'.repeat(40)}`,
        harness: 'solver-harness',
        version: '1.0.0',
        runtimeDigest: 'sha256:solver-runtime',
        plugins: ['solver-plugin@1.0.0'],
        generatedAt: AS_OF - 120 * DAY_MS,
      }));
      store.saveEnvelopeProjection(scoredVerdictProjection('a', {
        generatedAt: AS_OF - DAY_MS,
        solverBrier: '0.090000',
        consensusBrier: '0.160000',
        brierSpread: '-0.070000',
      }));
      store.saveEnvelopeProjection(scoredVerdictProjection('newer', {
        generatedAt: AS_OF + DAY_MS,
        solverBrier: '0.990000',
        consensusBrier: '0.010000',
        brierSpread: '0.980000',
      }));

      const scoreboard = buildPredictionBrierScoreboard(store, {
        asOfGeneratedAt: AS_OF,
        projectionQuery: { limit: 1 },
      });

      expect(scoreboard.overall.scoredVerdictCount).toBe(1);
      expect(scoreboard.overall.meanBrierSpread).toBeCloseTo(-0.07);
      expect(scoreboard.perOperator).toMatchObject([
        {
          participantSafeAddress: `0x${'a'.repeat(40)}`,
          scoredVerdictCount: 1,
        },
      ]);
      expect(scoreboard.perHarness).toMatchObject([
        {
          implName: 'solver-harness',
          runtimeBundleDigest: 'sha256:solver-runtime',
          scoredVerdictCount: 1,
        },
      ]);
      expect(scoreboard.perPlugin.map((summary) => summary.plugin)).toEqual(['solver-plugin@1.0.0']);
    } finally {
      store.close();
    }
  });

  it('renders a deterministic Markdown report with headline, trend, attribution, and exclusions', () => {
    const scoreboard = aggregatePredictionBrierScoreboard([
      solutionProjection('a', {
        safe: `0x${'a'.repeat(40)}`,
        agent: `0x${'1'.repeat(40)}`,
        harness: 'solver-harness',
        version: '1.0.0',
        runtimeDigest: 'sha256:solver-runtime',
        plugins: ['solver-plugin@1.0.0'],
      }),
      scoredVerdictProjection('a', {
        generatedAt: AS_OF - DAY_MS,
        solverBrier: '0.090000',
        consensusBrier: '0.160000',
        brierSpread: '-0.070000',
      }),
      scoredVerdictProjection('rejected', {
        verdict: 'REJECTED',
        generatedAt: AS_OF,
      }),
    ], { asOfGeneratedAt: AS_OF });

    const markdown = renderPredictionBrierScoreboardMarkdown(scoreboard, {
      generatedAtIso: '2026-05-03T12:00:00.000Z',
    });

    expect(markdown).toContain('# Prediction SolverNet Scoreboard');
    expect(markdown).toContain('Generated: 2026-05-03T12:00:00.000Z');
    expect(markdown).toContain('Status: OK');
    expect(markdown).toContain('| Mean Brier spread | -0.070000 |');
    expect(markdown).toContain('| Scored Verdicts | 1 |');
    expect(markdown).toContain('| Active operators | 1 |');
    expect(markdown).toContain(`| 0x${'a'.repeat(40)} | 1 | -0.070000 | 0.090000 | 0.160000 | 1 |`);
    expect(markdown).toContain('| solver-harness@1.0.0 | sha256:solver-runtime | 1 | -0.070000 | 1 |');
    expect(markdown).toContain('| solver-plugin@1.0.0 | 1 | -0.070000 | 1 |');
    expect(markdown).toContain('| Non-SCORED Verdict rows | 1 |');
    expect(markdown).toMatchSnapshot();
  });

  it('renders an insufficient-data state', () => {
    const scoreboard = aggregatePredictionBrierScoreboard([], { asOfGeneratedAt: AS_OF });
    const markdown = renderPredictionBrierScoreboardMarkdown(scoreboard, {
      generatedAtIso: '2026-05-03T12:00:00.000Z',
    });

    expect(markdown).toContain('Status: INSUFFICIENT_DATA');
    expect(markdown).toContain('Insufficient scoreable Verdict data.');
  });
});

function solutionProjection(id: string, args: {
  safe: string;
  agent: string;
  harness: string;
  version: string;
  runtimeDigest: string;
  plugins: string[];
  generatedAt?: number;
}): EnvelopeProjection {
  return {
    envelopeId: `solution-${id}`,
    envelopeCid: `bafy-solution-${id}`,
    envelopeSha256: `sha256-solution-${id}`,
    signatureHash: `0x${id.padEnd(64, '1').slice(0, 64)}`,
    solverType: 'prediction.v1',
    role: 'solution',
    taskCid: 'bafy-task-shared',
    taskId: 'prediction-v1-polymarket-abc',
    requestId: `solution-request-${id}`,
    generatedAt: args.generatedAt ?? AS_OF - 2 * DAY_MS,
    evidenceTier: 'self-signed',
    participantSafeAddress: args.safe,
    participantAgentEoa: args.agent,
    executorImplName: args.harness,
    executorImplVersion: args.version,
    executorRuntimeBundleDigest: args.runtimeDigest,
    executorPlugins: args.plugins,
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
  };
}

function scoredVerdictProjection(id: string, args: {
  verdict?: string;
  generatedAt: number;
  solverBrier?: string;
  consensusBrier?: string;
  brierSpread?: string;
}): EnvelopeProjection {
  const metadata: EnvelopeProjection['metadata'] = {
    verdict: args.verdict ?? 'SCORED',
    'solutionEnvelope.cid': `bafy-solution-${id}`,
  };
  if (args.solverBrier !== undefined) metadata['scores.solverBrier'] = args.solverBrier;
  if (args.consensusBrier !== undefined) metadata['scores.consensusBrier'] = args.consensusBrier;
  if (args.brierSpread !== undefined) metadata['scores.brierSpread'] = args.brierSpread;

  return {
    envelopeId: `verdict-${id}`,
    envelopeCid: `bafy-verdict-${id}`,
    envelopeSha256: null,
    signatureHash: `0x${id.padEnd(64, '2').slice(0, 64)}`,
    solverType: 'prediction.v1',
    role: 'verdict',
    taskCid: 'bafy-task-shared',
    taskId: 'prediction-v1-polymarket-abc',
    requestId: `verdict-request-${id}`,
    generatedAt: args.generatedAt,
    evidenceTier: 'self-signed',
    participantSafeAddress: `0x${'e'.repeat(40)}`,
    participantAgentEoa: `0x${'3'.repeat(40)}`,
    executorImplName: 'prediction-v1-evaluator',
    executorImplVersion: '1.0.0',
    executorRuntimeBundleDigest: 'sha256:evaluator-runtime',
    executorPlugins: ['evaluator-plugin@1.0.0'],
    solutionEnvelopeCid: `bafy-solution-${id}`,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: `bafy-solution-${id}`,
    metadata,
  };
}
