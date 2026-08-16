/**
 * Wiring-regression coverage for the Stage 1 → Stage 2 funding-card transition
 * (jinn-mono-u34i).
 *
 * The bug: after the first faucet drip session lands on the Stage 1 gate,
 * the daemon spends the funds on the Stage 1 transfer and reports a new
 * (smaller) funding gap for Stage 2. The funding card's local
 * `dripStatus.targetReached` was sticky against the OLD target — so the
 * FUND FROM FAUCET button stayed in "FAUCET FUNDED" disabled state, and
 * the operator was stuck. They had to reload the panel to re-enable the
 * button, violating the never-leave-the-app principle.
 *
 * The fix: useEffect on `minimumWei` resets dripStatus when the daemon's
 * gate advances; if the operator has already opted into faucet help this
 * session, auto-fire requestDrip() so they don't even need to click again.
 *
 * This test mocks /v1/bootstrap with three sequential states:
 *   1. setup-mode + 0.015 ETH gate (Stage 1)
 *   2. setup-mode + 0.010 ETH gate (Stage 2, after Stage 1 drained master)
 *   3. running-mode (no more funding)
 *
 * Asserts the operator clicks FUND FROM FAUCET *once*, both drip POSTs fire
 * (the second one without any operator interaction), and the panel lands on
 * /overview — i.e. the auto-continue actually auto-continues.
 *
 * If anyone breaks the useEffect-on-minimumWei reset in AwaitingFundingCard,
 * the second drip POST never fires and this test fails.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PORT = 17333;
const MASTER_ADDR = '0x1111111111111111111111111111111111111111';

// Base Sepolia chain id = 84532 = 0x14a34. The daemon's testnet RPC
// preflight (operator/src/preflight/rpc-network.ts → checkRpcNetwork) calls
// eth_chainId and exits via emitEnvelope if the result mismatches or the
// endpoint is unreachable. CI doesn't have reliable egress to the default
// Tenderly gateway, so we stand up a loopback JSON-RPC stub that answers
// eth_chainId with 0x14a34 and point JINN_RPC_URL at it. Anything else the
// daemon happens to call before binding the API port gets a generic "method
// not found" — we don't model the chain, we just want the port bound so the
// SPA can be exercised with route mocks.
let rpcStub: Server | null = null;
let rpcStubUrl = '';

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

const SETUP_BOOTSTRAP_STAGE1 = {
  schemaVersion: 1,
  mode: 'setup',
  steps: ['wallet', 'fund', 'identity'],
  currentStep: 'awaiting_funding',
  services: [],
  master_address: MASTER_ADDR,
  chain: 'base-sepolia',
  funding: {
    master_address: MASTER_ADDR,
    eth_required: '15000000000000000', // 0.015 ETH (Stage 1 gate)
    eth_balance: '0',
    targetWei: '15000000000000000',
  },
};

const SETUP_BOOTSTRAP_STAGE2 = {
  ...SETUP_BOOTSTRAP_STAGE1,
  funding: {
    master_address: MASTER_ADDR,
    eth_required: '5000000000000000', // 0.005 ETH still needed
    eth_balance: '5000000000000000',
    targetWei: '10000000000000000', // 0.010 ETH (Stage 2 gate — different)
  },
};

const RUNNING_BOOTSTRAP = {
  schemaVersion: 1,
  mode: 'running',
  // #1041: the SPA gates the dashboard behind onboardingComplete (App.tsx). This
  // terminal running state must report it or the funding sequence never lands on
  // the operator dashboard (activity-card) it asserts.
  onboardingComplete: true,
  steps: ['wallet', 'fund', 'identity', 'service', 'mech'],
  currentStep: 'complete',
  services: [
    { index: 1, step: 'complete', safe_address: '0x2222222222222222222222222222222222222222' },
  ],
  master_address: MASTER_ADDR,
  chain: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  defaultRpcUrl: 'https://sepolia.base.org',
  solverNets: {},
};

const STATUS_PAYLOAD = {
  schemaVersion: 1,
  fleet: { services: [{ index: 1, step: 'complete', safeAddress: '0x2222222222222222222222222222222222222222', agentId: 5928, safeBoundToAgent: true }] },
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
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-funding-seq-e2e-'));
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error(`dist/bin/jinn.js missing — run \`yarn build\` first`);
  }

  // Loopback JSON-RPC stub for the testnet preflight + fleet-bootstrap reads.
  // Browser-side traffic is mocked by Playwright route.fulfill, but the daemon
  // process must stay alive (otherwise the SPA's /v1/bootstrap calls hit
  // ERR_CONNECTION_RESET). We park the daemon in `awaiting_funding` by
  // returning a zero balance for the master EOA, which is the state the test
  // exercises anyway.
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
      // Support batched JSON-RPC too.
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      const responses = requests.map((entry) => {
        const item = entry as { id?: number | string | null; method?: string } | null;
        const id = item?.id ?? null;
        const method = item?.method ?? '';
        return { jsonrpc: '2.0', id, result: stubResult(method) };
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

  // Relay daemon output to the test runner so the next startup failure isn't
  // a black box. Buffered onto stderr because Playwright surfaces it on
  // failure but suppresses it on pass.
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

/**
 * Install route mocks that walk Stage 1 → Stage 2 → running across calls.
 * Returns a counter so the test can assert how many drip POSTs fired.
 */
async function installSequentialMocks(page: Page): Promise<{ dripCalls: () => number }> {
  // Phase 1: Stage 1 funding gate. Advance to phase 2 after first drip.
  // Phase 2: Stage 2 funding gate. Advance to phase 3 after second drip.
  // Phase 3: running mode (panel transitions to /overview).
  let phase: 1 | 2 | 3 = 1;
  let dripCount = 0;

  await page.route('**/v1/bootstrap', (route) => {
    const body =
      phase === 1 ? SETUP_BOOTSTRAP_STAGE1 :
      phase === 2 ? SETUP_BOOTSTRAP_STAGE2 :
      RUNNING_BOOTSTRAP;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/v1/setup/drip', (route) => {
    dripCount += 1;
    if (dripCount === 1) {
      // Stage 1 gate cleared — daemon now exposes Stage 2's gate.
      phase = 2;
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          balanceWei: '15000000000000000',
          targetWei: '15000000000000000',
          attempts: 150,
          txHashes: ['0x' + 'aa'.repeat(32)],
          address: MASTER_ADDR,
        }),
      });
    } else if (dripCount === 2) {
      // Stage 2 gate cleared — bootstrap transitions to running.
      phase = 3;
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          balanceWei: '10000000000000000',
          targetWei: '10000000000000000',
          attempts: 50,
          txHashes: ['0x' + 'bb'.repeat(32)],
          address: MASTER_ADDR,
        }),
      });
    } else {
      // No more drips should fire after Stage 2 completes.
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, reason: 'no_more_drips_expected_in_test' }),
      });
    }
  });

  await page.route('**/v1/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(STATUS_PAYLOAD) }),
  );
  await page.route('**/v1/solvernets', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(SOLVERNETS_CATALOG) }),
  );
  await page.route('**/auth/handshake**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }),
  );

  return { dripCalls: () => dripCount };
}

test('AwaitingFundingCard auto-continues across Stage 1 → Stage 2 gate change (jinn-mono-u34i)', async ({ page }) => {
  const { dripCalls } = await installSequentialMocks(page);
  await page.goto(handshakeUrl ?? `http://127.0.0.1:${PORT}/`);

  // Phase 1: Stage 1 funding card is visible with the 0.015 ETH minimum.
  await expect(page.getByText(/fund the master eoa/i)).toBeVisible();
  await expect(page.getByText(/0\.015 ETH/i)).toBeVisible();

  // Operator's single act of agency in this test: one click.
  await page.getByRole('button', { name: /fund from faucet/i }).click();

  // Wait for the panel to land on the running dashboard. This proves that:
  //   1. The first drip POST landed (advancing bootstrap to phase 2).
  //   2. The useEffect on `minimumWei` reset dripStatus when the gate changed.
  //   3. The auto-continue (hasOptedInRef) fired requestDrip() a second time
  //      WITHOUT any operator interaction.
  //   4. The second drip POST landed (advancing bootstrap to phase 3 / running).
  //   5. The SPA navigated from <Onboarding/> to the running dashboard.
  await expect(page).toHaveURL(/\/overview$/, { timeout: 20_000 });
  // The aggregate "SOLUTIONS DELIVERED" counter is gone post-IA-reshuffle
  // (PR #449) — the running dashboard now leads with the Activity card.
  // Asserting against the card's stable testId keeps the regression
  // signal (we reached the running dashboard, not the onboarding takeover)
  // without depending on copy that the operator app no longer ships.
  await expect(page.getByTestId('activity-card')).toBeVisible();

  // Critical regression assertion: TWO drip POSTs must have fired.
  // Before the u34i fix, only the first click triggered a drip; the second
  // gate left the button stuck in "FAUCET FUNDED" disabled. dripCalls()
  // would be 1, and the page would never reach /overview within the timeout.
  expect(dripCalls()).toBe(2);
});
