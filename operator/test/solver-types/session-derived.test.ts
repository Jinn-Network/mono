import { describe, expect, it } from 'vitest';
import { sessionDerived } from '../../src/solver-types/session-derived.js';
import { SOLVER_TYPES } from '../../src/solver-types/index.js';
import { distillCaptureToTasks } from '../../src/solver-types/_session-derived-distill.js';
import { SessionDerivedState } from '../../src/solver-types/_session-derived-state.js';
import { captureDedupKey } from '../../src/solver-types/_session-derived-pool.js';

const captureEnvelope = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'capture',
  role: 'capture',
  signature: { algo: 'secp256k1', signer: `0x${'1'.repeat(40)}`, hash: `0x${'a'.repeat(64)}`, sig: '0x' },
  sessionProvenance: {
    sessionId: 'sess-1',
    capturedAt: '2026-05-08T00:00:00.000Z',
    originatingTool: { name: 'codex' },
    repo: { remoteUrl: 'git@example.com:repo.git', commitHash: 'b'.repeat(40) },
    license: { operatorAssertion: 'unspecified' },
  },
} as any;

describe('session-derived SolverType', () => {
  it('is registered in the solver type table', () => {
    expect(SOLVER_TYPES['session-derived.v1']).toBe(sessionDerived);
  });

  it('parses a session-derived Task spec', async () => {
    const parsed = await sessionDerived.parseSpec({
      schemaVersion: 'session-derived-task.v1',
      sourceCaptureCid: 'bafycapture',
      problemStatement: 'Fix the captured parser failure.',
      expectedArtifacts: {},
      signalHints: [],
      distillation: {
        promptSha256: 'c'.repeat(64),
        model: 'gpt-test',
        distilledAt: '2026-05-08T00:00:00.000Z',
      },
    });
    expect(parsed.eligibility.sourceCaptureCid).toBe('bafycapture');
  });

  it('distills accepted drafts into Tasks and rejects vague drafts', async () => {
    const result = await distillCaptureToTasks({
      envelope: captureEnvelope,
      sourceCaptureCid: 'bafycapture',
      trajectoryText: 'span text',
      model: 'gpt-test',
      now: new Date('2026-05-08T00:00:00.000Z'),
      distill: async () => [
        { problemStatement: 'Fix the deterministic parser failure in the captured repository.', signalHints: ['test failed'] },
        { problemStatement: 'Do stuff' },
      ],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].spec?.sourceCaptureCid).toBe('bafycapture');
    expect(result.rejected[0].reason).toBe('problem_statement_too_short');
  });

  it('tracks processed captures and builds repo/session dedup keys', () => {
    const state = new SessionDerivedState({ processedCaptureCids: ['bafyold'] });
    expect(state.hasProcessed('bafyold')).toBe(true);
    state.markProcessed('bafynew');
    expect(state.snapshot().processedCaptureCids).toEqual(['bafynew', 'bafyold']);
    expect(captureDedupKey(captureEnvelope, 'fallback')).toContain('sess-1');
  });
});
