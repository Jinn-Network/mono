import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stop from '../../../src/cli/commands/stop.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(env: Record<string, string> = {}): {
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
    env,
  };
  return { ctx, writes, exits };
}

describe('stop command', () => {
  it('emits invalid_invocation when no pidfile exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const { ctx, writes, exits } = makeCtx({ JINN_EARNING_DIR: dir });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('daemon_pidfile');
    expect(exits).toEqual([11]);
  });

  it('reads the pidfile and reports the pid on success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '99999\n');
    const { ctx, writes } = makeCtx({ JINN_EARNING_DIR: dir });
    // PID 99999 almost certainly doesn't exist — stop should still emit a
    // success-shaped response with killed=false rather than an envelope.
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.pid).toBe(99999);
    expect(typeof parsed.killed).toBe('boolean');
  });
});
