/**
 * Issue #2407 B1/R2 — a halted, degraded daemon must still hold its
 * `daemon.pid`, so a concurrent CLI verb (`jinn withdraw` / `jinn bootstrap`
 * / `jinn fleet scale` / `jinn solver-plugins publish`) refuses via
 * `checkDaemonGuard` rather than racing the degraded recovery loops'
 * signer, and a second `jinn run` refuses to start a second degraded set;
 * and a SIGTERM/SIGINT delivered during that same window must still clean
 * up the pidfile rather than leaving a stale one behind (on a normal host
 * this self-heals via ESRCH, but in a container the daemon is PID 1 and
 * `checkDaemonGuard` deliberately treats pid-1 as BLOCKING — every CLI verb
 * would refuse until a daemon rewrites the file).
 *
 * Regression (B1): the pidfile-acquisition gate used to sit AFTER the
 * entire bootstrap retry loop (main.ts, right before Daemon construction),
 * so for the whole degrade-open window there was no `daemon.pid` on disk
 * at all and `checkDaemonGuard` reported `not-running`.
 *
 * Regression (R2): before the full `Daemon`'s own graceful SIGINT/SIGTERM
 * handlers exist (they install only after Daemon construction, well after
 * bootstrap resolves), Node's default signal disposition terminates the
 * process WITHOUT running the `process.on('exit', removePidfile)` hook —
 * `exit` doesn't fire for a signal-terminated process the way it does for
 * a clean one.
 *
 * `.e2e.test.ts` (not `.test.ts`): this spawns the REAL built binary
 * (mirrors test/dashboard/funding-sequence.e2e.test.ts's technique, minus
 * Playwright — no browser needed here), so it needs `dist/bin/jinn.js` to
 * exist. `vitest.config.ts`'s exclude list only auto-excludes
 * `*.e2e.test.ts` from the default `yarn test` glob (see its T1.2 comment
 * for the precedent) — CI's `check` job runs `yarn test` BEFORE `yarn
 * build`, so a plain `.test.ts` here would throw on every clean checkout.
 * Run via `yarn e2e:degraded-daemon-guard` (builds first), wired into its
 * own CI job alongside `funding-sequence-e2e`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkDaemonGuard } from '../../src/cli/daemon-guard.js';

let nextPort = 17398;

function stubResult(method: string): unknown {
  switch (method) {
    case 'eth_chainId': return '0x14a34'; // 84532 (Base Sepolia)
    case 'net_version': return '84532';
    case 'eth_blockNumber': return '0x1';
    case 'eth_getBalance': return '0x0'; // master EOA never appears funded
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
}

function startRpcStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
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
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/**
 * Spawns the real daemon against a loopback RPC stub that never reports a
 * funded master EOA, with a short JINN_FUNDING_TIMEOUT_MS so bootstrap
 * actually reaches SetupBootstrapHalted quickly instead of polling forever.
 * Waits for the persisted `bootstrap-error.json` (written exactly when the
 * halt fires, before the daemon logs anything else) as the halt signal.
 * Returns once the daemon is confirmed halted and degraded.
 */
async function spawnHaltedDegradedDaemon(): Promise<{
  daemon: ChildProcess;
  rpcServer: Server;
  earningDir: string;
}> {
  const rpc = await startRpcStub();
  const port = nextPort++;

  const homeDir = mkdtempSync(join(tmpdir(), 'jinn-degraded-guard-'));
  const earningDir = join(homeDir, '.jinn-client', 'earning');
  const bootstrapErrorPath = join(earningDir, 'bootstrap-error.json');

  // Pre-write the first-launch UI-opened marker so the daemon doesn't try
  // to auto-open a browser (no `--no-ui`/JINN_NO_UI here — that flag also
  // disables the halt-and-resume loop itself, per
  // setup/halt-mode.ts's keepSetupUiOnBootstrapError, which would make the
  // daemon exit(10) immediately on the halt instead of staying alive in
  // the degraded window this test needs to observe).
  mkdirSync(earningDir, { recursive: true });
  writeFileSync(join(earningDir, '.ui-opened'), new Date().toISOString() + '\n');

  const daemon = spawn('node', [join(process.cwd(), 'dist', 'bin', 'jinn.js'), 'run'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      JINN_PASSWORD: 'test-password',
      JINN_API_PORT: String(port),
      JINN_RPC_URL: rpc.url,
      JINN_NETWORK: 'testnet',
      JINN_FUNDING_TIMEOUT_MS: '500',
      JINN_FUNDING_POLL_INTERVAL_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  daemon.on('exit', (code, signal) => { exitInfo = { code, signal }; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !existsSync(bootstrapErrorPath)) {
    if (exitInfo) {
      throw new Error(`daemon exited before halting (code=${exitInfo.code} signal=${exitInfo.signal})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(bootstrapErrorPath)) {
    throw new Error('daemon never reached SetupBootstrapHalted within 30s');
  }

  return { daemon, rpcServer: rpc.server, earningDir };
}

describe('#2407 B1/R2 — pidfile lifecycle across a degraded, halted daemon', () => {
  let daemon: ChildProcess | null = null;
  let rpcServer: Server | null = null;

  beforeAll(() => {
    const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
    if (!existsSync(distBin)) {
      throw new Error('dist/bin/jinn.js missing — run `yarn build` first (this suite runs via yarn e2e:degraded-daemon-guard, which does)');
    }
  });

  afterEach(async () => {
    if (daemon && !daemon.killed) {
      daemon.kill('SIGKILL');
    }
    daemon = null;
    if (rpcServer) {
      await new Promise<void>((resolve) => rpcServer!.close(() => resolve()));
      rpcServer = null;
    }
  });

  it('B1: reports blocked: true (reason: alive) once the daemon has halted into a degraded, retry-waiting state', async () => {
    const spawned = await spawnHaltedDegradedDaemon();
    daemon = spawned.daemon;
    rpcServer = spawned.rpcServer;

    // The pidfile write is #2407 B1's fix — assert it exists (proves the
    // hoist landed) before asserting the guard's derived verdict.
    expect(existsSync(join(spawned.earningDir, 'daemon.pid'))).toBe(true);

    const result = checkDaemonGuard({ earningDir: spawned.earningDir, env: {} });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('alive');
  }, 40_000);

  it('R2: SIGTERM during the degraded window removes the pidfile rather than leaving it stale', async () => {
    const spawned = await spawnHaltedDegradedDaemon();
    daemon = spawned.daemon;
    rpcServer = spawned.rpcServer;
    const pidPath = join(spawned.earningDir, 'daemon.pid');
    expect(existsSync(pidPath)).toBe(true);

    daemon.kill('SIGTERM');

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && existsSync(pidPath)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(pidPath)).toBe(false);
  }, 40_000);

  // R3: `jinn run --no-daemon` (JINN_NO_DAEMON=1) now acquires the pidfile
  // too, since B1 hoisted acquisition to before the bootstrap retry loop —
  // --no-daemon's own exit paths (both the "bootstrap complete" success
  // summary and, exercised here, the fatal-exit-on-halt path via
  // setup/halt-mode.ts's keepSetupUiOnBootstrapError) sit AFTER that hoist.
  // Both call `process.exit(N)`, which fires the `'exit'` event Node
  // guarantees for both a clean return AND an explicit `process.exit()`
  // call (distinct from R2's signal-termination case, where `'exit'`
  // does NOT fire) — so `removePidfile` (registered via
  // `process.on('exit', removePidfile)` right after the pidfile write)
  // should run either way.
  //
  // This test exercises the fatal-exit flavor (JINN_NO_DAEMON=1 makes
  // keepSetupUiOnBootstrapError() false, so the very first funding halt
  // triggers an immediate emitEnvelope-driven process.exit(10) instead of
  // entering the retry-and-wait loop) rather than the success flavor
  // (bootstrap actually completing, then exiting 0 with a summary) — both
  // share the identical pidPath/removePidfile/process.on('exit', ...)
  // mechanism this test proves works, but reaching genuine bootstrap
  // completion needs the same Anvil-fork-plus-real-contracts
  // infrastructure as this repo's existing `yarn staking`/`yarn e2e`
  // heavy validation scripts (test/e2e/staking.ts) — deliberately kept
  // out of the fast `*.e2e.test.ts` tier per this repo's testing
  // taxonomy (docs/runbooks/testing.md).
  it('R3: JINN_NO_DAEMON=1 acquires the pidfile and removes it on its own clean exit', async () => {
    const rpc = await startRpcStub();
    rpcServer = rpc.server;
    const port = nextPort++;

    const homeDir = mkdtempSync(join(tmpdir(), 'jinn-no-daemon-guard-'));
    const earningDir = join(homeDir, '.jinn-client', 'earning');
    const pidPath = join(earningDir, 'daemon.pid');
    mkdirSync(earningDir, { recursive: true });
    writeFileSync(join(earningDir, '.ui-opened'), new Date().toISOString() + '\n');

    daemon = spawn('node', [join(process.cwd(), 'dist', 'bin', 'jinn.js'), 'run'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        JINN_PASSWORD: 'test-password',
        JINN_API_PORT: String(port),
        JINN_RPC_URL: rpc.url,
        JINN_NETWORK: 'testnet',
        JINN_NO_DAEMON: '1',
        // No JINN_FUNDING_TIMEOUT_MS override: keepSetupUiOnBootstrapError()
        // is false under JINN_NO_DAEMON=1, so the FIRST funding_required
        // failBootstrap call inside the internal poll loop's timeout check
        // triggers the exit. bootstrap-run.ts's between-poll sleep
        // (FUNDING_POLL_INTERVAL_MS) is a HARDCODED 15s, independent of this
        // value — the elapsed check runs BEFORE that sleep on each
        // iteration, so whether the halt fires on the first check (if
        // ensureStage1And2's own real work already took longer than this
        // timeout) or only after one full 15s sleep (if it resolved
        // faster) is a pre-existing timing race in bootstrap-run.ts, not
        // something this test controls — the wait budget below covers the
        // worst case rather than assuming the fast path.
        JINN_FUNDING_TIMEOUT_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let sawPidfile = false;
    const observeDeadline = Date.now() + 5_000;
    let exited = false;
    daemon.on('exit', () => { exited = true; });
    while (Date.now() < observeDeadline && !exited) {
      if (existsSync(pidPath)) { sawPidfile = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sawPidfile).toBe(true);

    // Worst case per the comment above: ~15s (the hardcoded between-poll
    // sleep) plus real processing overhead — budget well past that rather
    // than the fast-path minimum.
    const exitDeadline = Date.now() + 30_000;
    while (Date.now() < exitDeadline && !exited) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(exited).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
  }, 45_000);
});
