/**
 * Tests for `jinn solver-plugins block <pluginCid>` (issue #117).
 *
 * Block has dual effects:
 *   (a) network: submits a score=0 giveFeedback with tag1='block', the same
 *       Safe-routed write path the other feedback verbs use.
 *   (b) local: appends pluginCid to cfg.solverPlugins.blockedCids and writes
 *       the config file. This local effect MUST succeed even when the
 *       network publish fails.
 *
 * Coverage:
 *   - happy network+local (envelope has blockedLocal+txHash; config file
 *     contains the cid)
 *   - network-fails-but-local-ok (envelope carries networkPublishError;
 *     config file still updated; exit 0)
 *   - config-write-fails (envelope is { error: config_write_failed }; exit 1)
 *   - keystore_missing (no password)
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';
import type {
  PluginPublicationReader,
  PluginPublication,
} from '../../../src/plugin-registry/publication-reader.js';
import {
  withTempConfig,
  makeCtx,
  parsedLine,
} from './solver-plugins-test-helpers.js';

function stage1Ok() {
  return vi.fn(async () => ({
    ok: true,
    fleet_state: {
      fleet_agent_id: '888',
      fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
      fleet_identity_registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      fleet_stage: 'stage1',
      chain: 'base-sepolia',
    },
    message: 'Stage 1 complete.',
  }));
}

function fakePluginRow(cid: string, builderAgentId = '777'): PluginPublication {
  return {
    builderAgentId,
    cid,
    name: '@b/p',
    version: '0.1.0',
    supports: ['swe-rebench-v2.v1'],
    publishedAt: 1,
    artifactType: 'plugin',
    revoked: false,
    pluginSha256: '0x0000000000000000000000000000000000000000000000000000000000000001',
  };
}

function discoveryWith(rows: PluginPublication[]): PluginPublicationReader {
  return {
    listPluginPublications: vi.fn(async () => rows),
  } as unknown as PluginPublicationReader;
}

describe('jinn solver-plugins block', () => {
  it('submits a score=0 block feedback AND appends the cid to local blockedCids', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyBlockCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => '0xtxblock' as `0x${string}`);
    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory: () =>
        ({
          giveFeedback,
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
    });

    const { ctx, writes, exits } = makeCtx([
      'block', cid,
      '--reason', 'malicious',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(giveFeedback).toHaveBeenCalledOnce();
    const callArg = giveFeedback.mock.calls[0]![0];
    expect(callArg.harnessAgentId).toBe(777n);
    expect(callArg.score).toBe(0);
    expect(callArg.tag1).toBe('block');
    expect(callArg.tag2).toBe('malicious');

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins block');
    expect(out.blockedLocal).toBe(true);
    expect(out.txHash).toBe('0xtxblock');
    expect(out.pluginCid).toBe(cid);
    expect(exits).toEqual([]);

    // Read back the on-disk config and verify blockedCids contains the cid.
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.solverPlugins?.blockedCids).toContain(cid);
  });

  it('still writes the local block when the network giveFeedback fails', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyNetworkFailCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => {
      throw new Error('rpc 500');
    });

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory: () =>
        ({
          giveFeedback,
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
    });

    const { ctx, writes, exits } = makeCtx([
      'block', cid,
      '--reason', 'malicious',
      '--config', configPath,
    ]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins block');
    expect(out.blockedLocal).toBe(true);
    expect(out.pluginCid).toBe(cid);
    expect((out as any).networkPublishError?.code).toBe('blocked_locally_only');
    expect((out as any).networkPublishError?.message).toMatch(/rpc 500/);
    expect(exits).toEqual([]); // Local effect succeeded; exit 0 even though network failed.

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.solverPlugins?.blockedCids).toContain(cid);
  });

  it('emits config_write_failed when the local config write throws', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyConfigFailCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => '0xtxblock' as `0x${string}`);
    const writeConfigFile = vi.fn(() => {
      throw new Error('EACCES: permission denied');
    });

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory: () =>
        ({
          giveFeedback,
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
      writeConfigFile,
    });

    const { ctx, writes, exits } = makeCtx([
      'block', cid,
      '--reason', 'because',
      '--config', configPath,
    ]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('config_write_failed');
    expect((out as any).error?.message).toMatch(/EACCES/);
    expect(exits).toEqual([1]);
  });

  it('emits ensure_stage1_failed when bootstrapper reports stage1 not ok', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyBlockStage1FailCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => '0xtx' as `0x${string}`);
    const ensureStage1 = vi.fn(async () => ({
      ok: false,
      message: 'needs funding',
      fleet_state: {},
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1 } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory: () =>
        ({
          giveFeedback,
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
    });

    const { ctx, writes, exits } = makeCtx([
      'block', cid,
      '--reason', 'malicious',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(ensureStage1).toHaveBeenCalledOnce();
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('ensure_stage1_failed');
    expect((out as any).error?.message).toMatch(/needs funding/);
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);

    // Local block must NOT happen if the pipeline aborted before the local write.
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.solverPlugins?.blockedCids ?? []).not.toContain(cid);
  });

  it('emits keystore_missing when no password is available', async () => {
    const configPath = withTempConfig();
    const giveFeedback = vi.fn(async () => '0xtx' as `0x${string}`);
    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([fakePluginRow('bafyCid')]),
      reputationClientFactory: () =>
        ({
          giveFeedback,
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: false, message: 'no password' } as any),
    });
    const { ctx, writes, exits } = makeCtx([
      'block', 'bafyCid', '--reason', 'because', '--config', configPath,
    ]);
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });
});
