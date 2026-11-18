/**
 * #5391: every `jinn solver-plugins` write verb accepts `--password-fd N` and
 * uses the password read from that descriptor.
 *
 * These tests leave `resolveCliPassword` as the production resolver and set a
 * different `JINN_PASSWORD`, so the password that reaches Stage 1 and the
 * signing factory proves which source won. Before the fix each verb's strict
 * flag table refused the flag as an unknown option.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSolverPluginsCommand,
  type PublisherFactoryArgs,
  type ReputationClientFactoryArgs,
} from '../../../src/cli/commands/solver-plugins.js';
import type {
  PluginPublication,
  PluginPublicationReader,
} from '../../../src/plugin-registry/publication-reader.js';
import {
  makeCtx,
  parsedLine,
  tempDirs,
  withTempConfig,
  withTempPlugin,
} from './solver-plugins-test-helpers.js';

const FD_PASSWORD = 'password-from-fd';
const ENV_PASSWORD = 'password-from-env';
const CID = 'bafyPasswordFdCid';

const openFds: number[] = [];

afterEach(() => {
  for (const fd of openFds.splice(0)) closeSync(fd);
});

function openPasswordFd(): number {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-sp-password-fd-'));
  tempDirs.push(dir);
  const path = join(dir, 'password');
  writeFileSync(path, `${FD_PASSWORD}\n`, { mode: 0o600 });
  const fd = openSync(path, 'r');
  openFds.push(fd);
  return fd;
}

function pluginRow(): PluginPublication {
  return {
    builderAgentId: '777',
    cid: CID,
    name: '@b/p',
    version: '0.1.0',
    supports: ['swe-rebench-v2.v1'],
    publishedAt: 1,
    artifactType: 'plugin',
    revoked: false,
    pluginSha256: '0x0000000000000000000000000000000000000000000000000000000000000001',
  };
}

function harness() {
  const ensureStage1 = vi.fn(async (_password: string) => ({
    ok: true as const,
    fleet_state: {
      fleet_agent_id: '888',
      fleet_safe_address: '0xBBBB000000000000000000000000000000000001',
      fleet_identity_registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      fleet_stage: 'stage1',
      chain: 'base-sepolia',
    },
    message: 'Stage 1 complete.',
  }));
  const publisherFactory = vi.fn((_args: PublisherFactoryArgs) => ({
    publish: vi.fn(async () => '0xtxpublish' as `0x${string}`),
    revoke: vi.fn(async () => '0xtxrevoke' as `0x${string}`),
  }));
  const reputationClientFactory = vi.fn((_args: ReputationClientFactoryArgs) => ({
    giveFeedback: vi.fn(async () => '0xtxfeedback' as `0x${string}`),
    respondToFeedback: vi.fn(async () => '0xtxrespond' as `0x${string}`),
    revokeFeedback: vi.fn(),
    readAllFeedback: vi.fn(),
    getSummary: vi.fn(),
    getClients: vi.fn(),
  }));
  const command = createSolverPluginsCommand({
    bootstrapperFactory: () => ({ ensureStage1 } as any),
    pinFileToIpfs: vi.fn(async () => 'bafyTarballCid'),
    publisherFactory,
    reputationClientFactory,
    pluginReaderFactory: () =>
      ({ listPluginPublications: vi.fn(async () => [pluginRow()]) }) as unknown as PluginPublicationReader,
    readConfigFile: () => ({}),
    writeConfigFile: () => {},
    now: () => 1_715_700_000_000,
  });
  return { command, ensureStage1, publisherFactory, reputationClientFactory };
}

type Signer = 'publisherFactory' | 'reputationClientFactory';

const CASES: Array<{ verb: string; args: () => string[]; signer: Signer }> = [
  { verb: 'publish', args: () => [`path:${withTempPlugin()}`], signer: 'publisherFactory' },
  { verb: 'revoke', args: () => [CID, '--reason', 'superseded'], signer: 'publisherFactory' },
  { verb: 'endorse', args: () => [CID], signer: 'reputationClientFactory' },
  { verb: 'warn', args: () => [CID, '--reason', 'flaky'], signer: 'reputationClientFactory' },
  { verb: 'block', args: () => [CID, '--reason', 'unsafe'], signer: 'reputationClientFactory' },
  { verb: 'review', args: () => [CID, '--score', '80'], signer: 'reputationClientFactory' },
  {
    verb: 'respond',
    args: () => [
      CID,
      '--feedback-index', '0',
      '--client', '0x00000000000000000000000000000000000000aa',
      '--response-uri', 'ipfs://bafyResponse',
    ],
    signer: 'reputationClientFactory',
  },
];

describe('jinn solver-plugins write verbs read --password-fd (#5391)', () => {
  it.each(CASES)('$verb uses the password from --password-fd, not JINN_PASSWORD', async ({ verb, args, signer }) => {
    const h = harness();
    const fd = openPasswordFd();
    const { ctx, writes, exits } = makeCtx(
      [verb, ...args(), '--config', withTempConfig(), '--password-fd', String(fd)],
      { JINN_PASSWORD: ENV_PASSWORD },
    );

    await h.command.run(ctx);

    expect(exits).toEqual([]);
    expect(parsedLine(writes).verb).toBe(`solver-plugins ${verb}`);
    expect(h.ensureStage1).toHaveBeenCalledWith(FD_PASSWORD);
    expect(h[signer]).toHaveBeenCalledOnce();
    expect(h[signer].mock.calls[0]![0].password).toBe(FD_PASSWORD);
  });
});
