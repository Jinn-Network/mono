/**
 * Tests for `jinn solver-plugins {list-feedback, discover, status}` (issue #117).
 *
 * Read verbs that do NOT resolve the keystore password. The handler MUST run
 * to completion with `env = {}` (no JINN_PASSWORD).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSolverPluginsCommand,
  PRODUCTION_DEPS,
} from '../../../src/cli/commands/solver-plugins.js';
import {
  PluginPublicationUnavailableError,
  type PluginPublicationReader,
  type PluginPublication,
} from '../../../src/plugin-registry/publication-reader.js';
import { withTempConfig, makeCtx, parsedLine } from './solver-plugins-test-helpers.js';

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

function discoveryThatThrows(err: Error): PluginPublicationReader {
  return {
    listPluginPublications: vi.fn(async () => {
      throw err;
    }),
  } as unknown as PluginPublicationReader;
}

describe('jinn solver-plugins (dispatcher)', () => {
  it('lists the new verbs in the help text', async () => {
    const command = createSolverPluginsCommand({});
    const { ctx, writes, exits } = makeCtx(['--help'], {});
    await command.run(ctx);
    const help = writes.join('');
    for (const verb of ['endorse', 'warn', 'block', 'review', 'respond', 'list-feedback', 'discover', 'status']) {
      expect(help).toContain(`jinn solver-plugins ${verb}`);
    }
    expect(exits).toEqual([]);
  });

  it('lists the new verbs in the invalid_invocation envelope expected field', async () => {
    const command = createSolverPluginsCommand({});
    const { ctx, writes, exits } = makeCtx(['unknown-subverb'], {});
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('invalid_invocation');
    const expected = (out as any).error?.expected as string;
    for (const verb of ['endorse', 'warn', 'block', 'review', 'respond', 'list-feedback', 'discover', 'status']) {
      expect(expected).toContain(verb);
    }
    expect(exits).toEqual([1]);
  });
});

describe('jinn solver-plugins status', () => {
  it('returns status="published" with publication + summary when discovery has a row', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyStatCid';

    const getClients = vi.fn(async () => ['0xCCCC000000000000000000000000000000000003' as `0x${string}`]);
    const getSummary = vi.fn(async () => ({
      count: 3n,
      summaryValue: 250n,
      summaryValueDecimals: 2,
    }));

    const command = createSolverPluginsCommand({
      pluginReaderFactory: () => discoveryWith([fakePluginRow(cid, '777')]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary,
          getClients,
        }) as any,
    });

    const { ctx, writes, exits } = makeCtx(['status', cid, '--config', configPath], {});
    await command.run(ctx);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins status');
    expect(out.pluginCid).toBe(cid);
    expect(out.status).toBe('published');
    expect((out as any).summary?.count).toBe('3');
    expect((out as any).summary?.summaryValue).toBe('250');
    expect(out.locallyBlocked).toBe(false);
    expect(exits).toEqual([]);
  });

  it('returns status="not_published" without erroring when discovery has no row', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () => discoveryWith([]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(
      ['status', 'bafyMissing', '--config', configPath],
      {},
    );
    await command.run(ctx);
    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins status');
    expect(out.status).toBe('not_published');
    expect(out.locallyBlocked).toBe(false);
    expect(exits).toEqual([]);
  });

  it('returns status="revoked" when discovery row is revoked', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyRev';
    const row = { ...fakePluginRow(cid, '777'), revoked: true, revokedReason: 'CVE' };
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () => discoveryWith([row]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(async () => []),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(['status', cid, '--config', configPath], {});
    await command.run(ctx);
    const out = parsedLine(writes);
    expect(out.status).toBe('revoked');
    expect((out as any).revokedReason).toBe('CVE');
    expect(exits).toEqual([]);
  });

  it('marks locallyBlocked=true when the cid is in solverPlugins.blockedCids', async () => {
    const cid = 'bafyLocallyBlocked';
    const configPath = withTempConfig({
      solverPlugins: { blockedCids: [cid] },
    });
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () => discoveryWith([fakePluginRow(cid, '777')]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(async () => []),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(['status', cid, '--config', configPath], {});
    await command.run(ctx);
    const out = parsedLine(writes);
    expect(out.locallyBlocked).toBe(true);
    expect(exits).toEqual([]);
  });

  it('emits discovery_unavailable when factory throws', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () =>
        discoveryThatThrows(new PluginPublicationUnavailableError('rpc timeout')),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(['status', 'bafy', '--config', configPath], {});
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('discovery_unavailable');
    expect(exits).toEqual([1]);
  });
});

describe('jinn solver-plugins discover', () => {
  it('lists published plug-in rows from discovery', async () => {
    const configPath = withTempConfig();
    const rows = [
      fakePluginRow('bafyA', '777'),
      fakePluginRow('bafyB', '778'),
    ];
    const listPluginPublications = vi.fn(async () => rows);
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () =>
        ({ listPluginPublications } as unknown as PluginPublicationReader),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
    });

    const { ctx, writes, exits } = makeCtx(
      ['discover', '--solver-type', 'swe-rebench-v2.v1', '--config', configPath],
      {}, // No JINN_PASSWORD.
    );
    await command.run(ctx);

    expect(listPluginPublications).toHaveBeenCalledOnce();
    const callArg = listPluginPublications.mock.calls[0]![0];
    expect(callArg?.solverType).toBe('swe-rebench-v2.v1');

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins discover');
    const plugins = out.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(2);
    expect(plugins[0]!.cid).toBe('bafyA');
    expect(plugins[1]!.cid).toBe('bafyB');
    expect(exits).toEqual([]);
  });

  it('emits discovery_unavailable when the factory throws', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () =>
        discoveryThatThrows(new PluginPublicationUnavailableError('unreachable')),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(['discover', '--config', configPath], {});
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('discovery_unavailable');
    expect(exits).toEqual([1]);
  });
});

describe('jinn solver-plugins list-feedback', () => {
  it('reads all feedback for the cid via the read-only client', async () => {
    const configPath = withTempConfig();
    const cid = 'bafyFeedCid';

    const readAllFeedback = vi.fn(async () => [
      {
        agentId: 777n,
        client: '0xAAAA000000000000000000000000000000000001' as `0x${string}`,
        feedbackIndex: 1n,
        score: 100n,
        scoreDecimals: 2,
        tag1: 'endorsement',
        tag2: undefined,
        revoked: false,
      },
      {
        agentId: 777n,
        client: '0xBBBB000000000000000000000000000000000002' as `0x${string}`,
        feedbackIndex: 2n,
        score: 0n,
        scoreDecimals: 2,
        tag1: 'block',
        tag2: 'malicious',
        revoked: false,
      },
    ]);
    const reputationClientFactory = vi.fn((args: any) => {
      // Read-only verb: factory must accept undefined password.
      expect(args.password).toBeUndefined();
      return {
        giveFeedback: vi.fn(),
        respondToFeedback: vi.fn(),
        revokeFeedback: vi.fn(),
        readAllFeedback,
        getSummary: vi.fn(),
        getClients: vi.fn(),
      };
    });

    const command = createSolverPluginsCommand({
      pluginReaderFactory: () => discoveryWith([fakePluginRow(cid, '777')]),
      reputationClientFactory,
    });

    const { ctx, writes, exits } = makeCtx(
      ['list-feedback', cid, '--config', configPath],
      {}, // No JINN_PASSWORD — read verbs must work without it.
    );
    await command.run(ctx);

    expect(readAllFeedback).toHaveBeenCalledOnce();
    expect(readAllFeedback.mock.calls[0]![0]).toBe(777n);

    const out = parsedLine(writes);
    expect(out.verb).toBe('solver-plugins list-feedback');
    expect(out.pluginCid).toBe(cid);
    expect(out.targetAgentId).toBe('777');
    const records = out.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]!.tag1).toBe('endorsement');
    expect(records[1]!.tag1).toBe('block');
    expect(exits).toEqual([]);
  });

  it('emits agentid_unresolvable when discovery has no row', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () => discoveryWith([]),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(
      ['list-feedback', 'bafyMissingCid', '--config', configPath],
      {},
    );
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('agentid_unresolvable');
    expect(exits).toEqual([1]);
  });

  it('emits discovery_unavailable when the factory throws PluginPublicationUnavailableError', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      pluginReaderFactory: () =>
        discoveryThatThrows(new PluginPublicationUnavailableError('indexer 503')),
      reputationClientFactory: () =>
        ({
          giveFeedback: vi.fn(),
          respondToFeedback: vi.fn(),
          revokeFeedback: vi.fn(),
          readAllFeedback: vi.fn(),
          getSummary: vi.fn(),
          getClients: vi.fn(),
        }) as any,
    });
    const { ctx, writes, exits } = makeCtx(
      ['list-feedback', 'bafyCid', '--config', configPath],
      {},
    );
    await command.run(ctx);
    const out = parsedLine(writes);
    expect((out as any).error?.code).toBe('discovery_unavailable');
    expect((out as any).error?.message).toMatch(/indexer/);
    expect(exits).toEqual([1]);
  });
});

/**
 * Direct factory-level coverage of the read-only path: when the production
 * `reputationClientFactory` is called with `password: undefined`, it must
 * return a handle whose write methods throw the canonical
 * `walletClient required` error. The factory uses `http()` transports so
 * client construction does not hit the network.
 */
describe('PRODUCTION_DEPS.reputationClientFactory (read-only path)', () => {
  it('returns a handle whose giveFeedback throws walletClient required when password is undefined', async () => {
    const handle = PRODUCTION_DEPS.reputationClientFactory({
      reputationRegistryAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      safeAddress: '0xBBBB000000000000000000000000000000000001',
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base-sepolia',
      earningDir: '/tmp/jinn-readonly-factory-test',
      password: undefined,
    });

    await expect(
      handle.giveFeedback({
        harnessAgentId: 777n,
        score: 100,
        scoreDecimals: 2,
        manifestRef: 'plugin:bafyCid',
        manifestHash:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
      }),
    ).rejects.toThrow(/walletClient required/);
  });

  it('returns a handle whose respondToFeedback throws walletClient required when password is undefined', async () => {
    const handle = PRODUCTION_DEPS.reputationClientFactory({
      reputationRegistryAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      safeAddress: undefined,
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base-sepolia',
      earningDir: '/tmp/jinn-readonly-factory-test',
      password: undefined,
    });

    await expect(
      handle.respondToFeedback({
        feedbackId: {
          agentId: 777n,
          client: '0xAAAA000000000000000000000000000000000001',
          feedbackIndex: 1n,
        },
        responseURI: 'ipfs://bafyResp',
        responseHash:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
      }),
    ).rejects.toThrow(/walletClient required/);
  });
});
