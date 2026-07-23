import { describe, expect, it } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import { makeCommandCtx } from '@test/cli.js';

describe('tasks observe-autopilot-delivery machine command', () => {
  it('is routed as a stable tasks subcommand and requires an expectation file', async () => {
    const made = makeCommandCtx({
      argv: ['observe-autopilot-delivery', '--json'],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: '--expectation-file is required',
    });
    expect(made.exits).toEqual([11]);
  });
});
