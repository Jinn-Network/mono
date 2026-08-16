import { describe, expect, it, vi } from 'vitest';
import type { JinnConfig } from '../../../src/config.js';
import { makeCommandCtx } from '../../_support/cli.js';
import { createRestartCommand } from '../../../src/cli/commands/restart.js';

describe('jinn restart', () => {
  it('errors when the daemon is not reachable', async () => {
    const cmd = createRestartCommand({
      loadConfig: () => ({ apiPort: 7331 }) as JinnConfig,
      requestDaemon: vi.fn(async () => ({ reachable: false, error: 'fetch failed' })),
    });
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--json'], tty: false });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.details.reason).toBe('daemon_not_running');
    expect(exits[0]).toBe(50);
  });

  it('reports scheduled when the daemon answers 200', async () => {
    const cmd = createRestartCommand({
      loadConfig: () => ({ apiPort: 7331 }) as JinnConfig,
      requestDaemon: vi.fn(async () => ({
        reachable: true,
        status: 200,
        body: { ok: true, scheduled: true },
      })),
    });
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--json'], tty: false });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.verb).toBe('restart');
    expect(parsed.scheduled).toBe(true);
    expect(exits).toEqual([0]);
  });
});
