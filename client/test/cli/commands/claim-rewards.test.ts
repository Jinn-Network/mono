import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(argv: string[], tty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: tty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

describe('claim-rewards command', () => {
  it('--dry-run emits a plan without executing', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes } = makeCtx(['--dry-run']);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('claim-rewards');
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes, exits } = makeCtx([]);
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
