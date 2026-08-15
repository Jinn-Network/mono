/**
 * Tests for the `jinn tasks observe-autopilot-delivery` subverb.
 *
 * This verb is a PUBLISHED EXTERNAL BOUNDARY: `Jinn-Network/autopilot` shells
 * out to it (`src/lifecycle/marketplace-delivery.ts:309`), parses its stdout
 * with the SDK envelope (`:317`), and capability-probes `jinn tasks --help` for
 * it (`src/lifecycle/active-runtime-production.ts:399-402`). One-swap R3b
 * (issue #2494) RELOCATES its indexer read onto `discovery-client/` rather than
 * retiring the verb, so the D-wave can delete `operator/src/discovery/` without
 * breaking that consumer.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import {
  parseAutopilotDeliveryCommandResult,
  runObserveAutopilotDelivery,
} from '@/cli/commands/tasks-observe-autopilot.js';
import { makeCommandCtx } from '@test/cli.js';
import {
  AutopilotDeliveryCommandResultV1Schema,
} from '@jinn-network/sdk/autopilot';

const EXPECTATION = {
  schemaVersion: 'jinn-autopilot-delivery-observation-request.v1',
  role: 'solution',
  taskId: '501',
  taskCid: 'bafy-task',
  creationBlockNumber: 100,
  session: {
    schemaVersion: 'jinn-autopilot-session.v1',
    workflow: 'implement',
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 2001,
    prNumber: 2101,
    targetBase: 'next',
    branch: 'codex/issue-2001',
    claimOid: '1111111111111111111111111111111111111111',
    expectedHead: '2222222222222222222222222222222222222222',
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
    runnerId: 'runner-1',
    taskSnapshot: {
      title: 'Implement exact marketplace contracts',
      body: 'Add the approved contract surface.',
      prBody: 'Draft implementation PR.',
      baseSha: '3333333333333333333333333333333333333333',
      targetBaseOid: '3333333333333333333333333333333333333333',
    },
    workflowContract: {
      skill: 'implement-issue',
      version: 'v2',
      resultSchema: 'jinn-autopilot-mutation-result.v1',
    },
    deadline: '2026-07-23T23:00:00.000Z',
    receiptAuthors: ['jinn-autopilot'],
  },
  attemptIndex: 0,
  requestId: `0x${'11'.repeat(32)}`,
};

/** Config + expectation on disk, returned as the argv the verb parses. */
function withFiles(config: Record<string, unknown>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-observe-autopilot-'));
  const configPath = join(dir, 'config.json');
  const expectationPath = join(dir, 'expectation.json');
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  writeFileSync(expectationPath, JSON.stringify(EXPECTATION), 'utf-8');
  return [
    '--expectation-file', expectationPath,
    '--config', configPath,
    '--json',
  ];
}

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

  it('is advertised in tasks help so the external capability probe passes', async () => {
    // `Jinn-Network/autopilot` greps `jinn tasks --help` for this exact string
    // and throws when it is absent (active-runtime-production.ts:399-402).
    const made = makeCommandCtx({ argv: ['--help'] });

    await tasksCommand.run(made.ctx);

    expect(made.writes.join('')).toContain('observe-autopilot-delivery');
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

describe('tasks observe-autopilot-delivery reads through discovery-client', () => {
  it('drives the candidate fetch through the relocated client and emits its result', async () => {
    const getAutopilotDeliveryCandidates = vi.fn().mockResolvedValue({
      status: 'pending',
      reason: 'attempt-not-indexed',
      taskId: '501',
      role: 'solution',
    });
    const createDiscovery = vi.fn(() => ({ getAutopilotDeliveryCandidates }));
    const made = makeCommandCtx({
      argv: withFiles({
        network: 'testnet',
        discovery: { mode: 'http', url: 'https://indexer.example' },
      }),
    });

    await runObserveAutopilotDelivery(made.ctx, {
      createDiscovery,
      latestBlockNumber: async () => 200n,
    });

    // The verb resolved its indexer through the RELOCATED module: the URL it
    // passed is the configured one, and the fetch it made is the relocated
    // method with the expectation's join keys.
    expect(createDiscovery).toHaveBeenCalledWith('https://indexer.example');
    expect(getAutopilotDeliveryCandidates).toHaveBeenCalledWith({
      chainId: 84532,
      taskId: '501',
      role: 'solution',
    });
    // ...and the lookup it returned is what reached stdout, inside the exact
    // envelope the external consumer parses.
    const emitted = JSON.parse(made.writes.at(-1)!);
    expect(AutopilotDeliveryCommandResultV1Schema.parse(emitted)).toEqual(emitted);
    expect(emitted).toMatchObject({
      verb: 'tasks observe-autopilot-delivery',
      observation: { status: 'pending', reason: 'attempt-not-indexed' },
    });
    expect(made.exits).toEqual([]);
  });

  it('reports a discovery-client failure as a pending observation, not a crash', async () => {
    const getAutopilotDeliveryCandidates = vi.fn()
      .mockRejectedValue(new Error('indexer unreachable'));
    const made = makeCommandCtx({
      argv: withFiles({
        network: 'testnet',
        discovery: { mode: 'http', url: 'https://indexer.example' },
      }),
    });

    await runObserveAutopilotDelivery(made.ctx, {
      createDiscovery: () => ({ getAutopilotDeliveryCandidates }),
      latestBlockNumber: async () => 200n,
    });

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      observation: { status: 'pending', reason: 'discovery-unavailable' },
    });
  });

  it('refuses without an exact HTTP indexer rather than reading the legacy tree', async () => {
    const made = makeCommandCtx({
      argv: withFiles({ network: 'testnet', discovery: { mode: 'onchain' } }),
    });

    await runObserveAutopilotDelivery(made.ctx, {
      createDiscovery: () => {
        throw new Error('discovery must not be constructed without an http indexer');
      },
      latestBlockNumber: async () => 200n,
    });

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      message: expect.stringMatching(/HTTP discovery indexer is required/i),
    });
  });
});
