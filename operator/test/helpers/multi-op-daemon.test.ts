import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons, type MultiOpHandle } from './multi-op-daemon';
import { allocateAnvilPort } from '@test/chain/port-allocator.js';

/**
 * Source of a tiny dummy node script that satisfies the multi-op helper's
 * spawn contract (binds a `/v1/bootstrap` route + emits the handshake-URL
 * line) without needing the real `dist/bin/jinn.js` to be built. Used by the
 * lifetime-log test: a real daemon spawn takes ~5-10s to bootstrap and emits
 * gobs of unrelated stdio, both of which make the log-content assertion
 * flaky; this dummy is deterministic and finishes in <1s.
 *
 * The script accepts the helper's `run --no-ui` arg pair (and ignores it)
 * because the helper spawns with `node <bin> run --no-ui`.
 */
const DUMMY_DAEMON_SOURCE = `
const http = require('node:http');
const port = Number(process.env.JINN_API_PORT);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
});
server.listen(port, '127.0.0.1', () => {
  // Lines the helper's handshake collector + lifetime log both observe.
  process.stdout.write('bootstrap-line on stdout\\n');
  process.stderr.write('bootstrap-line on stderr\\n');
  // Continue emitting AFTER bootstrap so the test can assert the log keeps
  // tracking the daemon's stdio past the handshake-collector detach point.
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    process.stdout.write('post-bootstrap stdout line ' + n + '\\n');
    process.stderr.write('post-bootstrap stderr line ' + n + '\\n');
  }, 50);
  // SIGTERM (from teardown) closes the server, clears the timer, and exits 0.
  const shutdown = () => {
    clearInterval(t);
    server.close(() => process.exit(0));
    // Hard backstop if close hangs (shouldn't, but tests run on CI).
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});
`;

const HANDSHAKE_THEN_FATAL_SOURCE = `
const port = Number(process.env.JINN_API_PORT);
process.stderr.write('[api] UI handshake URL: http://127.0.0.1:' + port + '/?k=test-token\\n');
setTimeout(() => {
  process.stderr.write('[main] Running fleet bootstrap...\\n');
  process.stdout.write('{"schemaVersion":1,"code":"fatal","exitCode":50,"message":"Existing mnemonic keystore could not be decrypted: Key derivation failed - possibly wrong passphrase"}\\n');
  process.exit(50);
}, 50);
`;

describe('spawnMultiOpDaemons', () => {
  let tmpRoot: string;
  let dummyBinPath: string;
  let opAHome: string;
  let opBHome: string;
  // Kernel-allocated, not hard-coded: these ports are bound for real by
  // spawned daemons, and vitest runs ~850 files across 3 forked workers that
  // share one 127.0.0.1 port space. Allocated in `beforeAll` because the same
  // values go into the seeded config files AND the `ops:` argument. Issue #1627.
  let opAPort: number;
  let opBPort: number;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-op-helper-'));
    dummyBinPath = path.join(tmpRoot, 'dummy-daemon.cjs');
    await fs.writeFile(dummyBinPath, DUMMY_DAEMON_SOURCE);
    opAPort = await allocateAnvilPort();
    opBPort = await allocateAnvilPort();
    opAHome = path.join(tmpRoot, 'op-a');
    opBHome = path.join(tmpRoot, 'op-b');
    await fs.mkdir(path.join(opAHome, '.jinn-client'), { recursive: true });
    await fs.mkdir(path.join(opBHome, '.jinn-client'), { recursive: true });
    // Seed minimal config so the daemon doesn't error out on missing fields.
    // (Real tests will use substrate-copy workspaces; this test just exercises the helper.)
    const minimalCfg = (port: number) => JSON.stringify({
      network: 'testnet',
      apiPort: port,
      rpcUrl: 'https://base-sepolia.example/dummy',
      pollIntervalMs: 5000,
    });
    await fs.writeFile(path.join(opAHome, '.jinn-client', 'config.json'), minimalCfg(opAPort));
    await fs.writeFile(path.join(opBHome, '.jinn-client', 'config.json'), minimalCfg(opBPort));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('spawns N daemons with distinct ports and returns handles', async () => {
    let handle: MultiOpHandle | undefined;
    try {
      handle = await spawnMultiOpDaemons({
        ops: [
          { name: 'op-a', home: opAHome, apiPort: opAPort },
          { name: 'op-b', home: opBHome, apiPort: opBPort },
        ],
        readyTimeoutMs: 30000,
        jinnBinPath: dummyBinPath,
      });
      expect(Object.keys(handle.daemons).sort()).toEqual(['op-a', 'op-b']);
      // The "distinct ports" half of this test's name, now actually asserted
      // rather than left implicit in two different literals.
      expect(opAPort).not.toBe(opBPort);
      // handshakeUrl may be present only if the daemon emits it; bootstrap-incomplete daemons may not.
      // The contract: each daemon has a pid and an apiPort — the helper propagates
      // each op's requested port onto its handle.
      expect(handle.daemons['op-a'].apiPort).toBe(opAPort);
      expect(handle.daemons['op-b'].apiPort).toBe(opBPort);
      expect(handle.daemons['op-a'].pid).toBeGreaterThan(0);
      expect(handle.daemons['op-b'].pid).toBeGreaterThan(0);
    } finally {
      if (handle) await handle.teardown();
    }
  }, 60000);

  it('teardown is idempotent', async () => {
    const handle = await spawnMultiOpDaemons({
      ops: [{ name: 'op-a', home: opAHome, apiPort: await allocateAnvilPort() }],
      readyTimeoutMs: 30000,
      jinnBinPath: dummyBinPath,
    });
    await handle.teardown();
    await expect(handle.teardown()).resolves.toBeUndefined();
  }, 60000);
});

/**
 * Lifetime-log coverage. Uses the dummy daemon script above so the test does
 * not depend on `dist/bin/jinn.js` being built — the `dist`-gated tests in
 * the suite above skip on a fresh checkout, which would silently drop our
 * coverage of the new logDir option in CI. The dummy script binds the
 * `/v1/bootstrap` route the helper polls and keeps emitting stdio after the
 * bootstrap window, which is the exact behaviour the lifetime log is
 * supposed to capture (the load-bearing assertion of this fix).
 */
describe('spawnMultiOpDaemons — lifetime log capture', () => {
  let tmpRoot: string;
  let dummyBinPath: string;
  let opAHome: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-op-logdir-'));
    dummyBinPath = path.join(tmpRoot, 'dummy-daemon.cjs');
    await fs.writeFile(dummyBinPath, DUMMY_DAEMON_SOURCE);
    opAHome = path.join(tmpRoot, 'op-a');
    await fs.mkdir(path.join(opAHome, '.jinn-client'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('streams stdout + stderr to the per-daemon log file for the full lifetime', async () => {
    const apiPort = await allocateAnvilPort();
    const logDir = path.join(tmpRoot, 'logs');
    const handle = await spawnMultiOpDaemons({
      ops: [{ name: 'op-a', home: opAHome, apiPort }],
      readyTimeoutMs: 10000,
      jinnBinPath: dummyBinPath,
      logDir,
    });

    // Contract: logPath is surfaced on the handle.
    const expectedLogPath = path.join(logDir, 'op-a-daemon.log');
    expect(handle.daemons['op-a'].logPath).toBe(expectedLogPath);
    await expect(fs.access(expectedLogPath)).resolves.toBeUndefined();

    // Wait long enough for several post-bootstrap stdio cycles to land.
    // The dummy emits every 50ms; 800ms is ~16 cycles — generous margin
    // against CI scheduler jitter without slowing the test.
    await new Promise((r) => setTimeout(r, 800));

    // Teardown flushes + closes the log stream.
    await handle.teardown();

    const content = await fs.readFile(expectedLogPath, 'utf-8');

    // Bootstrap output lands with the source-stream prefix the helper applies.
    expect(content).toContain('[out] bootstrap-line on stdout');
    expect(content).toContain('[err] bootstrap-line on stderr');

    // Post-bootstrap output lands too — this is the load-bearing assertion of
    // the fix: the old helper dropped these on the floor after bootstrap, so
    // a failure 5-23 min in had no stdio trail.
    expect(content).toContain('[out] post-bootstrap stdout line');
    expect(content).toContain('[err] post-bootstrap stderr line');

    // The header line includes spawn metadata so a debugger can identify the
    // run that produced the log.
    expect(content).toContain(`op-a daemon spawn`);

    // The exit footer is written by the proc.exit handler; it confirms the
    // stream stays open until the process actually exits (not just until the
    // bootstrap window closes).
    expect(content).toContain(`op-a daemon exit`);
  }, 30000);

  it('does not write a log file when logDir is omitted (back-compat)', async () => {
    const apiPort = await allocateAnvilPort();
    const handle = await spawnMultiOpDaemons({
      ops: [{ name: 'op-a', home: opAHome, apiPort }],
      readyTimeoutMs: 10000,
      jinnBinPath: dummyBinPath,
      // logDir intentionally omitted
    });
    try {
      // Contract: handle.logPath is null when no logDir was provided.
      expect(handle.daemons['op-a'].logPath).toBeNull();
    } finally {
      await handle.teardown();
    }
  }, 30000);

  it('keeps the fatal daemon envelope in the readiness error after handshake output', async () => {
    const apiPort = await allocateAnvilPort();
    const fatalBinPath = path.join(tmpRoot, 'fatal-after-handshake.cjs');
    await fs.writeFile(fatalBinPath, HANDSHAKE_THEN_FATAL_SOURCE);

    await expect(spawnMultiOpDaemons({
      ops: [{ name: 'op-a', home: opAHome, apiPort }],
      readyTimeoutMs: 5000,
      jinnBinPath: fatalBinPath,
    })).rejects.toThrow(/Existing mnemonic keystore could not be decrypted/);
  }, 30000);
});
