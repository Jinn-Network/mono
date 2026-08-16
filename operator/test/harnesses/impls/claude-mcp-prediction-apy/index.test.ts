import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeMcpPredictionApyImpl } from '../../../../src/harnesses/impls/claude-mcp-prediction-apy/index.js';
import { makeHarnessCtx } from '@test/harness-ctx.js';

function makeTask() {
  const now = Date.now();
  const startTs = now;
  const endTs = startTs + 3_600_000;
  const resolveTs = endTs + 900_000;
  return {
    id: 'test-apy-1',
    description: 'USDC supply APY TWA',
    window: { startTs, endTs },
    spec: {
      kind: 'prediction.apy.v0',
      oracle: {
        venue: 'aave-v3-base-sepolia',
        pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
        reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
        reserveSymbol: 'USDC',
      },
      metric: {
        type: 'supply-apy-twa-bps',
        twaWindowSeconds: 3600,
        sampleCount: 12,
        toleranceBps: 50,
      },
      question: { resolveTs },
    },
    eligibility: { maxSubmissionDelayMs: 60_000 },
  } as unknown as import('../../../../src/types/task.js').Task;
}

function makeCtx() {
  return makeHarnessCtx({
task: makeTask(),
    prefix: 'apy-claude-test-',
    separateDirs: true,
    msUntilEndTs: () => 3_600_000,
  });
}

describe('ClaudeMcpPredictionApyImpl (mocked session)', () => {
  it('supports prediction.apy.v0 restoration only', () => {
    const impl = new ClaudeMcpPredictionApyImpl();
    expect(impl.supports({ solverType: 'prediction.apy.v0', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.apy.v0' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.apy.v0', role: 'evaluation' })).toBe(false);
    expect(impl.supports({ solverType: 'prediction.v0', role: 'restoration' })).toBe(false);
  });

  it('returns Solution when runSession signals a valid submission', async () => {
    const ctx = makeCtx();
    const impl = new ClaudeMcpPredictionApyImpl({
      claudeModel: 'claude-haiku-4-5-20251001',
      _testDeps: {
        runSession: async ({ sessionId, workingDir, signalSubmit }) => {
          signalSubmit('350', 'observed rate');
          const sessionDir = join(workingDir, 'sessions', sessionId);
          mkdirSync(sessionDir, { recursive: true });
          const transcriptPath = join(sessionDir, 'transcript.txt');
          (await import('node:fs')).writeFileSync(transcriptPath, 'mock transcript');
          const now = Date.now();
          return {
            sessionId,
            startedAt: now - 1000,
            endedAt: now,
            transcriptPath,
            submitted: true,
            stdout: 'mock stdout',
            aborted: false,
          };
        },
      },
    });
    const out = await impl.run(ctx);

    expect(out.gating.predictedBps).toBe('350');
    expect(out.gating.modelId).toContain('claude-mcp-prediction-apy');
    expect(out.informational?.rationale).toBe('observed rate');
    expect(out.artifacts).toHaveLength(2);
    expect(out.artifacts![0]!.path).toBe('prediction-apy.json');
    expect(out.artifacts![0]!.artifactType).toBe('prediction_submission');
    expect(out.artifacts![1]!.artifactType).toBe('session_transcript');

    const predictionPath = join(ctx.workingDir, 'prediction-apy.json');
    expect(existsSync(predictionPath)).toBe(true);
    const payload = JSON.parse(readFileSync(predictionPath, 'utf-8'));
    expect(payload.predictedBps).toBe('350');
    expect(payload.rationale).toBe('observed rate');
    expect(payload.modelId).toContain('claude-mcp-prediction-apy');

    // solutionPayload must match PredictionApyV0RestorationPayloadSchema
    const { PredictionApyV0RestorationPayloadSchema } = await import('../../../../src/types/payloads/prediction-apy-v0.js');
    expect(out.solutionPayload).toBeDefined();
    const parsed = PredictionApyV0RestorationPayloadSchema.safeParse(out.solutionPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prediction.predictedBps).toBe('350');
      expect(typeof parsed.data.prediction.submittedAt).toBe('number');
      expect(parsed.data.prediction.modelId).toContain('claude-mcp-prediction-apy');
    }
  });

  it('throws when session ends without submit_apy_prediction', async () => {
    const ctx = makeCtx();
    const impl = new ClaudeMcpPredictionApyImpl({
      _testDeps: {
        runSession: async ({ sessionId, workingDir }) => {
          const sessionDir = join(workingDir, 'sessions', sessionId);
          mkdirSync(sessionDir, { recursive: true });
          const transcriptPath = join(sessionDir, 'transcript.txt');
          (await import('node:fs')).writeFileSync(transcriptPath, 'no submission');
          const now = Date.now();
          return {
            sessionId,
            startedAt: now - 500,
            endedAt: now,
            transcriptPath,
            submitted: false,
            stdout: '',
            aborted: false,
          };
        },
      },
    });
    await expect(impl.run(ctx)).rejects.toThrow(/ended without a valid submit_apy_prediction call/);
  });

  it('canAttempt rejects tasks with an already-closed window', async () => {
    const impl = new ClaudeMcpPredictionApyImpl();
    const task = makeTask();
    const startTs = 1_000_000;
    const endTs = startTs + 3_600_000;
    const resolveTs = endTs + 900_000;
    (task as unknown as Record<string, unknown>).window = { startTs, endTs };
    (task as unknown as Record<string, Record<string, Record<string, unknown>>>).spec.question.resolveTs = resolveTs;
    const r = await impl.canAttempt(task);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/window already closed/);
  });
});
