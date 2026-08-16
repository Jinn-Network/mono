import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeMcpPredictionImpl } from '../../../../src/harnesses/impls/claude-mcp-prediction/index.js';
import { makeHarnessCtx } from '@test/harness-ctx.js';

function makeTask() {
  return {
    id: 'test-1',
    description: 'ETH > 3000 at T',
    window: { startTs: 0, endTs: 3_600_000 },
    spec: {
      kind: 'prediction.v1',
      oracle: {
        venue: 'chainlink-base-sepolia',
        feed: '0x000000000000000000000000000000000000feed',
        feedDescription: 'ETH / USD',
      },
      question: {
        kind: 'threshold',
        operator: 'GT',
        threshold: '3000',
        resolveTs: 4_500_000,
      },
    },
    eligibility: { maxSubmissionDelayMs: 60_000 },
  } as unknown as import('../../../../src/types/task.js').Task;
}

function makeCtx() {
  // separateDirs=true allocates separate workingDir + implStateDir under one temp root,
  // matching the original helper's layout.
  return makeHarnessCtx({
task: makeTask(),
    prefix: 'pred-claude-test-',
    separateDirs: true,
    msUntilEndTs: () => 3_600_000,
  });
}

describe('ClaudeMcpPredictionImpl (mocked session)', () => {
  it('supports prediction.v1 restoration only', () => {
    const impl = new ClaudeMcpPredictionImpl();
    expect(impl.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.v1' })).toBe(true);
    expect(impl.supports({ solverType: 'prediction.v1', role: 'evaluation' })).toBe(false);
    expect(impl.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(false);
    expect(impl.supports({ solverType: '', role: 'restoration' })).toBe(false);
  });

  it('returns PASS-shape Solution when runSession signals a valid submission', async () => {
    const ctx = makeCtx();
    const impl = new ClaudeMcpPredictionImpl({
      claudeModel: 'claude-haiku-4-5-20251001',
      _testDeps: {
        runSession: async ({ sessionId, workingDir, signalSubmit }) => {
          // Simulate: Claude called submit_prediction with 0.62
          signalSubmit('0.6200', 'Current price suggests upside');
          // Create a fake transcript path as the real orchestrator would.
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

    expect(out.gating.probability).toBe('0.6200');
    expect(out.gating.modelId).toContain('claude-mcp-prediction');
    expect(out.informational?.rationale).toBe('Current price suggests upside');
    expect(out.artifacts).toHaveLength(2);
    expect(out.artifacts![0]!.path).toBe('prediction.json');
    expect(out.artifacts![0]!.artifactType).toBe('prediction_submission');
    expect(out.artifacts![1]!.artifactType).toBe('session_transcript');

    // prediction.json was written to workingDir.
    const predictionPath = join(ctx.workingDir, 'prediction.json');
    expect(existsSync(predictionPath)).toBe(true);
    const payload = JSON.parse(readFileSync(predictionPath, 'utf-8'));
    expect(payload.probability).toBe('0.6200');
    expect(payload.rationale).toBe('Current price suggests upside');
    expect(payload.modelId).toContain('claude-mcp-prediction');

    // solutionPayload must match PredictionV0RestorationPayloadSchema
    const { PredictionV0RestorationPayloadSchema } = await import('../../../../src/types/payloads/prediction-v0.js');
    expect(out.solutionPayload).toBeDefined();
    const parsed = PredictionV0RestorationPayloadSchema.safeParse(out.solutionPayload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.prediction.probability).toBe('0.6200');
      expect(typeof parsed.data.prediction.submittedAt).toBe('number');
      expect(parsed.data.prediction.modelId).toContain('claude-mcp-prediction');
      // rationale is in informational only (free-form string, not the schema's { ts, note }[] shape)
      expect(out.solutionPayload!['rationale']).toBeUndefined();
    }
  });

  it('throws descriptively when session ends without submit_prediction', async () => {
    const ctx = makeCtx();
    const impl = new ClaudeMcpPredictionImpl({
      _testDeps: {
        runSession: async ({ sessionId, workingDir }) => {
          const sessionDir = join(workingDir, 'sessions', sessionId);
          mkdirSync(sessionDir, { recursive: true });
          const transcriptPath = join(sessionDir, 'transcript.txt');
          (await import('node:fs')).writeFileSync(transcriptPath, 'no submission');
          const now = Date.now();
          // Do NOT call signalSubmit.
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
    await expect(impl.run(ctx)).rejects.toThrow(/ended without a valid submit_prediction call/);
  });

  it('canAttempt rejects tasks with an already-closed window', async () => {
    const impl = new ClaudeMcpPredictionImpl();
    const task = makeTask();
    // Shift the whole window into the past while preserving Zod refinements
    // (endTs - startTs === 3_600_000; resolveTs === endTs + 900_000).
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
