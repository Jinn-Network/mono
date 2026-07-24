import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import { parseAutopilotDeliveryCommandResult } from '@/cli/commands/tasks-observe-autopilot.js';
import { makeCommandCtx } from '@test/cli.js';
import {
  AutopilotDeliveryCommandResultV1Schema,
} from '@jinn-network/sdk/autopilot';

describe('tasks observe-autopilot-delivery machine command', () => {
  it('parses the complete emitted wrapper with the SDK result schema', () => {
    const parse = vi.spyOn(AutopilotDeliveryCommandResultV1Schema, 'parse');
    const value = {
      schemaVersion: 1,
      generatedAt: '2026-07-24T12:00:00.000Z',
      verb: 'tasks observe-autopilot-delivery',
      observation: {
        status: 'pending',
        reason: 'attempt-not-indexed',
      },
    };

    expect(parseAutopilotDeliveryCommandResult(value)).toEqual(value);
    expect(parse).toHaveBeenCalledWith(value);
    expect(() => parseAutopilotDeliveryCommandResult({
      ...value,
      unexpected: true,
    })).toThrow();
    parse.mockRestore();
  });

  it('is routed as a stable tasks subcommand and requires an expectation file', async () => {
    const made = makeCommandCtx({
      argv: ['observe-autopilot-delivery', '--json'],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: '--expectation-file is required',
    });
    expect(made.exits).toEqual([11]);
  });

  it.each([
    {
      name: 'requires --json',
      argv: ['observe-autopilot-delivery'],
      message: '--json is required',
    },
    {
      name: 'rejects --human',
      argv: ['observe-autopilot-delivery', '--json', '--human'],
      message: '--human is not supported',
    },
  ])('$name', async ({ argv, message }) => {
    const made = makeCommandCtx({ argv });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringContaining(message),
    });
    expect(made.exits).toEqual([11]);
  });

  it('rejects a malformed expectation before loading a deliberately malformed config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-observe-autopilot-'));
    const expectationFile = join(dir, 'expectation.json');
    const configFile = join(dir, 'config.json');
    writeFileSync(expectationFile, JSON.stringify({ malformed: true }));
    writeFileSync(configFile, '{ deliberately malformed config');
    const made = makeCommandCtx({
      argv: [
        'observe-autopilot-delivery',
        '--expectation-file',
        expectationFile,
        '--config',
        configFile,
        '--json',
      ],
    });

    await tasksCommand.run(made.ctx);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: expect.stringMatching(/expectation/i),
    });
    expect(made.exits).toEqual([11]);
  });
});
