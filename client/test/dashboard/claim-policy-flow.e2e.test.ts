// client/test/dashboard/claim-policy-flow.e2e.test.ts
//
// Mutation-asserting replacement for the `e2e:app-flow` gate (DR-2026-08-05
// decision 5). The one-swap retirement wave deletes the SolverNet-lifecycle
// + join surfaces that `solvernet-flow.e2e.test.ts` / `join.e2e.test.ts`
// drove, so this spec re-homes the gate's invariant — "the SPA can drive a
// mutation end-to-end through the daemon API and observe the result" — onto
// the surviving claim authority: the control-plane claim-policy /
// execution-wiring routes (headless §4.2, "the post-stage-1 claim
// authority").
//
// Approach mirrors join.e2e.test.ts: a real daemon serves the SPA bundle +
// auth handshake, and every /v1/* data call is intercepted at the
// page.route() boundary. The GET seeds the ClaimPolicyTab; the PUT is
// RECORDED so the test can assert the exact mutation body the SPA sent — the
// control-plane equivalent of solvernet-flow's `observedLifecycleRequests`
// assertion. Execution wiring renders read-only on the same page (no mutating
// route exists for it — §4.2), so its rows are asserted as a read companion.
import { test, expect, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockDaemonApi } from './helpers/mock-daemon-api.js';

const PORT = 17340;

let daemon: ChildProcess | null = null;
let homeDir = '';
let handshakeUrl: string | null = null;

interface ObservedClaimPolicyPut {
  method: string;
  body: {
    claimPolicy?: { mode?: string; spendCapWei?: string; aiUnitCap?: number };
  };
}

test.beforeAll(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'jinn-claim-policy-e2e-'));
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
  const capture = (chunk: Buffer): void => {
    const m = /UI handshake URL:\s+(\S+)/.exec(chunk.toString('utf-8'));
    if (m && !handshakeUrl) handshakeUrl = m[1];
  };
  daemon.stderr?.on('data', capture);
  daemon.stdout?.on('data', capture);

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/bootstrap`, {
        headers: { 'x-jinn-ui-token': 'unused-but-required' },
      });
      // Finish only once BOTH the API answers and the handshake URL is
      // captured (the daemon may serve /v1/bootstrap a beat before it flushes
      // the handshake line — returning early would leave handshakeUrl null).
      if (handshakeUrl && (res.status === 200 || res.status === 401)) return;
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
    await new Promise((r) => setTimeout(r, 500));
    if (!daemon.killed) daemon.kill('SIGKILL');
  }
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test('Claim policy: operator edits caps and Save drives a PUT /v1/operator/claim-policy mutation that takes effect', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await mockDaemonApi(page);

  const observedPuts: ObservedClaimPolicyPut[] = [];

  // Per-test overrides registered AFTER mockDaemonApi so they win (Playwright
  // checks routes last-registered-first). The shared helper's `/v1/operator/`
  // catch-all returns `{ ok: true }`, which is NOT a valid ClaimPolicyResponse,
  // so the GET override below is mandatory for the tab to render its editor.
  await page.route(
    (url) => url.pathname === '/v1/operator/claim-policy',
    async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT') {
        const body = (req.postDataJSON?.() ?? {}) as ObservedClaimPolicyPut['body'];
        observedPuts.push({ method: req.method(), body });
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ restartRequired: true }),
        });
      }
      // GET — seed the editor with a known mode + read-only execution wiring,
      // caps intentionally absent (the safe default posture).
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          claimPolicy: { mode: 'every-runnable' },
          executionWiring: [
            {
              workKind: 'prediction.v1',
              harness: 'claude-code-learner',
              model: 'claude-haiku-4-5-20251001',
              plugins: ['jinn-prediction-plugin'],
              credentialRef: 'default',
              isolationPolicy: 'worktree',
            },
          ],
          restartRequired: false,
        }),
      });
    },
  );

  if (!handshakeUrl) throw new Error('daemon did not print a UI handshake URL');
  await page.goto(handshakeUrl);
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/operator/claim-policy`);

  const tab = page.getByTestId('claim-policy-tab');
  await expect(tab).toBeVisible({ timeout: 15_000 });

  // Read side: the seeded mode + the execution-wiring row render from the GET.
  await expect(page.getByTestId('claim-policy-mode')).toHaveText('every-runnable');
  await expect(page.getByTestId('execution-wiring-row')).toHaveCount(1);
  await expect(page.getByTestId('execution-wiring-row')).toContainText('prediction.v1');

  // Drive the mutation: edit both caps, then Save.
  await page.getByTestId('claim-policy-spend-cap').fill('250000000000000');
  await page.getByTestId('claim-policy-ai-unit-cap').fill('7');
  await page.getByTestId('claim-policy-save').click();

  // Observe the result: the SPA reflects the restart-pending state the PUT
  // returned.
  await expect(page.getByTestId('claim-policy-restart-required')).toBeVisible({
    timeout: 15_000,
  });

  // Daemon-side assertion: exactly one claim-policy mutation fired, carrying
  // the edited caps and the seeded mode. This is the gate's core invariant —
  // a real mutation reached the daemon API through the SPA.
  expect(observedPuts).toEqual([
    {
      method: 'PUT',
      body: {
        claimPolicy: {
          mode: 'every-runnable',
          spendCapWei: '250000000000000',
          aiUnitCap: 7,
        },
      },
    },
  ]);
});
