/**
 * Issue #2407 B1 — a halted, degraded daemon must still hold its
 * `daemon.pid`, so a concurrent CLI verb (`jinn withdraw` / `jinn bootstrap`
 * / `jinn fleet scale` / `jinn solver-plugins publish`) refuses via
 * `checkDaemonGuard` rather than racing the degraded recovery loops'
 * signer, and a second `jinn run` refuses to start a second degraded set.
 *
 * Regression: the pidfile-acquisition gate used to sit AFTER the entire
 * bootstrap retry loop (main.ts, right before Daemon construction), so for
 * the whole degrade-open window there was no `daemon.pid` on disk at all
 * and `checkDaemonGuard` reported `not-running`.
 *
 * This spawns the REAL built binary (mirrors
 * test/dashboard/funding-sequence.e2e.test.ts's technique, minus
 * Playwright — no browser needed here) against a loopback RPC stub that
 * always reports a zero master-EOA balance, with a short
 * JINN_FUNDING_TIMEOUT_MS so bootstrap actually reaches
 * SetupBootstrapHalted quickly instead of polling forever. Waits for the
 * persisted `bootstrap-error.json` (written exactly when the halt fires,
 * before the daemon logs anything else) as the halt signal, then asserts
 * `checkDaemonGuard` against the same earningDir reports `blocked: true`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDaemonGuard } from '../../src/cli/daemon-guard.js';

const PORT = 17398;

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

describe('#2407 B1 — checkDaemonGuard blocks while a degraded daemon is halted', () => {
  let daemon: ChildProcess | null = null;
  let rpcServer: Server | null = null;

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

  it('reports blocked: true (reason: alive) once the daemon has halted into a degraded, retry-waiting state', async () => {
    const distBin = join(process.cwd(), 'dist', 'bin', 'jinn.js');
    if (!existsSync(distBin)) {
      throw new Error('dist/bin/jinn.js missing — run `yarn build` first');
    }

    const rpc = await startRpcStub();
    rpcServer = rpc.server;

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

    daemon = spawn('node', [distBin, 'run'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        JINN_PASSWORD: 'test-password',
        JINN_API_PORT: String(PORT),
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
    expect(existsSync(bootstrapErrorPath)).toBe(true);

    // The pidfile write is #2407 B1's fix — assert it exists (proves the
    // hoist landed) before asserting the guard's derived verdict.
    expect(existsSync(join(earningDir, 'daemon.pid'))).toBe(true);

    const result = checkDaemonGuard({ earningDir, env: {} });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('alive');
  }, 40_000);
});
