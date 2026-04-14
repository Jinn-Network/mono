import { describe, expect, it } from 'vitest';
import doctor from '../../../src/cli/commands/doctor.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(env: Record<string, string> = {}): {
  ctx: CommandContext; writes: string[]; exits: number[];
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

describe('doctor command', () => {
  it('emits a checks array and an ok/blockingCount roll-up', async () => {
    const { ctx, writes } = makeCtx();
    await doctor.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.schemaVersion).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(typeof parsed.ok).toBe('boolean');
    expect(typeof parsed.blockingCount).toBe('number');
    // Every check has the required shape
    for (const check of parsed.checks) {
      expect(typeof check.name).toBe('string');
      expect(typeof check.ok).toBe('boolean');
      expect(typeof check.detail).toBe('string');
    }
  });

  it('includes the claude_binary check', async () => {
    const { ctx, writes } = makeCtx();
    await doctor.run(ctx);
    const parsed = JSON.parse(writes[0]);
    const names = parsed.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('claude_binary');
    expect(names).toContain('node_version');
    expect(names).toContain('keystore_readable');
  });
});
