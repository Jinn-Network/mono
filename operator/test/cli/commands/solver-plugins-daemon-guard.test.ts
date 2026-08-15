/**
 * D0a P3 (#525/#562/#897) integration coverage: `PRODUCTION_DEPS.publisherFactory`
 * and `PRODUCTION_DEPS.reputationClientFactory`'s write paths sign with the
 * agent EOA via `createDirectSafeBroadcaster`, the same EOA a running daemon
 * broadcasts from with no cross-process lock. Both must refuse (not silently
 * proceed) when a live jinn daemon is detected for the target earning
 * directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRODUCTION_DEPS } from '../../../src/cli/commands/solver-plugins.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../../src/lifecycle/process-discovery.js';

describe('solver-plugins write factories -- daemon guard (#525/#562/#897)', () => {
  let tmp: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-solver-plugins-daemon-guard-'));
    writeFileSync(join(tmp, 'daemon.pid'), '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    __resetExecSyncForTesting();
    killSpy.mockRestore();
  });

  it('publisherFactory.publish refuses when a live daemon is detected', async () => {
    const publisher = PRODUCTION_DEPS.publisherFactory({
      identityRegistryAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      builderAgentId: 1n,
      safeAddress: '0xBBBB000000000000000000000000000000000001',
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base-sepolia',
      earningDir: tmp,
      password: 'test',
    });

    await expect(
      publisher.publish({
        pluginCid: 'bafyCid',
        payload: {
          version: 1,
          pluginName: 'x',
          pluginVersion: '1.0.0',
          pluginSha256: '0x0000000000000000000000000000000000000000000000000000000000000001',
          supports: [],
          publishedAt: 0,
        },
      }),
    ).rejects.toThrow(/987654/);
  });

  it('reputationClientFactory write client refuses when a live daemon is detected', async () => {
    const handle = PRODUCTION_DEPS.reputationClientFactory({
      reputationRegistryAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      safeAddress: '0xBBBB000000000000000000000000000000000001',
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'base-sepolia',
      earningDir: tmp,
      password: 'test',
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
    ).rejects.toThrow(/987654/);
  });
});
