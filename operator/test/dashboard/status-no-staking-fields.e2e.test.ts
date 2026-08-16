/**
 * Regression for #992 (supersedes the #773 eviction-banner window check):
 * /v1/status must NOT carry OLAS staking fields. OLAS staking is substrate;
 * operators never see it. This is a structural contract guard — if any staking
 * field reappears on the wire it fails loudly. The on-demand staking queue
 * lives behind `jinn rewards`, not /v1/status.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';
let uiToken = '';

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-status-shape-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
  }
  daemon = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(PORT),
      BASE_RPC_URL: 'http://127.0.0.1:65000',
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused' },
      });
      if (res.status === 200 || res.status === 401) {
        // The daemon writes the UI token (`ensureUiToken()`) before the API server
        // starts listening, so it's on disk by the time the server answers at all.
        // `/v1/status` is operator-class as of spec §14.5 (issue #2404) — read it
        // so the fetch below authenticates instead of getting a bare 401.
        uiToken = readFileSync(join(homeDir, '.jinn-client', 'ui-token'), 'utf-8').trim();
        return;
      }
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('daemon never came up on test port');
});

test.afterAll(async () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
});

test('/v1/status carries no OLAS staking fields (#992)', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/status`, {
    headers: { 'x-jinn-ui-token': uiToken },
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as {
    rewards: Record<string, unknown>;
  };
  expect(body.rewards).not.toHaveProperty('pendingStakingRewardsWei');
  expect(body.rewards).not.toHaveProperty('totalStakingRewardsWei');
  expect(body.rewards).not.toHaveProperty('pendingRewardsError');
  // Per-service staking-field absence (evicted / evictedSince) is not asserted
  // here: this daemon boots with a dead RPC and no funding, so `fleet.services`
  // is empty and the loop would be vacuous. It is covered against a populated
  // fleet by the assembleFleetV1 / assembleStatusV1 unit tests
  // (test/api/fleet-build.test.ts, test/api/status-build.test.ts).
});
