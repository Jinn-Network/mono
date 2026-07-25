import { describe, expect, it, vi } from 'vitest';
import {
  makeConfiguredSemanticEvaluatorRunnerResolver,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/semantic-runner-resolver.js';

describe('configured semantic evaluator runner resolver', () => {
  it('resolves only an exact joined evaluator manifest using the semantic evaluator harness', async () => {
    const runner = { run: vi.fn() };
    const createClaudeRunner = vi.fn(() => runner);
    let claudePath = '/trusted/claude';
    let joinedSolverNets = {
      'bafy-reviewer': {
        manifestCid: 'bafy-reviewer',
        name: 'Autopilot reviewers',
        roles: ['evaluator'] as const,
        harness: 'jinn-repo-evaluator',
        model: 'claude-sonnet-4-5',
      },
      'bafy-solver-only': {
        manifestCid: 'bafy-solver-only',
        roles: ['solver'] as const,
        harness: 'jinn-repo-evaluator',
      },
      'bafy-wrong-harness': {
        manifestCid: 'bafy-wrong-harness',
        roles: ['evaluator'] as const,
        harness: 'codex',
      },
    };
    const resolver = makeConfiguredSemanticEvaluatorRunnerResolver({
      getJoinedSolverNets: () => joinedSolverNets,
      getClaudePath: () => claudePath,
      createClaudeRunner,
    });

    expect(resolver.resolve({ manifestCid: 'bafy-reviewer' }))
      .toEqual({
        provider: 'anthropic',
        runner,
        model: 'claude-sonnet-4-5',
      });
    expect(resolver.resolve({ manifestCid: 'bafy-solver-only' }))
      .toBeUndefined();
    expect(resolver.resolve({ manifestCid: 'bafy-wrong-harness' }))
      .toBeUndefined();
    expect(resolver.resolve({ manifestCid: 'bafy-unknown' }))
      .toBeUndefined();
    expect(resolver.resolve({})).toBeUndefined();

    expect(createClaudeRunner).toHaveBeenCalledTimes(1);
    expect(createClaudeRunner).toHaveBeenCalledWith({
      claudePath: '/trusted/claude',
    });

    joinedSolverNets = {
      ...joinedSolverNets,
      'bafy-hot-join': {
        manifestCid: 'bafy-hot-join',
        roles: ['evaluator'],
        harness: 'jinn-repo-evaluator',
        model: 'claude-opus-4-1',
      },
    };
    expect(resolver.resolve({ manifestCid: 'bafy-hot-join' }))
      .toMatchObject({ model: 'claude-opus-4-1' });
    claudePath = '/updated/claude';
    expect(resolver.resolve({ manifestCid: 'bafy-hot-join' }))
      .toMatchObject({ model: 'claude-opus-4-1' });
    expect(createClaudeRunner).toHaveBeenLastCalledWith({
      claudePath: '/updated/claude',
    });
  });

  it('fails closed when the map key and persisted manifest CID disagree', async () => {
    const resolver = makeConfiguredSemanticEvaluatorRunnerResolver({
      getJoinedSolverNets: () => ({
        'bafy-key': {
          manifestCid: 'bafy-other',
          roles: ['evaluator'],
          harness: 'jinn-repo-evaluator',
        },
      }),
      getClaudePath: () => 'claude',
    });

    expect(resolver.resolve({ manifestCid: 'bafy-key' }))
      .toBeUndefined();
    expect(resolver.resolve({ manifestCid: 'bafy-other' }))
      .toBeUndefined();
  });
});
