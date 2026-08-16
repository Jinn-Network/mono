import { describe, it, expect } from 'vitest';
import { makeCommandCtx, runCommand } from '@test/cli.js';
import type { CommandModule } from '@/cli/command.js';

describe('makeCommandCtx', () => {
  it('defaults to empty argv, empty env, tty=false', () => {
    const { ctx } = makeCommandCtx();
    expect(ctx.argv).toEqual([]);
    expect(ctx.env).toEqual({});
    expect(ctx.stdoutIsTty).toBe(false);
  });

  it('captures writes and exits', () => {
    const { ctx, writes, exits } = makeCommandCtx();
    ctx.writer.write('hello\n');
    ctx.writer.write('world\n');
    ctx.exit(7);
    expect(writes).toEqual(['hello\n', 'world\n']);
    expect(exits).toEqual([7]);
  });

  it('applies overrides', () => {
    const { ctx } = makeCommandCtx({
      argv: ['--json'],
      env: { JINN_PASSWORD: 'secret' },
      tty: true,
    });
    expect(ctx.argv).toEqual(['--json']);
    expect(ctx.env).toEqual({ JINN_PASSWORD: 'secret' });
    expect(ctx.stdoutIsTty).toBe(true);
  });
});

describe('runCommand', () => {
  it('returns JSON envelopes parsed from writes', async () => {
    const fakeCommand: CommandModule = {
      name: 'fake',
      summary: 'fake',
      helpText: 'fake',
      async run(ctx) {
        ctx.writer.write(JSON.stringify({ schemaVersion: 1, kind: 'ok' }) + '\n');
      },
    };
    const { envelopes, exits } = await runCommand(fakeCommand);
    expect(envelopes).toEqual([{ schemaVersion: 1, kind: 'ok' }]);
    expect(exits).toEqual([]);
  });
});
