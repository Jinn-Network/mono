import { describe, expect, it, vi } from 'vitest';
import {
  buildHarnessReadinessRegistry,
  makeProductionSemanticEvaluatorRunnerResolver,
  normalizeConfiguredCodexPath,
} from '../../src/main.js';
import type { Harness } from '../../src/harnesses/types.js';

const CANONICAL_CID =
  'bafkreihvpooczub6s7c3yuraotwe43xbu4dliowmnkymegct66ddgrlaoa';

describe('buildHarnessReadinessRegistry', () => {
  it('composes the registry from buildHarnesses() output + config.joinedSolverNets', async () => {
    const harnesses: Harness[] = [
      {
        name: 'claude-code-learner',
        version: '0.0.0',
        supports: () => true,
        run: async () => { throw new Error('not used'); },
        isReady: async () => ({ ready: true }),
      },
    ];
    const config = {
      joinedSolverNets: {
        'bafkrei.x': {
          manifestCid: 'bafkrei.x',
          roles: ['solver' as const],
          harness: 'claude-code-learner',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    };
    const registry = buildHarnessReadinessRegistry({ harnesses, config });
    await registry.refreshNow();
    expect(registry.isReadyForClaim('bafkrei.x').ready).toBe(true);
  });

  it('normalizes the configured Codex executable before production composition', () => {
    expect(normalizeConfiguredCodexPath(undefined)).toBe('codex');
    expect(normalizeConfiguredCodexPath('')).toBe('codex');
    expect(normalizeConfiguredCodexPath('   ')).toBe('codex');
    expect(normalizeConfiguredCodexPath('  /trusted/codex  '))
      .toBe('/trusted/codex');
    expect(normalizeConfiguredCodexPath(' codex-nightly '))
      .toBe('codex-nightly');
  });

  it('passes the normalized Codex executable through production composition', () => {
    for (const [configuredCodexPath, expectedCodexPath] of [
      ['  /trusted/codex  ', '/trusted/codex'],
      ['   ', 'codex'],
    ] as const) {
      const codexRunner = { run: async () => '{}' };
      const createCodexRunner = vi.fn(() => codexRunner);
      const resolver = makeProductionSemanticEvaluatorRunnerResolver({
        getJoinedSolverNets: () => ({
          [CANONICAL_CID]: {
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
          },
        }),
        getClaudePath: () => '/trusted/claude',
        configuredCodexPath,
        createCodexRunner,
      });

      expect(resolver.resolve({ manifestCid: CANONICAL_CID })).toMatchObject({
        provider: 'openai-codex',
        model: 'gpt-5.4-mini',
        runner: codexRunner,
      });
      expect(createCodexRunner).toHaveBeenCalledOnce();
      expect(createCodexRunner).toHaveBeenCalledWith({
        codexPath: expectedCodexPath,
      });
    }
  });
});
