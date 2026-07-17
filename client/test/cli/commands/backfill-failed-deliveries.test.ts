import { describe, expect, it } from 'vitest';
import {
  createBackfillFailedDeliveriesCommand,
  type BackfillFailedDeliveriesCommandDeps,
} from '../../../src/cli/commands/backfill-failed-deliveries.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCommandCtx(opts: { argv?: string[]; env?: NodeJS.ProcessEnv } = {}): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: opts.argv ?? [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: opts.env ?? {},
  };
  return { ctx, writes, exits };
}

const defaultConfig = {
  dbPath: '/tmp/jinn.db',
  network: 'testnet',
  rpcUrl: 'http://127.0.0.1:8545',
  rpcUrls: ['http://127.0.0.1:8545'],
};

interface FakeDepsOverrides {
  backfillResult?: {
    reclassified: Array<{ requestId: string; originalFailureReason: string | null }>;
    skipped: Array<{ requestId: string; reason: string }>;
    failed: Array<{ requestId: string; error: string }>;
  };
  backfillThrows?: Error;
  captureRunArgs?: (args: any) => void;
}

function makeFakeDeps(overrides: FakeDepsOverrides = {}): BackfillFailedDeliveriesCommandDeps {
  return {
    loadConfig: () => defaultConfig as any,
    getConfigPathFromArgs: () => undefined,
    runBackfill: async (args: any) => {
      overrides.captureRunArgs?.(args);
      if (overrides.backfillThrows) throw overrides.backfillThrows;
      return overrides.backfillResult ?? { reclassified: [], skipped: [], failed: [] };
    },
  };
}

describe('backfill-failed-deliveries command', () => {
  it('parses and dispatches with empty result; emits JSON by default', async () => {
    const cmd = createBackfillFailedDeliveriesCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    expect(exits).toEqual([0]);
    const line = writes.join('').trim();
    expect(line.startsWith('{')).toBe(true);
    const payload = JSON.parse(line);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.dryRun).toBe(false);
    expect(payload.reclassified).toEqual([]);
    expect(payload.skipped).toEqual([]);
    expect(payload.failed).toEqual([]);
  });

  it('passes through reclassified/skipped/failed counts to the JSON payload', async () => {
    const cmd = createBackfillFailedDeliveriesCommand(
      makeFakeDeps({
        backfillResult: {
          reclassified: [{ requestId: 'req-1', originalFailureReason: 'NOT NULL constraint failed: artifacts.desired_state_id' }],
          skipped: [{ requestId: 'req-2', reason: 'no deliveryTxHash recorded' }],
          failed: [{ requestId: 'req-3', error: 'boom' }],
        },
      }),
    );
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    expect(exits).toEqual([0]);
    const payload = JSON.parse(writes.join('').trim());
    expect(payload.reclassified).toEqual([
      { requestId: 'req-1', originalFailureReason: 'NOT NULL constraint failed: artifacts.desired_state_id' },
    ]);
    expect(payload.skipped).toEqual([{ requestId: 'req-2', reason: 'no deliveryTxHash recorded' }]);
    expect(payload.failed).toEqual([{ requestId: 'req-3', error: 'boom' }]);
  });

  it('renders human output when --human is passed', async () => {
    const cmd = createBackfillFailedDeliveriesCommand(
      makeFakeDeps({
        backfillResult: {
          reclassified: [{ requestId: 'req-1', originalFailureReason: 'NOT NULL constraint failed: artifacts.desired_state_id' }],
          skipped: [],
          failed: [],
        },
      }),
    );
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--human'] });
    await cmd.run(ctx);
    expect(exits).toEqual([0]);
    const out = writes.join('');
    expect(out).toContain('reclassified: 1');
    expect(out).toContain('req-1');
    expect(out).toContain('NOT NULL constraint failed: artifacts.desired_state_id');
  });

  it('emits fatal envelope when the backfill throws', async () => {
    const cmd = createBackfillFailedDeliveriesCommand(
      makeFakeDeps({ backfillThrows: new Error('rpc dead') }),
    );
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    const env = JSON.parse(writes.join('').trim());
    expect(env.code).toBe('fatal');
    expect(env.message).toContain('rpc dead');
    expect(exits[0]).not.toBe(0);
  });

  it('forwards --dry-run through to runBackfill and the JSON payload', async () => {
    let captured: any;
    const cmd = createBackfillFailedDeliveriesCommand(
      makeFakeDeps({ captureRunArgs: (a) => { captured = a; } }),
    );
    const { ctx, writes } = makeCommandCtx({ argv: ['--dry-run'] });
    await cmd.run(ctx);
    expect(captured.dryRun).toBe(true);
    const payload = JSON.parse(writes.join('').trim());
    expect(payload.dryRun).toBe(true);
  });

  it('forwards dbPath + rpcUrls + resolved network to runBackfill', async () => {
    let captured: any;
    const cmd = createBackfillFailedDeliveriesCommand(
      makeFakeDeps({ captureRunArgs: (a) => { captured = a; } }),
    );
    const { ctx } = makeCommandCtx();
    await cmd.run(ctx);
    expect(captured.dbPath).toBe('/tmp/jinn.db');
    expect(captured.rpcUrls).toEqual(['http://127.0.0.1:8545']);
    expect(captured.network).toBe('base-sepolia'); // testnet -> base-sepolia
    expect(captured.dryRun).toBe(false);
  });
});
