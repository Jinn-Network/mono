import { describe, expect, it } from 'vitest';
import auth from '../../../src/cli/commands/auth.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    },
    exit: (code: number) => {
      exits.push(code);
    },
    env: {},
    ...overrides,
  };
  return { ctx, writes, exits };
}

describe('auth command', () => {
  it('has name "auth" and a summary', () => {
    expect(auth.name).toBe('auth');
    expect(typeof auth.summary).toBe('string');
    expect(auth.summary.length).toBeGreaterThan(0);
  });

  it('emits invalid_invocation with exit 11 for bad flags', async () => {
    const { ctx, writes, exits } = makeCtx({ argv: ['--bogus'] });
    await auth.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('emits either a success result or invalid_invocation on non-TTY (no flags)', async () => {
    const { ctx, writes, exits } = makeCtx({ stdoutIsTty: false });
    await auth.run(ctx);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    if (exits.length === 0) {
      // Authenticated: success result
      expect(parsed.schemaVersion).toBe(1);
      expect(typeof parsed.authenticated).toBe('boolean');
      expect(parsed.authenticated).toBe(true);
      expect(typeof parsed.context).toBe('string');
      expect(typeof parsed.detail).toBe('string');
    } else {
      // Not authenticated on non-TTY: invalid_invocation
      expect(parsed.code).toBe('invalid_invocation');
      expect(exits).toEqual([11]);
    }
  });
});
