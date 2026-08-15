/**
 * Tests for `jinn solver-plugins {endorse, warn, review, respond}` (issue #117).
 *
 * Each verb wraps `ReputationRegistryClient.giveFeedback` (or
 * `respondToFeedback`) anchored on `manifestRef = "plugin:<cid>"` and the
 * keccak256 of that string as `manifestHash`. The agentId of the builder
 * being feedback-targeted is resolved from the indexer via
 * `PluginPublicationReader.listPluginPublications`.
 *
 * Tests mock at the factory boundary (reputationClientFactory,
 * pluginReaderFactory, bootstrapperFactory, resolveCliPassword) — never on
 * viem itself, per the plan.
 */

import { describe, it, expect, vi } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';
import { DaemonGuardBlockedError, daemonGuardEnvelope } from '../../../src/cli/daemon-guard.js';
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

describe('jinn solver-plugins endorse', () => {
  it('runs the full pipeline and emits a tx hash envelope', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyTestCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => '0xtxendorse' as `0x${string}`);
    const reputationClientFactory = vi.fn(() => ({
      giveFeedback,
      respondToFeedback: vi.fn(),
      revokeFeedback: vi.fn(),
      readAllFeedback: vi.fn(),
      getSummary: vi.fn(),
      getClients: vi.fn(),
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
    });

    const { ctx, writes, exits } = makeCtx([
      'endorse', cid,
      '--score', '100',
      '--score-decimals', '2',
      '--tag1', 'endorsement',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(giveFeedback).toHaveBeenCalledOnce();
    const callArg = giveFeedback.mock.calls[0]![0];
    expect(callArg.harnessAgentId).toBe(777n);
    expect(callArg.score).toBe(100);
    expect(callArg.scoreDecimals).toBe(2);
    expect(callArg.tag1).toBe('endorsement');
    expect(callArg.manifestRef).toBe(`plugin:${cid}`);
    expect(callArg.manifestHash).toBe(keccak256(toBytes(`plugin:${cid}`)));

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins endorse');
    expect(out.txHash).toBe('0xtxendorse');
    expect(out.pluginCid).toBe(cid);
    expect(out.targetAgentId).toBe('777');
    expect(exits).toEqual([]);
  });

  // D0a round-1 review (minor finding): a DaemonGuardBlockedError thrown from the lazy
  // reputationClientFactory write closure must surface its full envelope through the shared
  // emitWriteError helper, not collapse into publish_failed.
  it('preserves the full daemon-guard envelope instead of collapsing it to publish_failed', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyTestCid';
    const row = fakePluginRow(cid, '777');
    const guardEnvelope = daemonGuardEnvelope(
      { blocked: true, pid: 987654, pidfilePath: '/tmp/e/daemon.pid', reason: 'alive' },
      'jinn solver-plugins publish <source>',
    );
    const giveFeedback = vi.fn(async () => { throw new DaemonGuardBlockedError(guardEnvelope); });
    const reputationClientFactory = vi.fn(() => ({
      giveFeedback,
      respondToFeedback: vi.fn(),
      revokeFeedback: vi.fn(),
      readAllFeedback: vi.fn(),
      getSummary: vi.fn(),
      getClients: vi.fn(),
    }));

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
    });

    const { ctx, writes, exits } = makeCtx([
      'endorse', cid,
      '--score', '100',
      '--score-decimals', '2',
      '--config', configPath,
    ]);
    await command.run(ctx);

    const out = parsedLine(writes) as any;
    expect(out.error.code).toBe('invalid_invocation');
    expect(out.error.message).toContain('987654');
    expect(out.error.hint).toContain('JINN_ALLOW_CLI_BROADCAST_WITH_DAEMON');
    expect(exits).toEqual([11]);
  });

  it('emits keystore_missing envelope when resolveCliPassword fails', async () => {
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
      'endorse', 'bafyCid',
      '--score', '100',
      '--config', configPath,
    ]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect((out as any).error?.message).toMatch(/JINN_PASSWORD/);
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });

  it('warn submits a score=50 tag1=warning feedback with the reason as tag2', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyWarnCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => '0xtxwarn' as `0x${string}`);
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
      'warn', cid,
      '--reason', 'flaky on swe-rebench-v2',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(giveFeedback).toHaveBeenCalledOnce();
    const callArg = giveFeedback.mock.calls[0]![0];
    expect(callArg.harnessAgentId).toBe(777n);
    expect(callArg.score).toBe(50);
    expect(callArg.scoreDecimals).toBe(2);
    expect(callArg.tag1).toBe('warning');
    expect(callArg.tag2).toBe('flaky on swe-rebench-v2');
    expect(callArg.manifestRef).toBe(`plugin:${cid}`);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins warn');
    expect(out.txHash).toBe('0xtxwarn');
    expect(out.pluginCid).toBe(cid);
    expect(exits).toEqual([]);
  });

  it('warn emits keystore_missing when no password is available', async () => {
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
      'warn', 'bafyCid', '--reason', 'because', '--config', configPath,
    ]);
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });

  it('review submits a free-form score+tag1 feedback', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyReviewCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => '0xtxreview' as `0x${string}`);
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
      'review', cid,
      '--score', '75',
      '--score-decimals', '2',
      '--tag1', 'restoration.v0',
      '--config', configPath,
    ]);
    await command.run(ctx);

    const callArg = giveFeedback.mock.calls[0]![0];
    expect(callArg.harnessAgentId).toBe(777n);
    expect(callArg.score).toBe(75);
    expect(callArg.scoreDecimals).toBe(2);
    expect(callArg.tag1).toBe('restoration.v0');
    expect(callArg.manifestRef).toBe(`plugin:${cid}`);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins review');
    expect(out.txHash).toBe('0xtxreview');
    expect(exits).toEqual([]);
  });

  it('respond submits a respondToFeedback with the resolved agentId', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyRespondCid';
    const row = fakePluginRow(cid, '777');

    const respondToFeedback = vi.fn(async () => '0xtxrespond' as `0x${string}`);
    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback,
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: true, password: 'test', source: 'env' } as any),
    });

    const { ctx, writes, exits } = makeCtx([
      'respond', cid,
      '--feedback-index', '3',
      '--client', '0xAAAA000000000000000000000000000000000001',
      '--response-uri', 'ipfs://bafyResp',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(respondToFeedback).toHaveBeenCalledOnce();
    const callArg = respondToFeedback.mock.calls[0]![0];
    expect(callArg.feedbackId.agentId).toBe(777n);
    // viem's getAddress checksums the input; assert against the checksummed form.
    expect(callArg.feedbackId.client.toLowerCase()).toBe('0xaaaa000000000000000000000000000000000001');
    expect(callArg.feedbackId.feedbackIndex).toBe(3n);
    expect(callArg.responseURI).toBe('ipfs://bafyResp');
    expect(callArg.responseHash).toBe(keccak256(toBytes('ipfs://bafyResp')));

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins respond');
    expect(out.txHash).toBe('0xtxrespond');
    expect(exits).toEqual([]);
  });

  it('review emits keystore_missing when no password is available', async () => {
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
      'review', 'bafyCid', '--score', '60', '--config', configPath,
    ]);
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });

  it('respond emits keystore_missing when no password is available', async () => {
    const configPath = withTempConfig();
    const respondToFeedback = vi.fn(async () => '0xtx' as `0x${string}`);
    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([fakePluginRow('bafyCid')]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback,
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
      resolveCliPassword: () => ({ ok: false, message: 'no password' } as any),
    });
    const { ctx, writes, exits } = makeCtx([
      'respond', 'bafyCid',
      '--feedback-index', '1',
      '--client', '0xAAAA000000000000000000000000000000000001',
      '--response-uri', 'ipfs://b',
      '--config', configPath,
    ]);
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('keystore_missing');
    expect(respondToFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });

  it('emits ensure_stage1_failed when bootstrapper reports stage1 not ok', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyStage1FailCid';
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
      'endorse', cid,
      '--score', '100',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(ensureStage1).toHaveBeenCalledOnce();
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('ensure_stage1_failed');
    expect((out as any).error?.message).toMatch(/needs funding/);
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });

  it('emits self_feedback_not_allowed when giveFeedback throws the canonical revert', async () => {
    const configPath = withTempConfig();
    const cid = 'bafySelfFeedbackCid';
    const row = fakePluginRow(cid, '777');

    const giveFeedback = vi.fn(async () => {
      throw new Error('Self-feedback not allowed');
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
      'endorse', cid,
      '--score', '100',
      '--config', configPath,
    ]);
    await command.run(ctx);

    expect(giveFeedback).toHaveBeenCalledOnce();
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('self_feedback_not_allowed');
    expect((out as any).error?.message).toMatch(/Self-feedback|caller is the agent owner/i);
    expect(exits).toEqual([1]);
  });

  it('emits agentid_unresolvable when discovery has no row for the cid', async () => {
    const configPath = withTempConfig();
    const giveFeedback = vi.fn(async () => '0xtx' as `0x${string}`);

    const command = createSolverPluginsCommand({
      bootstrapperFactory: () => ({ ensureStage1: stage1Ok() } as any),
      pluginReaderFactory: () => discoveryWith([]),
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
      'endorse', 'bafyMissingCid',
      '--score', '100',
      '--config', configPath,
    ]);
    await command.run(ctx);

    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('agentid_unresolvable');
    expect((out as any).error?.message).toMatch(/bafyMissingCid/);
    expect(giveFeedback).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });
});
