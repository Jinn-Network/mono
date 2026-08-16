/**
 * Tests for `jinn solver-plugins publish <source>` (jinn-mono-1pbc).
 *
 * Verifies:
 *   - Lazy ensureStage1 is invoked before any chain write
 *   - resolveSolverPlugin → pack → pinFileToIpfs → encodePluginPayload → publisher.publish
 *     pipeline produces a single tx hash in the output envelope
 *   - --builder-agent-id flag overrides fleet_agent_id
 *   - Failure when keystore missing is surfaced with code `keystore_missing`
 *   - No-op ensureStage1 when fleet_stage already 'stage1' or 'stage1_and_2'
 */

import { describe, it, expect, vi } from 'vitest';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';
import { DaemonGuardBlockedError, daemonGuardEnvelope } from '../../../src/cli/daemon-guard.js';
import {
  withTempPlugin,
  withTempConfig,
  makeCtx,
  parsedLine,
} from './solver-plugins-test-helpers.js';

describe('jinn solver-plugins publish', () => {
  it('runs the full pipeline and emits a tx hash envelope', async () => {
    const pluginRoot = withTempPlugin('@builder/swe-skill', '0.1.0');
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async (_pw: string) => ({
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
    const pinFile = vi.fn(async (_url: string, _path: string) => 'bafyTarballCid');
    const publish = vi.fn(async () => '0xtxhashpublish' as `0x${string}`);
    const publisherFactory = vi.fn(() => ({ publish, revoke: vi.fn() }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: pinFile,
      publisherFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    expect(ensureStage1).toHaveBeenCalledWith('test');
    expect(pinFile).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const callArg = publish.mock.calls[0]![0];
    expect(callArg.pluginCid).toBe('bafyTarballCid');
    expect(callArg.payload.pluginName).toBe('@builder/swe-skill');
    expect(callArg.payload.pluginVersion).toBe('0.1.0');
    expect(callArg.payload.supports).toEqual(['swe-rebench-v2.v1']);
    expect(callArg.payload.publishedAt).toBe(1_715_700_000);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins publish');
    expect(out.txHash).toBe('0xtxhashpublish');
    expect(out.pluginCid).toBe('bafyTarballCid');
    expect(out.builderAgentId).toBe('777');
    expect(out.pluginSha256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(exits).toEqual([]);
  });

  it('skips ensureStage1 chain calls when fleet_stage is already stage1_and_2', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async () => ({
      ok: true,
      fleet_state: {
        fleet_agent_id: '777',
        fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
        fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        fleet_stage: 'stage1_and_2',
        chain: 'base-sepolia',
      },
      message: 'Stage 1 already complete (no-op).',
    }));
    const publish = vi.fn(async () => '0xtx' as `0x${string}`);

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(async () => 'bafyCid'),
      publisherFactory: () => ({ publish, revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    expect(ensureStage1).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('emits keystore_missing envelope when resolveCliPassword fails', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: vi.fn() } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: false, error: 'no password' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect(exits).toEqual([1]);
  });

  // D0a round-1 review (minor finding): a DaemonGuardBlockedError thrown from the lazy
  // publisherFactory write closure must surface its full envelope (pid, pidfile path, opt-out
  // hint) as invalid_invocation/exit 11 -- not get collapsed into a generic publish_failed
  // message that loses that detail.
  it('preserves the full daemon-guard envelope instead of collapsing it to publish_failed', async () => {
    const pluginRoot = withTempPlugin();
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
    const publish = vi.fn(async () => { throw new DaemonGuardBlockedError(guardEnvelope); });

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(async () => 'bafyTarballCid'),
      publisherFactory: () => ({ publish, revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    const out = parsedLine(writes) as any;
    expect(out.error.code).toBe('invalid_invocation');
    expect(out.error.message).toContain('987654');
    expect(out.error.hint).toContain('JINN_ALLOW_CLI_BROADCAST_WITH_DAEMON');
    expect(out.error.details).toMatchObject({ pid: 987654, pidfilePath: '/tmp/e/daemon.pid' });
    expect(exits).toEqual([11]);
  });

  it('honours --builder-agent-id override', async () => {
    const pluginRoot = withTempPlugin();
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

    const seenConfigs: any[] = [];
    const publisherFactory = vi.fn((config: any) => {
      seenConfigs.push(config);
      return { publish: vi.fn(async () => '0xtx' as `0x${string}`), revoke: vi.fn() };
    });

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(async () => 'bafyCid'),
      publisherFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx } = makeCtx([
      'publish', `path:${pluginRoot}`, '--config', configPath,
      '--builder-agent-id', '999',
    ]);
    await command.run(ctx);

    expect(seenConfigs[0].builderAgentId).toBe(999n);
  });

  it('emits ensure_stage1_failed when bootstrapper returns ok=false', async () => {
    const pluginRoot = withTempPlugin();
    const configPath = withTempConfig();

    const ensureStage1 = vi.fn(async () => ({
      ok: false,
      fleet_state: {
        fleet_agent_id: null,
        fleet_safe_address: null,
        fleet_identity_registry: null,
        fleet_stage: 'none',
        chain: 'base-sepolia',
      },
      message: 'Your master wallet needs more ETH …',
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pinFileToIpfs: vi.fn(),
      publisherFactory: () => ({ publish: vi.fn(), revoke: vi.fn() }),
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      now: () => 1_715_700_000_000,
    });

    const { ctx, writes, exits } = makeCtx(['publish', `path:${pluginRoot}`, '--config', configPath]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('ensure_stage1_failed');
    expect((out as any).error?.message).toMatch(/master wallet/);
    expect(exits).toEqual([1]);
  });
});
