import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi } from '../helpers/mock-daemon-api';
import { ROUTES, expandRoutePath } from '../../../src/dashboard/spa/src/routes';

const PORT = 27332;
let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

// Patterns the SPA may legitimately emit as console.error during isolated route
// loads (e.g. ResizeObserver loop completed). Add entries only after confirming
// the error is genuinely benign in isolation.
const HARMLESS_CONSOLE_ERROR_PATTERNS: RegExp[] = [
  /ResizeObserver loop completed/i,
];

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-T1.4-route-smoke-'));
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

  // Wait for /v1/bootstrap to be reachable (mocked once page loads).
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

async function landOnSpaHome(page: Page): Promise<string> {
  // Use the handshake URL when emitted (sets the UI auth cookie); fall back to
  // root-with-token-header otherwise.
  await mockDaemonApi(page);
  const url = handshakeUrl ?? `http://127.0.0.1:${PORT}/`;
  await page.goto(url);
  return `http://127.0.0.1:${PORT}`;
}

test.describe('T1.4 — SPA route smoke', () => {
  for (const route of ROUTES) {
    test(`renders clean at ${route.label}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: Error[] = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => pageErrors.push(err));

      const base = await landOnSpaHome(page);
      const targetUrl = `${base}${expandRoutePath(route)}`;
      await page.goto(targetUrl);

      // Wait for *something* rendered. Tolerant: any of these means painted.
      await page.waitForSelector(
        'main, [data-page-loaded], [data-app-shell], [data-error-boundary], h1',
        { timeout: 5000 },
      );

      expect(pageErrors, `pageerror events at ${route.label}`).toHaveLength(0);

      const boundaryCount = await page.locator('[data-error-boundary]').count();
      expect(boundaryCount, `error boundary at ${route.label}`).toBe(0);

      const real = consoleErrors.filter(
        (err) => !HARMLESS_CONSOLE_ERROR_PATTERNS.some((re) => re.test(err)),
      );
      expect(real, `console errors at ${route.label}`).toEqual([]);
    });
  }
});
