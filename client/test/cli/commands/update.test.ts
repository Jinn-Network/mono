import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../../src/cli/command.js';

const execSyncMock = vi.fn();
const pluginRunMock = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

vi.mock('../../../src/cli/commands/plugin-install.js', () => ({
  default: {
    name: 'plugin',
    summary: '',
    helpText: '',
    run: pluginRunMock,
  },
}));

function makeCtx(argv: string[] = ['--json'], env: Record<string, string> = {}): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (code: number) => { exits.push(code); },
      env,
    },
    writes,
    exits,
  };
}

describe('update command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports plugin refresh errors even when plugin install does not set an exit code', async () => {
    pluginRunMock.mockImplementation(async (ctx: CommandContext) => {
      ctx.writer.write(JSON.stringify({
        results: [
          {
            target: 'claude-code',
            mcp: { status: 'error', detail: 'failed to add MCP' },
            skill: { status: 'configured', detail: 'skill installed' },
          },
        ],
      }));
    });

    const { default: updateCommand } = await import('../../../src/cli/commands/update.js');
    const { ctx, writes, exits } = makeCtx(['--json', '--skip-npm']);

    await updateCommand.run(ctx);

    const payload = JSON.parse(writes[writes.length - 1] ?? '{}');
    expect(payload.ok).toBe(false);
    expect(payload.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'plugin-install',
        status: 'error',
      }),
    ]));
    expect(payload.steps.find((step: { step: string }) => step.step === 'plugin-install')?.detail)
      .toContain('claude-code');
    expect(exits).toEqual([]);
  });
});
