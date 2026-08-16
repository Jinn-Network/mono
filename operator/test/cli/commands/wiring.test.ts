import { describe, expect, it } from 'vitest';
import type { JinnConfig } from '../../../src/config.js';
import { makeCommandCtx } from '../../_support/cli.js';
import { createWiringCommand } from '../../../src/cli/commands/wiring.js';

const config: Partial<JinnConfig> = {
  executionWiring: [
    {
      workKind: 'repository-work',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: [],
      credentialRef: 'default',
      isolationPolicy: 'worktree',
      legacyManifestDigest: '0xaa',
    },
  ],
  posting: [
    {
      workKind: 'repository-work',
      launchedRecordPath: '/records/net-a.json',
      generatorEnabled: true,
      legacyManifestDigest: '0xaa',
    },
  ],
};

function wiring() {
  return createWiringCommand({
    loadConfig: () => config as JinnConfig,
    getConfigPathFromArgs: () => undefined,
  });
}

describe('jinn wiring', () => {
  it('lists execution wiring entries with their bridge annotation', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['list', '--json'], tty: false });
    await wiring().run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].legacyManifestDigest).toBe('0xaa');
    expect(exits).toEqual([0]);
  });

  it('shows one entry by work kind', async () => {
    const { ctx, writes } = makeCommandCtx({
      argv: ['show', 'repository-work', '--json'],
      tty: false,
    });
    await wiring().run(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).entry.harness).toBe('claude-code');
  });

  it('lists posting entries', async () => {
    const { ctx, writes } = makeCommandCtx({ argv: ['posting', '--json'], tty: false });
    await wiring().run(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).posting[0].workKind).toBe('repository-work');
  });

  it('reports an unknown work kind as invalid_invocation (exit 11)', async () => {
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['show', 'nope', '--json'],
      tty: false,
    });
    await wiring().run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.details.field).toBe('workKind');
    expect(exits).toEqual([11]);
  });

  it('rejects an unknown subverb with invalid_invocation', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['bogus'], tty: false });
    await wiring().run(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
