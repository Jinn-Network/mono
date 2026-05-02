import { describe, it, expect } from 'vitest';
import { createFakeClaudeRunner } from '@test/claude.js';
import type { Task } from '@/types/task.js';

describe('FakeClaudeRunner', () => {
  it('returns the scripted result for a Task', async () => {
    const runner = createFakeClaudeRunner({
      script: (_ds) => ({
        data: 'scripted-data',
        artifacts: ['artifact-1'],
      }),
    });
    const task: Task = { id: 'req-1', description: 'x' };
    const result = await runner.run(task, {
      requestId: 'req-1',
      workingDirectory: '/tmp/x',
      timeoutMs: 1000,
    });
    expect(result.data).toBe('scripted-data');
    expect(result.artifacts).toEqual(['artifact-1']);
  });

  it('defaults to a trivial success data payload', async () => {
    const runner = createFakeClaudeRunner();
    const result = await runner.run(
      { id: 'req-2', description: 'default' },
      { requestId: 'req-2', workingDirectory: '/tmp/x', timeoutMs: 1000 },
    );
    expect(result.data).toBeTruthy();
  });
});
