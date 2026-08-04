import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../../src/cli/command.js';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';
import { DaemonGuardBlockedError, daemonGuardEnvelope } from '../../../src/cli/daemon-guard.js';

const tempDirs: string[] = [];

function withTempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-revoke-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    rpcUrl: 'http://127.0.0.1:8545',
    network: 'testnet',
    earningDir: dir,
  }), 'utf-8');
  return configPath;
}

function makeCtx(argv: string[]): {
  ctx: CommandContext; writes: string[]; exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: { write: (s) => { writes.push(s); return true; } },
      exit: (code) => { exits.push(code); },
      env: { JINN_PASSWORD: 'test' },
    },
    writes, exits,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('jinn solver-plugins revoke', () => {
  it('writes a v2 revoked-marker via publisher.revoke', async () => {
    const configPath = withTempConfig();
    const revoke = vi.fn(async () => '0xtxrevoke' as `0x${string}`);

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx([
      'revoke', 'bafyOldCid',
      '--reason', 'security advisory CVE-2026-XXXX',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(revoke).toHaveBeenCalledOnce();
    const callArg = revoke.mock.calls[0]![0];
    expect(callArg.pluginCid).toBe('bafyOldCid');
    expect(callArg.payload.version).toBe(2);
    expect(callArg.payload.revoked).toBe(true);
    expect(callArg.payload.reason).toBe('security advisory CVE-2026-XXXX');

    const out = JSON.parse(writes.join('').trim().split('\n').pop()!);
    expect(out.verb).toBe('solver-plugins revoke');
    expect(out.txHash).toBe('0xtxrevoke');
    expect(out.pluginCid).toBe('bafyOldCid');
    expect(out.reason).toBe('security advisory CVE-2026-XXXX');
    expect(exits).toEqual([]);
  });

  // D0a round-1 review (minor finding): a DaemonGuardBlockedError thrown from the lazy
  // publisherFactory write closure must surface its full envelope, not collapse into
  // revoke_failed.
  it('preserves the full daemon-guard envelope instead of collapsing it to revoke_failed', async () => {
    const configPath = withTempConfig();
    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));
    const guardEnvelope = daemonGuardEnvelope(
      { blocked: true, pid: 987654, pidfilePath: '/tmp/e/daemon.pid', reason: 'alive' },
      'jinn solver-plugins publish <source>',
    );
    const revoke = vi.fn(async () => { throw new DaemonGuardBlockedError(guardEnvelope); });

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx([
      'revoke', 'bafyOldCid', '--reason', 'x', '--config', configPath,
    ]);
    await command.run(ctx);

    const out = JSON.parse(writes.join('').trim().split('\n').pop()!);
    expect(out.error.code).toBe('invalid_invocation');
    expect(out.error.message).toContain('987654');
    expect(out.error.hint).toContain('JINN_ALLOW_CLI_BROADCAST_WITH_DAEMON');
    expect(exits).toEqual([11]);
  });

  it('requires --reason', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: vi.fn() } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });
    const { ctx, writes, exits } = makeCtx(['revoke', 'bafyOldCid', '--config', configPath]);
    await command.run(ctx);
    const out = JSON.parse(writes.join('').trim().split('\n').pop()!);
    expect(out.error.code).toBe('invalid_invocation');
    expect(out.error.message).toMatch(/reason/i);
    expect(exits).toEqual([1]);
  });

  it('honours --builder-agent-id override', async () => {
    const configPath = withTempConfig();
    const revoke = vi.fn(async () => '0xtx' as `0x${string}`);
    const seenConfigs: any[] = [];
    const publisherFactory = vi.fn((cfg: any) => {
      seenConfigs.push(cfg);
      return { publish: vi.fn(), revoke };
    });

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 complete.',
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx } = makeCtx([
      'revoke', 'bafyOldCid',
      '--reason', 'replaced by v0.2.0',
      '--builder-agent-id', '999',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(seenConfigs[0].builderAgentId).toBe(999n);
  });
});
