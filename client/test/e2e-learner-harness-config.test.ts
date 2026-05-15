import { describe, expect, it } from 'vitest';
import { readLearnerHarnessE2EConfig } from './e2e/learner-harness-config.js';

describe('learner harness e2e config', () => {
  it('defaults to the Claude learner harness', () => {
    expect(readLearnerHarnessE2EConfig({})).toEqual({
      harnessName: 'claude-code',
      cliPath: 'claude',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('configures the Codex learner harness with the cheap default model', () => {
    expect(readLearnerHarnessE2EConfig({
      JINN_E2E_LEARNER_HARNESS: 'codex',
    })).toEqual({
      harnessName: 'codex',
      cliPath: 'codex',
      model: 'gpt-5.4-mini',
    });
  });

  it('accepts legacy learner harness aliases', () => {
    expect(readLearnerHarnessE2EConfig({
      JINN_E2E_LEARNER_HARNESS: 'codex-code-learner',
    }).harnessName).toBe('codex');
  });

  it('honors explicit CLI path and model overrides', () => {
    expect(readLearnerHarnessE2EConfig({
      JINN_E2E_LEARNER_HARNESS: 'codex',
      JINN_E2E_LEARNER_CLI_PATH: '/tmp/codex',
      JINN_E2E_LEARNER_MODEL: 'gpt-test',
    })).toEqual({
      harnessName: 'codex',
      cliPath: '/tmp/codex',
      model: 'gpt-test',
    });
  });

  it('rejects unsupported harness names', () => {
    expect(() => readLearnerHarnessE2EConfig({
      JINN_E2E_LEARNER_HARNESS: 'other',
    })).toThrow(/Unsupported JINN_E2E_LEARNER_HARNESS/);
  });
});
