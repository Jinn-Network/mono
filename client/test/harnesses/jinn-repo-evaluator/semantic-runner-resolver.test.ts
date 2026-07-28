import { describe, expect, it, vi } from 'vitest';
import {
  makeConfiguredSemanticEvaluatorRunnerResolver,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/semantic-runner-resolver.js';
import type {
  JoinedSolverNetConfig,
} from '../../../src/solver-nets/registry.js';

const CANONICAL_CID =
  'bafkreihvpooczub6s7c3yuraotwe43xbu4dliowmnkymegct66ddgrlaoa';

function exactCodexEntry(): JoinedSolverNetConfig {
  return {
    manifestCid: CANONICAL_CID,
    contract: { id: 'jinn-repo', version: 'v1' },
    roles: ['solver', 'evaluator'],
    harness: 'codex',
    model: 'gpt-5.4-mini',
    semanticEvaluator: {
      runtime: 'codex',
      model: 'gpt-5.4-mini',
      auth: 'chatgpt-oauth-only',
    },
  };
}

describe('configured semantic evaluator runner resolver', () => {
  it('resolves Codex only for the exact canonical dual-role profile', () => {
    const codexRunner = { run: vi.fn() };
    const createCodexRunner = vi.fn(() => codexRunner);
    const exactEntry = exactCodexEntry();
    let codexPath = '/trusted/codex';
    const resolver = makeConfiguredSemanticEvaluatorRunnerResolver({
      getJoinedSolverNets: () => ({ [CANONICAL_CID]: exactEntry }),
      getClaudePath: () => '/trusted/claude',
      getCodexPath: () => codexPath,
      createCodexRunner,
    });

    expect(resolver.resolve({ manifestCid: CANONICAL_CID })).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
      runner: codexRunner,
    });
    expect(createCodexRunner).toHaveBeenCalledOnce();
    expect(createCodexRunner).toHaveBeenCalledWith({
      codexPath: '/trusted/codex',
    });
    expect(resolver.resolve({ manifestCid: CANONICAL_CID })?.runner)
      .toBe(codexRunner);
    expect(createCodexRunner).toHaveBeenCalledOnce();

    codexPath = '/updated/codex';
    expect(resolver.resolve({ manifestCid: CANONICAL_CID })?.runner)
      .toBe(codexRunner);
    expect(createCodexRunner).toHaveBeenCalledTimes(2);
    expect(createCodexRunner).toHaveBeenLastCalledWith({
      codexPath: '/updated/codex',
    });

    const mismatchCases: Array<{
      name: string;
      mapKey?: string;
      queryCid?: string;
      entry: JoinedSolverNetConfig;
    }> = [
      {
        name: 'non-canonical but internally matching manifest',
        mapKey: 'bafy-non-canonical',
        queryCid: 'bafy-non-canonical',
        entry: {
          ...exactCodexEntry(),
          manifestCid: 'bafy-non-canonical',
        },
      },
      {
        name: 'wrong map key',
        mapKey: 'bafy-wrong-map-key',
        entry: exactCodexEntry(),
      },
      {
        name: 'wrong persisted manifest CID',
        entry: { ...exactCodexEntry(), manifestCid: 'bafy-wrong-persisted-cid' },
      },
      {
        name: 'wrong contract id',
        entry: {
          ...exactCodexEntry(),
          contract: { id: 'other', version: 'v1' },
        },
      },
      {
        name: 'wrong contract version',
        entry: {
          ...exactCodexEntry(),
          contract: { id: 'jinn-repo', version: 'v2' },
        },
      },
      {
        name: 'missing contract',
        entry: { ...exactCodexEntry(), contract: undefined },
      },
      {
        name: 'missing solver role',
        entry: { ...exactCodexEntry(), roles: ['evaluator'] },
      },
      {
        name: 'missing evaluator role',
        entry: { ...exactCodexEntry(), roles: ['solver'] },
      },
      {
        name: 'wrong root harness',
        entry: { ...exactCodexEntry(), harness: 'jinn-repo-evaluator' },
      },
      {
        name: 'wrong root model',
        entry: { ...exactCodexEntry(), model: 'gpt-5.4' },
      },
      {
        name: 'root provider route present',
        entry: {
          ...exactCodexEntry(),
          provider: { name: 'custom', baseUrl: 'https://example.test' },
        },
      },
      {
        name: 'wrong semantic model',
        entry: {
          ...exactCodexEntry(),
          semanticEvaluator: {
            ...exactCodexEntry().semanticEvaluator!,
            model: 'gpt-5.4' as 'gpt-5.4-mini',
          },
        },
      },
      {
        name: 'wrong semantic runtime',
        entry: {
          ...exactCodexEntry(),
          semanticEvaluator: {
            ...exactCodexEntry().semanticEvaluator!,
            runtime: 'claude' as 'codex',
          },
        },
      },
      {
        name: 'wrong semantic auth',
        entry: {
          ...exactCodexEntry(),
          semanticEvaluator: {
            ...exactCodexEntry().semanticEvaluator!,
            auth: 'api-key' as 'chatgpt-oauth-only',
          },
        },
      },
      {
        name: 'missing semantic profile',
        entry: { ...exactCodexEntry(), semanticEvaluator: undefined },
      },
    ];

    for (const testCase of mismatchCases) {
      const mismatchResolver = makeConfiguredSemanticEvaluatorRunnerResolver({
        getJoinedSolverNets: () => ({
          [testCase.mapKey ?? CANONICAL_CID]: testCase.entry,
        }),
        getClaudePath: () => '/trusted/claude',
        getCodexPath: () => '/trusted/codex',
        createCodexRunner,
      });
      expect(
        mismatchResolver.resolve({
          manifestCid: testCase.queryCid ?? CANONICAL_CID,
        }),
        testCase.name,
      ).toBeUndefined();
    }

    expect(createCodexRunner).toHaveBeenCalledTimes(2);
  });

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
      getCodexPath: () => '/trusted/codex',
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

  it('keeps Claude and Codex caches distinct when executable paths match', () => {
    const codexRunner = { run: vi.fn() };
    const claudeRunner = { run: vi.fn() };
    const createCodexRunner = vi.fn(() => codexRunner);
    const createClaudeRunner = vi.fn(() => claudeRunner);
    const resolver = makeConfiguredSemanticEvaluatorRunnerResolver({
      getJoinedSolverNets: () => ({
        [CANONICAL_CID]: exactCodexEntry(),
        'bafy-legacy-reviewer': {
          manifestCid: 'bafy-legacy-reviewer',
          roles: ['evaluator'],
          harness: 'jinn-repo-evaluator',
          model: 'claude-sonnet-4-5',
        },
      }),
      getClaudePath: () => '/shared/agent',
      getCodexPath: () => '/shared/agent',
      createCodexRunner,
      createClaudeRunner,
    });

    expect(resolver.resolve({ manifestCid: CANONICAL_CID })).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
      runner: codexRunner,
    });
    expect(
      resolver.resolve({ manifestCid: 'bafy-legacy-reviewer' }),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      runner: claudeRunner,
    });
    expect(resolver.resolve({ manifestCid: CANONICAL_CID })?.runner)
      .toBe(codexRunner);
    expect(
      resolver.resolve({ manifestCid: 'bafy-legacy-reviewer' })?.runner,
    ).toBe(claudeRunner);
    expect(createCodexRunner).toHaveBeenCalledOnce();
    expect(createClaudeRunner).toHaveBeenCalledOnce();
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
      getCodexPath: () => 'codex',
    });

    expect(resolver.resolve({ manifestCid: 'bafy-key' }))
      .toBeUndefined();
    expect(resolver.resolve({ manifestCid: 'bafy-other' }))
      .toBeUndefined();
  });
});
