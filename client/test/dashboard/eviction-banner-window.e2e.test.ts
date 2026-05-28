/**
 * Regression for issue #773: operator dashboard must not surface eviction
 * banner or `service_evicted` notification. Daemon EvictionLoop handles
 * auto-restake in-process; the SPA does not alarm the operator.
 *
 * Three `autoRestake` variants plus absent block — surfaces must stay hidden
 * in every case while `/v1/status` reports an evicted service.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi, DEFAULT_STATUS_PAYLOAD } from './helpers/mock-daemon-api';

const PORT = 17335;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-eviction-window-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error(`dist/bin/jinn.js missing — run \`yarn build\` first`);
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

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    const m = /UI handshake URL:\s+(\S+)/.exec(text);
    if (m && !handshakeUrl) handshakeUrl = m[1];
  };
  daemon.stderr?.on('data', onChunk);
  daemon.stdout?.on('data', onChunk);

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused' },
      });
      if (res.status === 200 || res.status === 401) return;
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

function buildEvictedStatus(opts: {
  evictedSinceMs: number;
  autoRestake: { enabled: boolean; checkIntervalMs: number } | undefined;
}): Record<string, unknown> {
  const { evictedSinceMs, autoRestake } = opts;
  return {
    ...DEFAULT_STATUS_PAYLOAD,
    fleet: {
      services: [
        {
          index: 1,
          step: 'complete',
          safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC',
          agentId: 5474,
          safeBoundToAgent: true,
          serviceId: 99,
          evicted: true,
          evictedSince: new Date(evictedSinceMs).toISOString(),
        },
      ],
    },
    masterGas: { balanceWei: '1000000000000000000', runwayDaysExcess: '7' },
    autoRestake,
  } as Record<string, unknown>;
}

async function installStatusMock(
  page: import('@playwright/test').Page,
  status: Record<string, unknown>,
): Promise<void> {
  await mockDaemonApi(page);
  await page.route(
    (url) => url.pathname === '/v1/status',
    (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(status),
      }),
  );
}

const scenarios: Array<{
  name: string;
  evictedSinceMs: number;
  autoRestake: { enabled: boolean; checkIntervalMs: number } | undefined;
}> = [
  {
    name: 'autoRestake within window',
    evictedSinceMs: Date.now() - 30_000,
    autoRestake: { enabled: true, checkIntervalMs: 60_000 },
  },
  {
    name: 'autoRestake past window',
    evictedSinceMs: Date.now() - 5 * 60_000,
    autoRestake: { enabled: true, checkIntervalMs: 60_000 },
  },
  {
    name: 'autoRestake disabled',
    evictedSinceMs: Date.now() - 1_000,
    autoRestake: { enabled: false, checkIntervalMs: 0 },
  },
  {
    name: 'autoRestake absent (older daemon)',
    evictedSinceMs: Date.now() - 1_000,
    autoRestake: undefined,
  },
];

for (const scenario of scenarios) {
  test(`never shows eviction surfaces — ${scenario.name} (#773)`, async ({ page }) => {
    const status = buildEvictedStatus({
      evictedSinceMs: scenario.evictedSinceMs,
      autoRestake: scenario.autoRestake,
    });
    await installStatusMock(page, status);
    await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('overview-eviction-banner')).toHaveCount(0);
    await expect(page.locator('[data-kind="service_evicted"]')).toHaveCount(0);
    await expect(page.getByText(/re-stake/i)).toHaveCount(0);
  });
}
