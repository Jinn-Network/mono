import { describe, expect, it } from 'vitest';
import {
  HERMES_STATELESS_LAUNCHER,
  assertHermesRuntimeFiles,
  hermesChatArgs,
} from '../../src/dispatcher/hermes-runtime.js';

describe('hermesChatArgs', () => {
  it('builds a stateless non-interactive chat invocation with an explicit provider', () => {
    expect(hermesChatArgs('PROMPT', {
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
    })).toEqual([
      HERMES_STATELESS_LAUNCHER,
      'chat', '-q', 'PROMPT', '-Q', '--yolo', '--accept-hooks',
      '--model', 'gpt-5.6-sol',
      '--provider', 'openai-codex',
    ]);
  });
});

describe('assertHermesRuntimeFiles', () => {
  it('fails loudly when the Hermes Python interpreter is missing', () => {
    expect(() => assertHermesRuntimeFiles('/missing/python', () => false))
      .toThrow(/Hermes Python interpreter.*missing/);
  });

  it('fails loudly when the Jinn stateless launcher is missing', () => {
    expect(() => assertHermesRuntimeFiles('/present/python', (path) => (
      path === '/present/python'
    ))).toThrow(/Hermes stateless launcher.*missing/);
  });
});
