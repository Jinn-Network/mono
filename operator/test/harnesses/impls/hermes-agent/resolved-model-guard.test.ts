import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify as yamlStringify } from 'yaml';
import {
  ResolvedHermesModelMismatchError,
  assertResolvedHermesModel,
  assertResolvedHermesModelFromConfig,
  formatResolvedHermesModelGuardEvidence,
  parseT31ResolvedModelGuardPolicy,
  readResolvedHermesModelFromConfig,
} from '../../../../src/harnesses/impls/hermes-agent/resolved-model-guard.js';

function writeTaskConfig(
  dir: string,
  model: { default?: string; provider?: string; extra?: Record<string, unknown> },
): string {
  const configPath = join(dir, 'config.yaml');
  writeFileSync(
    configPath,
    yamlStringify({
      model: {
        ...(model.default ? { default: model.default } : {}),
        ...(model.provider ? { provider: model.provider } : {}),
        ...model.extra,
      },
    }),
    'utf8',
  );
  return configPath;
}

describe('assertResolvedHermesModel', () => {
  it('succeeds when resolved model and provider match the requested pair', () => {
    const evidence = assertResolvedHermesModel({
      configPath: '/tmp/hermes-home/config.yaml',
      requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
      resolved: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
    });

    expect(evidence).toEqual({
      requestedModel: 'deepseek/deepseek-v4-flash',
      requestedProvider: 'openrouter',
      resolvedModel: 'deepseek/deepseek-v4-flash',
      resolvedProvider: 'openrouter',
      configPath: '/tmp/hermes-home/config.yaml',
      overrideApproved: false,
    });
  });

  it('fails an unapproved environment override before spend, naming requested vs resolved and the config location', () => {
    expect(() =>
      assertResolvedHermesModel({
        configPath: '/tmp/op-b/.jinn-client/engine/impl-state/hermes-agent/config.yaml',
        requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
        resolved: { model: 'anthropic/claude-opus-4.6', provider: 'anthropic' },
      }),
    ).toThrow(ResolvedHermesModelMismatchError);

    try {
      assertResolvedHermesModel({
        configPath: '/tmp/op-b/.jinn-client/engine/impl-state/hermes-agent/config.yaml',
        requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
        resolved: { model: 'anthropic/claude-opus-4.6', provider: 'anthropic' },
      });
      throw new Error('expected mismatch to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolvedHermesModelMismatchError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('requested model=deepseek/deepseek-v4-flash provider=openrouter');
      expect(message).toContain('resolved model=anthropic/claude-opus-4.6 provider=anthropic');
      expect(message).toContain(
        'config=/tmp/op-b/.jinn-client/engine/impl-state/hermes-agent/config.yaml',
      );
      expect(message).not.toMatch(/api[_-]?key|sk-|token|password|secret/i);
    }
  });

  it('succeeds for an approved explicit override and records that the override was used', () => {
    const evidence = assertResolvedHermesModel({
      configPath: '/tmp/hermes-home/config.yaml',
      requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
      resolved: { model: 'google/gemini-2.5-flash', provider: 'openrouter' },
      approvedOverride: { model: 'google/gemini-2.5-flash', provider: 'openrouter' },
    });

    expect(evidence.overrideApproved).toBe(true);
    expect(evidence.resolvedModel).toBe('google/gemini-2.5-flash');
    expect(evidence.requestedModel).toBe('deepseek/deepseek-v4-flash');
  });

  it('treats an approved-override model with omitted provider as using the requested provider', () => {
    const evidence = assertResolvedHermesModel({
      configPath: '/tmp/hermes-home/config.yaml',
      requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
      resolved: { model: 'google/gemini-2.5-flash', provider: 'openrouter' },
      approvedOverride: { model: 'google/gemini-2.5-flash' },
    });

    expect(evidence.overrideApproved).toBe(true);
  });

  it('still fails when an approved override is present but the resolved pair matches neither allowed set', () => {
    expect(() =>
      assertResolvedHermesModel({
        configPath: '/tmp/hermes-home/config.yaml',
        requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
        resolved: { model: 'anthropic/claude-opus-4.6', provider: 'anthropic' },
        approvedOverride: { model: 'google/gemini-2.5-flash', provider: 'openrouter' },
      }),
    ).toThrow(/requested model=deepseek\/deepseek-v4-flash[\s\S]*resolved model=anthropic\/claude-opus-4.6/);
  });

  it('fails when the resolved model is missing so spend cannot be verified', () => {
    expect(() =>
      assertResolvedHermesModel({
        configPath: '/tmp/hermes-home/config.yaml',
        requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
        resolved: { provider: 'openrouter' },
      }),
    ).toThrow(/resolved model=\(unset\)/);
  });
});

describe('readResolvedHermesModelFromConfig / assertResolvedHermesModelFromConfig', () => {
  it('reads only model.default and model.provider from the written task-local config', () => {
    const dir = mkdtempSync(join(tmpdir(), 't31-guard-'));
    try {
      const configPath = writeTaskConfig(dir, {
        default: 'deepseek/deepseek-v4-flash',
        provider: 'openrouter',
        extra: { api_key: 'sk-never-record-me', max_tokens: 32000 },
      });

      expect(readResolvedHermesModelFromConfig(configPath)).toEqual({
        model: 'deepseek/deepseek-v4-flash',
        provider: 'openrouter',
      });

      const evidence = assertResolvedHermesModelFromConfig({
        configPath,
        requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
      });
      const rendered = formatResolvedHermesModelGuardEvidence(evidence);
      expect(rendered).toContain('resolved model=deepseek/deepseek-v4-flash');
      expect(rendered).toContain(`config=${configPath}`);
      expect(rendered).not.toContain('sk-never-record-me');
      expect(JSON.stringify(evidence)).not.toContain('sk-never-record-me');
      expect(Object.keys(evidence).sort()).toEqual([
        'configPath',
        'overrideApproved',
        'requestedModel',
        'requestedProvider',
        'resolvedModel',
        'resolvedProvider',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails an unapproved written config without reading sibling .env secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 't31-guard-'));
    try {
      writeFileSync(join(dir, '.env'), 'OPENROUTER_API_KEY=sk-live-secret\n', 'utf8');
      const configPath = writeTaskConfig(dir, {
        default: 'anthropic/claude-opus-4.6',
        provider: 'anthropic',
      });

      expect(() =>
        assertResolvedHermesModelFromConfig({
          configPath,
          requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
        }),
      ).toThrow(ResolvedHermesModelMismatchError);

      expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('sk-live-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseT31ResolvedModelGuardPolicy', () => {
  it('is inactive when T3.1 expected-model env is unset so normal operator selection is unchanged', () => {
    expect(parseT31ResolvedModelGuardPolicy({
      JINN_HERMES_MODEL: 'anthropic/claude-opus-4.6',
    })).toBeUndefined();
  });

  it('reads the requested pair and an optional approved override from T3.1 env', () => {
    expect(parseT31ResolvedModelGuardPolicy({
      JINN_T31_EXPECTED_HERMES_MODEL: 'deepseek/deepseek-v4-flash',
      JINN_T31_EXPECTED_HERMES_PROVIDER: 'openrouter',
      JINN_T31_APPROVED_HERMES_MODEL: 'google/gemini-2.5-flash',
      JINN_T31_APPROVED_HERMES_PROVIDER: 'openrouter',
    })).toEqual({
      requested: { model: 'deepseek/deepseek-v4-flash', provider: 'openrouter' },
      approvedOverride: { model: 'google/gemini-2.5-flash', provider: 'openrouter' },
    });
  });
});
