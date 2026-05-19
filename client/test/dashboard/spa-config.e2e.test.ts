/**
 * Page-split happy-path: navigate Overview → Operator, swap a
 * SolverNet's role, save, see the restart banner.
 *
 * The existing setup-mode harness in spa.e2e.test.ts spawns a real daemon
 * that serves the SPA bundle from dist/dashboard. This test mocks the
 * daemon's API responses at the page level (Playwright route interception)
 * so the SPA renders running-mode without needing a live bootstrapped
 * fleet. It exercises the SPA wiring, not the daemon's bootstrap.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi } from './helpers/mock-daemon-api';

const PORT = 17332;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;


test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-spa-config-e2e-'));
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

  // Wait for /v1/bootstrap to be reachable (we'll mock it once the page loads).
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


test('operator opens Operator tab, enables Evaluator role alongside Solver, sees restart banner', async ({ page }) => {
  await mockDaemonApi(page);
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  await expect(page.getByText('jinn operator')).toBeVisible();

  // Top tab nav lands us on Operator, where activity and configuration live.
  await page.getByRole('link', { name: /^operator$/i }).click();
  await expect(page).toHaveURL(/\/operator$/);
  await expect(page.getByText(/solvernets/i).first()).toBeVisible();

  // Open the prediction net body (toggle is on by default per the mocked
  // bootstrap), then check the Evaluator box (Solver stays checked) and Save.
  await expect(page.getByText('prediction').first()).toBeVisible();
  await page.getByLabel('Evaluator').check();
  await page.getByRole('button', { name: /save changes/i }).click();

  // Restart banner appears across both tabs.
  await expect(page.getByText(/operator settings saved/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /restart node/i })).toBeVisible();
});
