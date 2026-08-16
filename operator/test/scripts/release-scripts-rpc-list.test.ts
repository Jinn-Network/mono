/**
 * Smoke test for the CI/release-script RPC-list contract (issue #592 AC5).
 *
 * The .github/workflows/npm-publish.yml workflow passes its
 * BASE_SEPOLIA_RPC_URL secret (which may be a comma-separated list of
 * providers) through to `operator/scripts/release/run-tier-{1,2,3}.ts` and
 * `operator/test/e2e/daemon-harness-cycle.ts` via the environment. Those
 * scripts consume `loadConfig()` rather than reading the env var directly,
 * so the AC5 contract is whatever `loadConfig()` does with a comma-string.
 *
 * This test proves the wiring without re-running the scripts themselves.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';

describe('release-script RPC list wiring (AC5)', () => {
  const original = {
    BASE_RPC_URL: process.env['BASE_RPC_URL'],
    BASE_SEPOLIA_RPC_URL: process.env['BASE_SEPOLIA_RPC_URL'],
    JINN_RPC_URL: process.env['JINN_RPC_URL'],
    JINN_NETWORK: process.env['JINN_NETWORK'],
  };

  const dirs: string[] = [];

  afterEach(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('a comma-separated BASE_SEPOLIA_RPC_URL flows into config.rpcUrls', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-ci-rpc-list-'));
    dirs.push(dir);

    process.env['JINN_NETWORK'] = 'testnet';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://primary.example,https://backup.example';
    delete process.env['BASE_RPC_URL'];
    delete process.env['JINN_RPC_URL'];

    // Force loadConfig to skip the default config file by pointing at a
    // throwaway path. Passing an explicit config path that doesn't exist is
    // an error, so we drop a tiny json that just sets network=testnet.
    const configPath = path.join(dir, 'config.json');
    await (await import('node:fs/promises')).writeFile(
      configPath,
      JSON.stringify({ network: 'testnet' }),
    );

    const config = loadConfig(configPath);

    expect(config.rpcUrls.length).toBe(2);
    expect(config.rpcUrls[0]).toBe('https://primary.example');
    expect(config.rpcUrls[1]).toBe('https://backup.example');
  });
});
