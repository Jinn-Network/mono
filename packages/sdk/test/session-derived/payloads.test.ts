import { describe, expect, it } from 'vitest';
import {
  SessionDerivedSolutionSchema,
  SessionDerivedTaskSchema,
  SessionDerivedVerdictSchema,
} from '../../src/payloads/session-derived.js';

describe('session-derived payload schemas', () => {
  it('accepts a distilled Task with source capture provenance', () => {
    expect(() => SessionDerivedTaskSchema.parse({
      schemaVersion: 'session-derived-task.v1',
      sourceCaptureCid: 'bafycapture',
      repo: { remoteUrl: 'git@example.com:repo.git', commitHash: 'a'.repeat(40) },
      problemStatement: 'Fix the failing parser test.',
      expectedArtifacts: { testSuiteRef: 'bafytests' },
      signalHints: ['parser failure reproduced in captured trajectory'],
      distillation: {
        promptSha256: 'b'.repeat(64),
        model: 'gpt-test',
        distilledAt: '2026-05-08T00:00:00.000Z',
      },
    })).not.toThrow();
  });

  it('requires a Solution to carry either a patch or artifact output', () => {
    expect(() => SessionDerivedSolutionSchema.parse({
      schemaVersion: 'session-derived-solution.v1',
      patch: 'diff --git a/a b/a\n',
    })).not.toThrow();
    expect(() => SessionDerivedSolutionSchema.parse({
      schemaVersion: 'session-derived-solution.v1',
      artifacts: [],
    })).toThrow();
  });

  it('accepts a scored Verdict with per-signal breakdown', () => {
    const signal = { present: true, score: 0.8, weight: 0.5 };
    expect(() => SessionDerivedVerdictSchema.parse({
      schemaVersion: 'session-derived-verdict.v1',
      verdict: 'SCORED',
      compositeScore: 0.8,
      signalBreakdown: {
        testSuiteRerun: signal,
        structuralSimilarity: { present: false, score: 0, weight: 0.3 },
        llmJudge: { present: true, score: 0.8, weight: 0.2, reasoning: 'Adequate fix.' },
      },
      evaluatorCostUsd: 0.01,
    })).not.toThrow();
  });
});
