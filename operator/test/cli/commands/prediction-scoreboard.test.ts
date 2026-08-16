import { describe, expect, it } from 'vitest';
import { createPredictionScoreboardCommand } from '@/cli/commands/prediction-scoreboard.js';
import { runCommand } from '@test/cli.js';
import type { EnvelopeProjection } from '@/corpus/types.js';

const AS_OF = Date.parse('2026-05-03T00:00:00.000Z');

describe('prediction-scoreboard command', () => {
  it('writes a Markdown report from local prediction projections', async () => {
    const writes = new Map<string, string>();
    const cmd = createPredictionScoreboardCommand({
      loadConfig: () => ({ dbPath: '/tmp/prediction-scoreboard.db' }) as any,
      getConfigPathFromArgs: () => undefined,
      storeFactory: () => ({
        queryEnvelopeProjections: () => [
          solutionProjection('a'),
          scoredVerdictProjection('a'),
        ],
        close: () => {},
      }),
      writeTextFile: (path, content) => {
        writes.set(path, content);
      },
      nowIso: () => '2026-05-03T12:00:00.000Z',
    });

    const { envelopes, exits } = await runCommand(cmd, {
      argv: ['--output', '/tmp/prediction-scoreboard.md', '--as-of', String(AS_OF)],
    });

    expect(exits).toEqual([]);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      outputPath: '/tmp/prediction-scoreboard.md',
      scoredVerdictCount: 1,
      distinctTaskCount: 1,
      activeOperatorCount: 1,
      meanBrierSpread: -0.15,
      status: 'ok',
    });
    expect(writes.get('/tmp/prediction-scoreboard.md')).toContain('| Mean Brier spread | -0.150000 |');
  });

  it('emits a clear error for invalid --as-of', async () => {
    const cmd = createPredictionScoreboardCommand({
      loadConfig: () => ({ dbPath: '/tmp/prediction-scoreboard.db' }) as any,
      getConfigPathFromArgs: () => undefined,
      storeFactory: () => ({
        queryEnvelopeProjections: () => [],
        close: () => {},
      }),
      writeTextFile: () => {},
      nowIso: () => '2026-05-03T12:00:00.000Z',
    });

    const { envelopes, exits } = await runCommand(cmd, { argv: ['--as-of', 'not-a-date'] });

    expect(exits).toEqual([11]);
    expect(envelopes[0]).toMatchObject({
      code: 'invalid_invocation',
      details: { field: '--as-of' },
    });
  });
});

function solutionProjection(id: string): EnvelopeProjection {
  return {
    envelopeId: `solution-${id}`,
    envelopeCid: `bafy-solution-${id}`,
    envelopeSha256: null,
    signatureHash: `0x${id.padEnd(64, '1').slice(0, 64)}`,
    solverType: 'prediction.v1',
    role: 'solution',
    taskCid: 'bafy-task-shared',
    taskId: 'prediction-v1-polymarket-abc',
    requestId: `solution-request-${id}`,
    generatedAt: AS_OF - 1_000,
    evidenceTier: 'self-signed',
    participantSafeAddress: `0x${'a'.repeat(40)}`,
    participantAgentEoa: `0x${'1'.repeat(40)}`,
    executorImplName: 'solver-harness',
    executorImplVersion: '1.0.0',
    executorRuntimeBundleDigest: 'sha256:solver-runtime',
    executorPlugins: ['solver-plugin@1.0.0'],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
  };
}

function scoredVerdictProjection(id: string): EnvelopeProjection {
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
    generatedAt: AS_OF,
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
    metadata: {
      verdict: 'SCORED',
      'scores.solverBrier': '0.100000',
      'scores.consensusBrier': '0.250000',
      'scores.brierSpread': '-0.150000',
      'solutionEnvelope.cid': `bafy-solution-${id}`,
    },
  };
}
