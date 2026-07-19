import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_RUNTIME_ENV,
  parseAutopilotRuntime,
} from '../src/autopilot-runtime.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';

describe('global Autopilot runtime', () => {
  it('defaults the whole process to Claude when the env is unset', () => {
    expect(parseAutopilotRuntime(undefined)).toBe('claude');
    expect(DEFAULT_CONFIG.runtime).toBe('claude');
  });

  it.each(['claude', 'hermes'] as const)('accepts %s', (runtime) => {
    expect(parseAutopilotRuntime(runtime)).toBe(runtime);
  });

  it.each(['', 'codex', 'cursor', 'Hermes', ' claude '])(
    'fails loudly for unsupported value %j',
    (runtime) => {
      expect(() => parseAutopilotRuntime(runtime))
        .toThrow(new RegExp(`${AUTOPILOT_RUNTIME_ENV}.*claude.*hermes`, 'i'));
    },
  );
});
