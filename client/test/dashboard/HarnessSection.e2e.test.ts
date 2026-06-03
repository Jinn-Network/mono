/**
 * Harness mode toggle e2e test: open Configuration, toggle harness mode from
 * train to frozen, save, and verify the API is called with the correct mode.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17333;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

const RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  steps: ['wallet'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC' },
  ],
  master_address: '0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF',
  chain: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  defaultRpcUrl: 'https://sepolia.base.org',
  harness: {
    mode: 'train',
  },
  solverNets: {
    prediction: {
      enabled: true,
      role: 'solving',
      harness: 'claude-code-learner',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn-prediction-plugin'],
    },
  },
};

const STATUS_PAYLOAD = {
  schemaVersion: 1,
  fleet: { services: [{ index: 1, step: 'complete', safeAddress: '0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC', agentId: 5474, safeBoundToAgent: true }] },
  predictionV1: {
    operator: {
      ok: true,
      enabled: true,
      role: 'solving',
      diagnostics: [],
      solverNet: { name: 'prediction', enabled: true },
      nextAction: { description: 'Waiting for Tasks. SolverNet active, Harness loaded.' },
    },
    totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
  },
  rewards: {},
  masterGas: { balanceWei: '0', runwayDaysExcess: '4' },
};

const SOLVERNETS_CATALOG = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nets: [
    {
      name: 'prediction',
      description: 'Forecast resolved outcomes; rewarded by Brier score on verified resolutions.',
      contract: { id: 'prediction', version: 'v1' },
      state: 'live',
      supportedRoles: ['solving', 'evaluating'],
      compatibleHarnesses: [{ name: 'claude-code-learner', version: '0.1.0', supportsRoles: ['solving', 'evaluating'] }],
      compatiblePlugins: [{ name: 'jinn-prediction-plugin', version: '0.1.0', source: 'bundled' }],
    },
  ],
};

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-harness-e2e-'));
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

  // Wait for /v1/bootstrap to be reachable
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

async function mockDaemonApi(page: Page): Promise<void> {
  await page.route(`**/v1/bootstrap`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(RUNNING_BOOTSTRAP) }),
  );
  await page.route(`**/v1/status`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(STATUS_PAYLOAD) }),
  );
  await page.route(`**/v1/solvernets`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(SOLVERNETS_CATALOG) }),
  );
  await page.route(`**/v1/setup/harness`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        restartRequired: true,
        mode: 'frozen',
      }),
    }),
  );
  // Suppress the auth handshake redirect
  await page.route(`**/auth/handshake**`, (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );
}

test('operator toggles harness mode from train to frozen and saves', async ({ page }) => {
  await mockDaemonApi(page);
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  await expect(page.getByText('jinn operator')).toBeVisible();

  // Navigate to Configuration.
  await page.getByRole('link', { name: /configuration/i }).click();
  await expect(page).toHaveURL(/\/configuration$/);

  // Harness section should be present and show "Train" as the initial mode.
  await expect(page.getByText(/harness/i).first()).toBeVisible();

  // Click the Frozen radio button.
  const frozenRadio = page.getByRole('radio', { name: /frozen/i });
  await frozenRadio.click();

  // Verify the radio is now checked.
  await expect(frozenRadio).toBeChecked();

  // Save the changes.
  await page.getByRole('button', { name: /save changes/i }).click();

  // Restart banner appears.
  await expect(page.getByText(/configuration saved/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /restart node/i })).toBeVisible();
});
