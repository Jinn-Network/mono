import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

vi.mock('../../../src/main.js', () => ({
  main: vi.fn(async () => {
    /* successful daemon start */
  }),
}));

function makeCtx(env: Record<string, string> = { JINN_PASSWORD: 'test' }): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env,
  };
  return { ctx, writes, exits };
}

describe('run command', () => {
  it('requires JINN_PASSWORD', async () => {
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { ctx, writes, exits } = makeCtx({});
    await run.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('delegates to main() when JINN_PASSWORD is set', async () => {
    const { default: run } = await import('../../../src/cli/commands/run.js');
    const { main } = await import('../../../src/main.js');
    const { ctx } = makeCtx();
    await run.run(ctx);
    expect(main).toHaveBeenCalled();
  });
});
