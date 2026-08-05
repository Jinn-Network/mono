import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 17331;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-spa-e2e-'));

  // Verify the dist bundle exists; if not, the test cannot run.
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
      // Use a non-functional RPC; in setup mode we don't actually call out.
      // Many checks gracefully degrade when RPC is unreachable.
      BASE_RPC_URL: 'http://127.0.0.1:65000',
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });

  // Capture stderr to extract the handshake URL the daemon prints.
  daemon.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    const m = /UI handshake URL:\s+(\S+)/.exec(text);
    if (m && !handshakeUrl) handshakeUrl = m[1];
  });
  daemon.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    const m = /UI handshake URL:\s+(\S+)/.exec(text);
    if (m && !handshakeUrl) handshakeUrl = m[1];
  });

  // Wait for /v1/bootstrap to come up (setup mode means it should be available
  // before bootstrap completes).
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused-but-required' },
      });
      // Either 200 (open) or 401 (gated — daemon's listening) is fine for "up"
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('daemon API did not come up within 30s');
});

test.afterAll(async () => {
  if (daemon) {
    daemon.kill('SIGTERM');
    // give it a beat to write final logs
    await new Promise((r) => setTimeout(r, 500));
  }
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('SPA loads at root with the onboarding flow', async ({ page }) => {
  // The test daemon stalls at awaiting_funding (RPC unreachable), so the SPA
  // should render the Onboarding view in Phase 2 (fund the wallet).
  const url = handshakeUrl ?? `http://127.0.0.1:${PORT}/`;
  await page.goto(url);
  await expect(page.getByText('Jinn · Onboarding')).toBeVisible({ timeout: 10_000 });
});

test('Onboarding renders the five-phase list', async ({ page }) => {
  // Onboarding shows the static hero ('Welcome to Jinn.') plus the five-row
  // phase list from `regions/onboarding/PhaseRow.tsx` PHASE_TITLES. The active
  // row depends on bootstrap progress against the unreachable test RPC, but
  // all five rows are always rendered (Onboarding.tsx maps [1..5] to PhaseRow
  // unconditionally).
  //
  // There is deliberately NO "Sign in to Claude" phase — harness auth moved
  // into phase 5 (`HarnessSelectStep`) and the unit test
  // `regions/Onboarding.test.tsx` ("does not render a Sign in to Claude
  // phase") pins its absence. Asserting for it here is what rotted this file
  // while it sat outside CI.
  const url = handshakeUrl ?? `http://127.0.0.1:${PORT}/`;
  await page.goto(url);
  await expect(page.getByText('Welcome to Jinn.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Provisioning your wallet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Fund your wallet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Joining Jinn')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Pick your first SolverNet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Set up harness + model')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Sign in to Claude', { exact: true })).toHaveCount(0);
});

test('GET /v1/bootstrap returns a setup-mode shape', async () => {
  // Direct API hit — needs the UI token.
  const tokenPath = join(homeDir, '.jinn-client', 'ui-token');
  if (!existsSync(tokenPath)) {
    test.skip(true, 'ui-token not yet written');
    return;
  }
  const { readFileSync } = await import('node:fs');
  const token = readFileSync(tokenPath, 'utf-8').trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
    headers: { 'x-jinn-ui-token': token },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { mode: string; steps: string[] };
  expect(['setup', 'uninitialized']).toContain(body.mode);
  expect(body.steps).toContain('awaiting_funding');
});

test('GET /v1/events/recent returns events array', async () => {
  const tokenPath = join(homeDir, '.jinn-client', 'ui-token');
  if (!existsSync(tokenPath)) {
    test.skip(true, 'ui-token not yet written');
    return;
  }
  const { readFileSync } = await import('node:fs');
  const token = readFileSync(tokenPath, 'utf-8').trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/events/recent`, {
    headers: { 'x-jinn-ui-token': token },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { events: unknown[] };
  expect(Array.isArray(body.events)).toBe(true);
});
