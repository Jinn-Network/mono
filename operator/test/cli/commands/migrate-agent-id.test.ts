import { describe, expect, it } from 'vitest';
import {
  createMigrateAgentIdCommand,
  type MigrateAgentIdDeps,
} from '../../../src/cli/commands/migrate-agent-id.js';
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
  earningDir: '/tmp/earning',
  network: 'testnet',
  rpcUrl: 'http://127.0.0.1:8545',
  stakingMode: 'standard',
  targetServices: 1,
  debug: false,
  pollIntervalMs: 5000,
};

interface FakeDepsOverrides {
  passwordOk?: boolean;
  migrationResult?: {
    migrated: any[];
    skipped: any[];
    failed: any[];
  };
  migrationThrows?: Error;
  captureRunArgs?: (args: any) => void;
}

function makeFakeDeps(overrides: FakeDepsOverrides = {}): MigrateAgentIdDeps {
  return {
    loadConfig: () => defaultConfig as any,
    getConfigPathFromArgs: () => undefined,
    resolveCliPassword: () =>
      overrides.passwordOk === false
        ? { ok: false as const, message: 'no password' }
        : { ok: true as const, password: 'pw' },
    runMigration: async (args: any) => {
      overrides.captureRunArgs?.(args);
      if (overrides.migrationThrows) throw overrides.migrationThrows;
      return (
        overrides.migrationResult ?? {
          migrated: [],
          skipped: [],
          failed: [],
        }
      );
    },
  };
}

describe('migrate-agent-id command', () => {
  it('parses and dispatches with empty migration result; emits JSON by default', async () => {
    const cmd = createMigrateAgentIdCommand(makeFakeDeps());
    const { ctx, writes, exits } = makeCommandCtx({
      env: { JINN_PASSWORD: 'pw' },
    });
    await cmd.run(ctx);
    expect(exits).toEqual([0]);
    const line = writes.join('').trim();
    expect(line.startsWith('{')).toBe(true);
    const payload = JSON.parse(line);
    expect(payload.migrated).toEqual([]);
    expect(payload.skipped).toEqual([]);
    expect(payload.failed).toEqual([]);
    expect(payload.schemaVersion).toBe(1);
  });

  it('passes through migrated/skipped/failed counts to the JSON payload', async () => {
    const cmd = createMigrateAgentIdCommand(
      makeFakeDeps({
        migrationResult: {
          migrated: [{ index: 1, agent_id: '7' } as any],
          skipped: [{ index: 2, agent_id: '999' } as any],
          failed: [{ service: { index: 3 } as any, error: 'boom' }],
        },
      }),
    );
    const { ctx, writes, exits } = makeCommandCtx({
      env: { JINN_PASSWORD: 'pw' },
    });
    await cmd.run(ctx);
    expect(exits).toEqual([0]);
    const payload = JSON.parse(writes.join('').trim());
    expect(payload.migrated).toEqual([{ index: 1, agentId: '7' }]);
    expect(payload.skipped).toEqual([{ index: 2, agentId: '999' }]);
    expect(payload.failed).toEqual([{ index: 3, error: 'boom' }]);
  });

  it('emits invalid_invocation when password is missing', async () => {
    const cmd = createMigrateAgentIdCommand(makeFakeDeps({ passwordOk: false }));
    const { ctx, writes, exits } = makeCommandCtx({ env: {} });
    await cmd.run(ctx);
    const env = JSON.parse(writes.join('').trim());
    expect(env.code).toBe('invalid_invocation');
    expect(exits[0]).not.toBe(0);
  });

  it('renders human output when --human is passed', async () => {
    const cmd = createMigrateAgentIdCommand(
      makeFakeDeps({
        migrationResult: {
          migrated: [{ index: 1, agent_id: '42' } as any],
          skipped: [],
          failed: [],
        },
      }),
    );
    const { ctx, writes, exits } = makeCommandCtx({
      argv: ['--human'],
      env: { JINN_PASSWORD: 'pw' },
    });
    await cmd.run(ctx);
    expect(exits).toEqual([0]);
    const out = writes.join('');
    expect(out).toContain('Legacy agent_id migration complete.');
    expect(out).toContain('migrated: 1');
    expect(out).toContain('agentId=42');
  });

  it('emits fatal envelope when the migration throws', async () => {
    const cmd = createMigrateAgentIdCommand(
      makeFakeDeps({ migrationThrows: new Error('rpc dead') }),
    );
    const { ctx, writes, exits } = makeCommandCtx({
      env: { JINN_PASSWORD: 'pw' },
    });
    await cmd.run(ctx);
    const env = JSON.parse(writes.join('').trim());
    expect(env.code).toBe('fatal');
    expect(env.message).toContain('rpc dead');
    expect(exits[0]).not.toBe(0);
  });

  it('forwards network + rpcUrl + earningDir to runMigration', async () => {
    let captured: any;
    const cmd = createMigrateAgentIdCommand(
      makeFakeDeps({ captureRunArgs: (a) => { captured = a; } }),
    );
    const { ctx } = makeCommandCtx({ env: { JINN_PASSWORD: 'pw' } });
    await cmd.run(ctx);
    expect(captured.earningDir).toBe('/tmp/earning');
    expect(captured.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(captured.network).toBe('base-sepolia'); // testnet → base-sepolia
    expect(captured.password).toBe('pw');
  });
});
