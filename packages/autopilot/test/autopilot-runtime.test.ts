import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_RUNTIME_ENV,
  AUTOPILOT_RUNTIMES,
  AUTOPILOT_RUNTIME_SET,
  parseAutopilotRuntime,
} from '../src/autopilot-runtime.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';

describe('global Autopilot runtime', () => {
  it('derives runtime validation from the canonical runtime array', () => {
    expect([...AUTOPILOT_RUNTIME_SET]).toEqual([...AUTOPILOT_RUNTIMES]);
  });

  it('defaults the whole process to Claude when the env is unset', () => {
    expect(parseAutopilotRuntime(undefined)).toBe('claude');
    expect(DEFAULT_CONFIG.runtime).toBe('claude');
  });

  it.each(AUTOPILOT_RUNTIMES)('accepts %s', (runtime) => {
    expect(parseAutopilotRuntime(runtime)).toBe(runtime);
  });

  it.each(['', 'codex', 'Hermes', ' claude '])(
    'fails loudly for unsupported value %j',
    (runtime) => {
      expect(() => parseAutopilotRuntime(runtime))
        .toThrow(new RegExp(`${AUTOPILOT_RUNTIME_ENV}.*claude.*hermes.*cursor`, 'i'));
    },
  );
});
