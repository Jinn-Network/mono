import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons, type MultiOpHandle } from './multi-op-daemon';

describe('spawnMultiOpDaemons', () => {
  let tmpRoot: string;
  let opAHome: string;
  let opBHome: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-op-helper-'));
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
    await fs.writeFile(path.join(opAHome, '.jinn-client', 'config.json'), minimalCfg(7732));
    await fs.writeFile(path.join(opBHome, '.jinn-client', 'config.json'), minimalCfg(7733));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('spawns N daemons with distinct ports and returns handles', async () => {
    // NOTE: this test requires `yarn build` has been run (dist/bin/jinn.js exists).
    // If dist is missing, it should skip rather than fail.
    const distPath = path.resolve(__dirname, '..', '..', 'dist', 'bin', 'jinn.js');
    try { await fs.access(distPath); } catch {
      // dist not built; skip
      return;
    }

    let handle: MultiOpHandle | undefined;
    try {
      handle = await spawnMultiOpDaemons({
        ops: [
          { name: 'op-a', home: opAHome, apiPort: 7732 },
          { name: 'op-b', home: opBHome, apiPort: 7733 },
        ],
        readyTimeoutMs: 30000,
      });
      expect(Object.keys(handle.daemons).sort()).toEqual(['op-a', 'op-b']);
      // handshakeUrl may be present only if the daemon emits it; bootstrap-incomplete daemons may not.
      // The contract: each daemon has a pid and an apiPort.
      expect(handle.daemons['op-a'].apiPort).toBe(7732);
      expect(handle.daemons['op-b'].apiPort).toBe(7733);
      expect(handle.daemons['op-a'].pid).toBeGreaterThan(0);
      expect(handle.daemons['op-b'].pid).toBeGreaterThan(0);
    } finally {
      if (handle) await handle.teardown();
    }
  }, 60000);

  it('teardown is idempotent', async () => {
    const distPath = path.resolve(__dirname, '..', '..', 'dist', 'bin', 'jinn.js');
    try { await fs.access(distPath); } catch { return; }

    const handle = await spawnMultiOpDaemons({
      ops: [{ name: 'op-a', home: opAHome, apiPort: 7734 }],
      readyTimeoutMs: 30000,
    });
    await handle.teardown();
    await expect(handle.teardown()).resolves.toBeUndefined();
  }, 60000);
});
