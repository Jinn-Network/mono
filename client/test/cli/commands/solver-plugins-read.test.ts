/**
 * Tests for `jinn solver-plugins {list-feedback, discover, status}` (issue #117).
 *
 * Read verbs that do NOT resolve the keystore password. The handler MUST run
 * to completion with `env = {}` (no JINN_PASSWORD).
 */

import { describe, it, expect, vi } from 'vitest';
import { createSolverPluginsCommand } from '../../../src/cli/commands/solver-plugins.js';
import { DiscoveryUnavailableError } from '../../../src/discovery/types.js';
import type { DiscoveryAPI, PluginPublication } from '../../../src/discovery/types.js';
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

function discoveryWith(rows: PluginPublication[]): DiscoveryAPI {
  return {
    listPluginPublications: vi.fn(async () => rows),
  } as unknown as DiscoveryAPI;
}

function discoveryThatThrows(err: Error): DiscoveryAPI {
  return {
    listPluginPublications: vi.fn(async () => {
      throw err;
    }),
  } as unknown as DiscoveryAPI;
}

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
      discoveryApiFactory: () => discoveryWith([fakePluginRow(cid, '777')]),
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
      discoveryApiFactory: () => discoveryWith([]),
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

  it('emits discovery_unavailable when the factory throws DiscoveryUnavailableError', async () => {
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({
      discoveryApiFactory: () =>
        discoveryThatThrows(new DiscoveryUnavailableError('indexer 503')),
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
