import { describe, it, expect } from 'vitest';
import { SimpleRunner } from '../../src/runner/simple.js';
import type { DesiredState } from '../../src/types/index.js';

describe('SimpleRunner', () => {
  it('produces a result from a desired state', async () => {
    const runner = new SimpleRunner(async (description) => {
      return `Restored: ${description}`;
    });

    const desiredState: DesiredState = {
      id: 'ds-1',
      description: 'The API should return 200 on /health',
    };

    const result = await runner.run(desiredState, {
      requestId: 'req-1',
      workingDirectory: '/tmp',
      timeoutMs: 30000,
    });

    expect(result.data).toBe('Restored: The API should return 200 on /health');
  });
});
