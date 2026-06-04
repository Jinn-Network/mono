// client/test/dashboard/multi-op/real-paired-smoke.e2e.test.ts
//
// Mode 2 (DR-2026-06-03, #1014): NON-GATING real paired app smoke. Two real
// testnet operators — op-a creates+launches a SolverNet, op-b discovers it in
// the catalog and joins. Real SPA + real testnet (NOT an Anvil fork — so no
// live-fork browser E2E enters any blocking gate).
//
// LOCAL-SPAWN model: rather than pointing at externally-hosted dashboards, this
// spawns two real daemons from warm-operator HOME trees (the same pre-staked
// state the environment-suite restores from `JINN_WARM_OPERATOR_STATE` /
// `_B_STATE`). Each daemon serves its own dashboard on a local port and prints a
// handshake URL — exactly the spawn pattern `spa.e2e.test.ts` uses for one
// operator, here for two. No external URLs, no hosting; it reuses secrets the
// env-suite already holds.
//
// Classified NON-GATING: it runs in the env-suite's `real-paired-smoke` job,
// which is `continue-on-error` and posts no check-run, so a flake/timeout can
// never block the cut. Self-skips when the two warm-operator HOME trees are
// absent (i.e. always, locally — this needs funded testnet operators), so it is
// a clean no-op everywhere except the provisioned CI environment.
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// CI sets these to the two restored warm-operator HOME dirs (each contains a
// `.jinn-client/` tree). op-a = launcher, op-b = joiner.
const OP_A_HOME = process.env.JINN_SMOKE_OP_A_HOME;
const OP_B_HOME = process.env.JINN_SMOKE_OP_B_HOME;

/**
 * A warm operator is one whose earning bootstrap has completed — its
 * `earning_state.json` exists under the restored `.jinn-client/` tree. We skip
 * unless BOTH operators look bootstrapped, so the test is a clean no-op anywhere
 * the warm state is absent (every local run, and any CI run before the secrets
 * are provisioned).
 */
function bootstrapped(home: string | undefined): boolean {
  if (!home) return false;
  return existsSync(join(home, '.jinn-client', 'earning', 'earning_state.json'));
}

const READY = bootstrapped(OP_A_HOME) && bootstrapped(OP_B_HOME);

interface Daemon {
  proc: ChildProcess;
  handshakeUrl: string;
  origin: string;
}

/**
 * Spawn a real `jinn run --no-ui` daemon rooted at `home` (so it resumes that
 * operator's warm state), serving its dashboard on `port`. Resolves once the
 * daemon has printed its handshake URL and `/v1/bootstrap` answers. Inherits the
 * ambient env (JINN_PASSWORD, BASE_SEPOLIA_RPC_URL, JINN_DISCOVERY_URL, etc.)
 * that CI provides for the warm operator.
 */
async function spawnDaemon(home: string, port: number): Promise<Daemon> {
  const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
  if (!existsSync(distBin)) {
    throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
  }
  const proc = spawn('node', [distBin, 'run', '--no-ui'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      JINN_API_PORT: String(port),
      JINN_NETWORK: 'testnet',
    },
    stdio: 'pipe',
  });

  let handshakeUrl = '';
  const capture = (chunk: Buffer) => {
    const m = /UI handshake URL:\s+(\S+)/.exec(chunk.toString('utf-8'));
    if (m && !handshakeUrl) handshakeUrl = m[1]!;
  };
  proc.stderr?.on('data', capture);
  proc.stdout?.on('data', capture);

  // The warm daemon resumes bootstrap + connects to real RPC at startup, so give
  // it a generous window. We need BOTH the handshake URL (for the auth cookie)
  // and a responding /v1/bootstrap before driving the SPA.
  for (let i = 0; i < 180; i++) {
    if (handshakeUrl) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/bootstrap`, {
          headers: { 'x-jinn-ui-token': 'unused-but-required' },
        });
        if (res.status === 200 || res.status === 401) break;
      } catch {
        // not yet
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!handshakeUrl) {
    throw new Error(`daemon (HOME=${home}, port=${port}) did not print a UI handshake URL within 180s`);
  }
  return { proc, handshakeUrl, origin: new URL(handshakeUrl).origin };
}

function stop(daemon: Daemon | null): void {
  if (daemon) daemon.proc.kill('SIGTERM');
}

test.describe('real paired app smoke (non-gating)', () => {
  test.skip(
    !READY,
    'JINN_SMOKE_OP_A_HOME / JINN_SMOKE_OP_B_HOME not set to bootstrapped warm operators — real paired smoke skipped',
  );

  test('op-a launches a SolverNet on real testnet; op-b discovers + joins it', async ({ browser }) => {
    // Two real daemons + on-chain launch confirmation + op-b catalog propagation
    // each cross several ~30s cadences; budget generously. Non-gating, so a
    // timeout is a neutral signal, never a blocked cut.
    test.setTimeout(15 * 60 * 1000);

    let opADaemon: Daemon | null = null;
    let opBDaemon: Daemon | null = null;
    const opACtx = await browser.newContext();
    const opBCtx = await browser.newContext();
    const opA = await opACtx.newPage();
    const opB = await opBCtx.newPage();

    try {
      opADaemon = await spawnDaemon(OP_A_HOME!, 17341);
      opBDaemon = await spawnDaemon(OP_B_HOME!, 17342);

      // ===== op-a: create + launch via the Launcher wizard =====
      await opA.goto(opADaemon.handshakeUrl);
      await opA.goto(`${opADaemon.origin}/launcher`);
      await opA.getByRole('link', { name: /create solvernet/i }).click();

      const solverNetName = `smoke-${Date.now()}`;
      // Step 1: Define
      await opA.getByLabel(/name/i).fill(solverNetName);
      await opA.getByLabel(/description/i).fill('Real paired smoke SolverNet');
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 2: Review Contract
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 3: Configure Generator
      await opA.getByLabel(/cadence/i).fill('60000');
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 4: Pricing (both inputs; validatePricing needs at least one > 0)
      await opA.getByTestId('launcher-create-solutionPriceWei').fill('100000000000000');
      await opA.getByTestId('launcher-create-verdictPriceWei').fill('50000000000000');
      await opA.getByRole('button', { name: /next/i }).click();
      // Step 5: Review + Launch
      await opA.getByRole('button', { name: /launch/i }).click();

      await expect(opA.getByText(/launched/i).first()).toBeVisible({ timeout: 180_000 });
      const manifestCid = (await opA.getByTestId('manifest-cid').textContent({ timeout: 15_000 }))?.trim();
      expect(manifestCid).toMatch(/^bafk?rei/);

      // ===== op-b: discover in the catalog + join =====
      await opB.goto(opBDaemon.handshakeUrl);

      // op-b's substrate refreshes its catalog on its own cadence; reload until
      // op-a's SolverNet appears (real cross-operator propagation via chain +
      // indexer — the leg that made T2.3 flaky, here non-gating by design).
      let found = false;
      for (let i = 0; i < 20 && !found; i++) {
        await opB.goto(`${opBDaemon.origin}/operator/registry`);
        const card = opB.locator(`[data-testid="registry-card"] [data-manifest-cid="${manifestCid}"]`);
        if (await card.count()) found = true;
        else await opB.waitForTimeout(15_000);
      }
      expect(found, "op-b should discover op-a's SolverNet in the catalog").toBe(true);

      const card = opB.getByTestId('registry-card').filter({
        has: opB.locator(`[data-manifest-cid="${manifestCid}"]`),
      });
      await card.first().getByTestId('registry-join-cta').click();
      await expect(opB.getByTestId('join-flow')).toBeVisible({ timeout: 30_000 });
      await opB.getByTestId('join-flow').getByLabel('Solver').check();
      await opB.getByTestId('join-flow-submit').click();
      await expect(opB.getByTestId('join-flow-success-card')).toBeVisible({ timeout: 60_000 });
    } finally {
      // Always capture screenshots for per-cut visibility (uploaded by CI). The
      // page content is captured, not the browser URL bar, so the `?k=` handshake
      // token is not in the image.
      await opA.screenshot({ path: 'test-results/smoke-op-a.png', fullPage: true }).catch(() => {});
      await opB.screenshot({ path: 'test-results/smoke-op-b.png', fullPage: true }).catch(() => {});
      await opACtx.close();
      await opBCtx.close();
      stop(opADaemon);
      stop(opBDaemon);
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});
