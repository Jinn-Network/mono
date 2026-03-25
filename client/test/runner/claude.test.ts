import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/runner/claude.js';

describe('Claude runner', () => {
  it('builds a prompt from a desired state', () => {
    const prompt = buildPrompt({
      id: 'ds-1',
      description: 'The API should return 200 on /health',
      context: { endpoint: 'https://api.example.com/health' },
    });

    expect(prompt).toContain('The API should return 200 on /health');
    expect(prompt).toContain('desired state');
  });
});
