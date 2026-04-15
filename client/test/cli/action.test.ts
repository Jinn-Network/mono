import { describe, expect, it } from 'vitest';
import { ensureConfirmed, emitDryRun } from '../../src/cli/action.js';
import type { CommandContext } from '../../src/cli/command.js';

function makeCtx(stdoutIsTty = false): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (c: number) => { exits.push(c); },
    env: {},
  };
  return { ctx, writes, exits };
}

describe('ensureConfirmed', () => {
  it('returns true when --yes is passed', () => {
    const { ctx } = makeCtx(true);
    expect(ensureConfirmed(ctx, { yes: true, dryRun: false })).toBe(true);
  });

  it('returns false and emits invalid_invocation on non-TTY without --yes', () => {
    const { ctx, writes, exits } = makeCtx(false);
    const ok = ensureConfirmed(ctx, { yes: false, dryRun: false });
    expect(ok).toBe(false);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('confirmation');
    expect(exits).toEqual([11]);
  });

  it('returns true when --dry-run is passed (no confirmation needed)', () => {
    const { ctx } = makeCtx(false);
    expect(ensureConfirmed(ctx, { yes: false, dryRun: true })).toBe(true);
  });
});

describe('emitDryRun', () => {
  it('emits a dry-run envelope with plan and exits 0', () => {
    const { ctx, writes, exits } = makeCtx();
    emitDryRun(ctx, {
      verb: 'submit-intent',
      description: 'Would post one intent',
      plan: [{ step: 1, tx: 'JinnRouter.createRestorationJob(...)' }],
    });
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('submit-intent');
    expect(parsed.plan).toEqual([{ step: 1, tx: 'JinnRouter.createRestorationJob(...)' }]);
    expect(exits).toEqual([]);
  });

  it('emits human-readable dry-run output when --human is set', () => {
    const { ctx, writes, exits } = makeCtx(true);
    ctx.argv = ['--human'];
    emitDryRun(ctx, {
      verb: 'submit-intent',
      description: 'Would post one intent',
      plan: [{ step: 1 }],
    });
    const out = writes[writes.length - 1]!;
    expect(out).toContain('Dry run: submit-intent');
    expect(out).toContain('Would post one intent');
    expect(exits).toEqual([]);
  });
});
