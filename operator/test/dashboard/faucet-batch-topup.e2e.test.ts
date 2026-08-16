/**
 * Running-mode WalletCard batched-faucet top-up coverage (issue #560).
 *
 * The change: the "Top up from faucet (free)" button on the running-mode
 * Overview WalletCard now does a single batched drip up to a daily cap, and
 * the card surfaces the operator's remaining quota + cooldown reset. The
 * deterministic component/integration coverage lives in
 * `src/dashboard/spa/src/pages/{Overview,overview/WalletCard}.test.tsx`; this
 * Playwright walk closes the browser-layer gap the skill flags: it drives the
 * real rendered button against a mocked daemon API and asserts the exact
 * HTTP surface (`POST /v1/setup/drip?batch=true`) and the quota/cap copy the
 * operator actually sees.
 *
 * Three acceptance criteria from #560, all asserted here:
 *   AC1 — clicking Top up issues the BATCH drip (one action → up to cap), i.e.
 *         the outbound request carries `?batch=true` (NOT `?singleDrip=true`).
 *   AC2 — once the cap is reached the button is DISABLED until cooldown.
 *   AC3 — the card surfaces BOTH the remaining-today quota and the cooldown
 *         reset copy.
 *
 * Mocked-daemon pattern mirrors funding-sequence.e2e.test.ts: a loopback
 * JSON-RPC stub keeps the daemon process alive (so /v1/* doesn't ECONNRESET)
 * while Playwright route.fulfill mocks every endpoint the page touches,
 * including the new `/v1/setup/drip/quota`.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PORT = 17343;
const MASTER_ADDR = '0x1111111111111111111111111111111111111111';
const SAFE_ADDR = '0x2222222222222222222222222222222222222222';

let rpcStub: Server | null = null;
let rpcStubUrl = '';
let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

// Running-mode bootstrap. App.tsx gates the dashboard behind
// `mode === 'running' && onboardingComplete === true`; both must be present
// or the SPA shows the onboarding takeover and the WalletCard never mounts.
const RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  onboardingComplete: true,
  steps: ['wallet', 'fund', 'identity', 'service', 'mech'],
  currentStep: 'complete',
  services: [{ index: 1, step: 'complete', safe_address: SAFE_ADDR }],
  master_address: MASTER_ADDR,
  chain: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  defaultRpcUrl: 'https://sepolia.base.org',
  joinedSolverNets: {},
};

const STATUS_PAYLOAD = {
  schemaVersion: 1,
  fleet: {
    services: [
      { index: 1, step: 'complete', safeAddress: SAFE_ADDR, agentId: 5928, safeBoundToAgent: true },
    ],
  },
  predictionV1: {
    operator: {
      ok: true,
      enabled: false,
      diagnostics: [],
      solverNet: { name: 'prediction', enabled: false, roles: [] },
      nextAction: { description: 'Pick a SolverNet to join.' },
    },
    totals: { observedTasks: 0, activeTaskRuns: 0, solutions: 0, verdicts: 0, failed: 0 },
  },
  rewards: {},
  masterGas: { balanceWei: '9000000000000000', runwayDaysExcess: '1' },
};

const SOLVERNETS_CATALOG = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  nets: [],
};

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-faucet-batch-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
  }

  const stubResult = (method: string): unknown => {
    switch (method) {
      case 'eth_chainId': return '0x14a34'; // 84532 (Base Sepolia)
      case 'net_version': return '84532';
      case 'eth_blockNumber': return '0x1';
      case 'eth_getBalance': return '0x0';
      case 'eth_gasPrice': return '0x1';
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_getCode': return '0x';
      case 'eth_call': return '0x';
      case 'eth_estimateGas': return '0x5208';
      case 'eth_getBlockByNumber':
        return {
          number: '0x1',
          hash: `0x${'0'.repeat(64)}`,
          parentHash: `0x${'0'.repeat(64)}`,
          timestamp: '0x0',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          baseFeePerGas: '0x1',
          transactions: [],
        };
      default: return null;
    }
  };
  rpcStub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      let parsed: unknown = null;
      try { parsed = JSON.parse(body); } catch { /* fall through */ }
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      const responses = requests.map((entry) => {
        const item = entry as { id?: number | string | null; method?: string } | null;
        return { jsonrpc: '2.0', id: item?.id ?? null, result: stubResult(item?.method ?? '') };
      });
      res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
    });
  });
  await new Promise<void>((resolve) => rpcStub!.listen(0, '127.0.0.1', resolve));
  const addr = rpcStub.address() as AddressInfo;
  rpcStubUrl = `http://127.0.0.1:${addr.port}`;

  daemon = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(PORT),
      JINN_RPC_URL: rpcStubUrl,
      JINN_NETWORK: 'testnet',
      JINN_DISABLE_TESTNET_FAUCET: '1',
    },
    stdio: 'pipe',
  });

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf-8');
    process.stderr.write(`[daemon] ${text.replace(/\n(?!$)/g, '\n[daemon] ')}`);
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
  if (rpcStub) {
    await new Promise<void>((resolve) => rpcStub!.close(() => resolve()));
    rpcStub = null;
  }
});

/** Mocks the static endpoints every running-mode page touches. */
async function installBaseMocks(page: Page): Promise<void> {
  await page.route('**/v1/bootstrap', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(RUNNING_BOOTSTRAP) }),
  );
  await page.route('**/v1/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(STATUS_PAYLOAD) }),
  );
  await page.route('**/v1/solvernets', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(SOLVERNETS_CATALOG) }),
  );
  await page.route('**/auth/handshake**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );
}

test('AC1 + AC3: quota remaining is surfaced and Top up issues a batch drip (issue #560)', async ({ page }) => {
  await installBaseMocks(page);

  // Quota starts at 4-of-10 remaining, no cooldown. Capture every outbound
  // drip URL so we can assert the batch query param (AC1).
  const dripUrls: string[] = [];
  let callsRemaining = 4;

  await page.route('**/v1/setup/drip/quota', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        address: MASTER_ADDR,
        dailyCap: 10,
        callsRemaining,
        cooldownExpiresAt: null,
      }),
    }),
  );
  await page.route('**/v1/setup/drip*', (route) => {
    dripUrls.push(route.request().url());
    callsRemaining = 3; // one batch consumed → quota refetch reflects it
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        address: MASTER_ADDR,
        txHashes: ['0x' + 'ab'.repeat(32)],
        dailyCap: 10,
        callsRemaining: 3,
      }),
    });
  });

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // AC3 (remaining-quota half): the WalletCard surfaces today's remaining count.
  await expect(page.getByTestId('wallet-topup-quota')).toHaveText(/4 of 10 top-ups left today/i);

  const topup = page.getByTestId('wallet-topup');
  await expect(topup).toBeEnabled();
  await topup.click();

  // AC1: exactly one batch drip request fired, carrying ?batch=true and NOT
  // the legacy ?singleDrip=true.
  await expect.poll(() => dripUrls.length).toBe(1);
  expect(dripUrls[0]).toContain('batch=true');
  expect(dripUrls[0]).not.toContain('singleDrip=true');

  // Quota refetch after the batch reflects the consumed allowance.
  await expect(page.getByTestId('wallet-topup-quota')).toHaveText(/3 of 10 top-ups left today/i);
});

test('AC2 + AC3: cap reached disables the button and shows the cooldown reset (issue #560)', async ({ page }) => {
  await installBaseMocks(page);

  // Cap fully consumed: 0 remaining, cooldown ~12h out.
  const cooldownExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
  await page.route('**/v1/setup/drip/quota', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        address: MASTER_ADDR,
        dailyCap: 10,
        callsRemaining: 0,
        cooldownExpiresAt,
      }),
    }),
  );
  // If the button were (wrongly) clickable, a drip POST would arrive — assert
  // it never does.
  let dripFired = false;
  await page.route('**/v1/setup/drip*', (route) => {
    dripFired = true;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'topup_cooldown' }) });
  });

  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // AC2: button disabled once cap is reached.
  const topup = page.getByTestId('wallet-topup');
  await expect(topup).toBeDisabled();

  // AC3 (cooldown half): cap-reached copy + a resets-in cooldown hint.
  const quota = page.getByTestId('wallet-topup-quota');
  await expect(quota).toHaveText(/daily faucet cap reached/i);
  await expect(quota).toHaveText(/resets in/i);
  await expect(quota).toHaveText(/12 hours/i);

  // A disabled button cannot fire a drip even under a forced click.
  await topup.click({ force: true }).catch(() => { /* disabled → click is a no-op */ });
  await page.waitForTimeout(300);
  expect(dripFired).toBe(false);
});
