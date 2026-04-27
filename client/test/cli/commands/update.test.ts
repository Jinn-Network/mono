import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateCommand } from '@/cli/commands/update.js';
import { runCommand } from '@test/cli.js';
import type { CommandContext } from '@/cli/command.js';

// MOCK_JUSTIFICATION: node:child_process is a leaf Node built-in; execSync is a syscall and cannot be DI'd without a shim module we don't own.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

describe('update command', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports plugin refresh errors even when plugin install does not set an exit code', async () => {
    const pluginRunMock = vi.fn(async (ctx: CommandContext) => {
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

    const cmd = createUpdateCommand({ pluginRun: pluginRunMock });
    const { envelopes, exits } = await runCommand(cmd, { argv: ['--json', '--skip-npm'] });

    const payload = envelopes[envelopes.length - 1] as {
      ok: boolean;
      steps: Array<{ step: string; status: string; detail: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: 'plugin-install',
        status: 'error',
      }),
    ]));
    expect(payload.steps.find((step) => step.step === 'plugin-install')?.detail)
      .toContain('claude-code');
    expect(exits).toEqual([]);
  });
});
