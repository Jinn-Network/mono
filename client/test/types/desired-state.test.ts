import { describe, it, expect } from 'vitest';
import { parseDesiredState } from '../../src/types/desired-state.js';

describe('DesiredState', () => {
  it('parses a valid desired state', () => {
    const input = {
      description: 'The API should return 200 on /health',
      context: { endpoint: 'https://api.example.com/health' },
    };
    const result = parseDesiredState(input);
    expect(result.description).toBe(input.description);
    expect(result.context).toEqual(input.context);
    expect(result.id).toBeDefined();
  });

  it('rejects a desired state without description', () => {
    expect(() => parseDesiredState({ context: {} })).toThrow();
  });
});
