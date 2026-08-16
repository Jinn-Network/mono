import { describe, expect, it, vi } from 'vitest';
import {
  makeConfiguredSemanticEvaluatorRunnerResolver,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/semantic-runner-resolver.js';

describe('configured semantic evaluator runner resolver', () => {
  it('resolves only an exact wiring evaluator digest using the semantic evaluator harness', async () => {
    const runner = { run: vi.fn() };
    const createClaudeRunner = vi.fn(() => runner);
    let claudePath = '/trusted/claude';
    let executionWiring = [
      {
        workKind: 'jinn-repo.v1',
        harness: 'jinn-repo-evaluator',
        model: 'claude-sonnet-4-5',
        plugins: [],
        legacyManifestDigest: 'bafy-reviewer',
      },
      {
        workKind: 'jinn-repo.v1',
        harness: 'codex',
        plugins: [],
        legacyManifestDigest: 'bafy-wrong-harness',
      },
    ];
    const resolver = makeConfiguredSemanticEvaluatorRunnerResolver({
      getExecutionWiring: () => executionWiring,
      getClaudePath: () => claudePath,
      createClaudeRunner,
    });

    expect(resolver.resolve({ manifestCid: 'bafy-reviewer' }))
      .toEqual({
        provider: 'anthropic',
        runner,
        model: 'claude-sonnet-4-5',
      });
    expect(resolver.resolve({ manifestCid: 'bafy-wrong-harness' }))
      .toBeUndefined();
    expect(resolver.resolve({ manifestCid: 'bafy-unknown' }))
      .toBeUndefined();
    expect(resolver.resolve({})).toBeUndefined();

    expect(createClaudeRunner).toHaveBeenCalledTimes(1);
    expect(createClaudeRunner).toHaveBeenCalledWith({
      claudePath: '/trusted/claude',
    });

    executionWiring = [
      ...executionWiring,
      {
        workKind: 'jinn-repo.v1',
        harness: 'jinn-repo-evaluator',
        model: 'claude-opus-4-1',
        plugins: [],
        legacyManifestDigest: 'bafy-hot-join',
      },
    ];
    expect(resolver.resolve({ manifestCid: 'bafy-hot-join' }))
      .toMatchObject({ model: 'claude-opus-4-1' });
    claudePath = '/updated/claude';
    expect(resolver.resolve({ manifestCid: 'bafy-hot-join' }))
      .toMatchObject({ model: 'claude-opus-4-1' });
    expect(createClaudeRunner).toHaveBeenLastCalledWith({
      claudePath: '/updated/claude',
    });
  });

  it('fails closed when the wiring digest does not match the lookup CID', async () => {
    const resolver = makeConfiguredSemanticEvaluatorRunnerResolver({
      getExecutionWiring: () => ([
        {
          workKind: 'jinn-repo.v1',
          harness: 'jinn-repo-evaluator',
          plugins: [],
          legacyManifestDigest: 'bafy-other',
        },
      ]),
      getClaudePath: () => 'claude',
    });

    expect(resolver.resolve({ manifestCid: 'bafy-key' }))
      .toBeUndefined();
    expect(resolver.resolve({ manifestCid: 'bafy-other' }))
      .toMatchObject({ provider: 'anthropic' });
  });
});
