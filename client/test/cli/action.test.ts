import { describe, expect, it } from 'vitest';
import { ensureConfirmed, emitDryRun } from '../../src/cli/action.js';
import { makeCommandCtx } from '@test/cli.js';

describe('ensureConfirmed', () => {
  it('returns true when --yes is passed', () => {
    const { ctx } = makeCommandCtx({ tty: true });
    expect(ensureConfirmed(ctx, { yes: true, dryRun: false })).toBe(true);
  });

  it('returns false and emits invalid_invocation on non-TTY without --yes', () => {
    const { ctx, writes, exits } = makeCommandCtx({ tty: false });
    const ok = ensureConfirmed(ctx, { yes: false, dryRun: false });
    expect(ok).toBe(false);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('confirmation');
    expect(exits).toEqual([11]);
  });

  it('returns true when --dry-run is passed (no confirmation needed)', () => {
    const { ctx } = makeCommandCtx({ tty: false });
    expect(ensureConfirmed(ctx, { yes: false, dryRun: true })).toBe(true);
  });
});

describe('emitDryRun', () => {
  it('emits a dry-run envelope with plan and exits 0', () => {
    const { ctx, writes, exits } = makeCommandCtx();
    emitDryRun(ctx, {
      verb: 'tasks submit',
      description: 'Would post one task',
      plan: [{ step: 1, tx: 'JinnRouterV3.createTask(...)' }],
    });
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('tasks submit');
    expect(parsed.plan).toEqual([{ step: 1, tx: 'JinnRouterV3.createTask(...)' }]);
    expect(exits).toEqual([]);
  });

  it('emits human-readable dry-run output when --human is set', () => {
    const { ctx, writes, exits } = makeCommandCtx({ tty: true, argv: ['--human'] });
    emitDryRun(ctx, {
      verb: 'tasks submit',
      description: 'Would post one task',
      plan: [{ step: 1 }],
    });
    const out = writes[writes.length - 1]!;
    expect(out).toContain('Dry run: tasks submit');
    expect(out).toContain('Would post one task');
    expect(exits).toEqual([]);
  });
});
