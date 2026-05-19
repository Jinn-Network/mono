import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setupTier2Scenario } from './tier-2-helpers.js';

describe('setupTier2Scenario', () => {
  it('returns a handle with workspace, anvil, and two daemon URLs', async () => {
    // This test requires Plan A's substrate to exist at ~/jinn-dev/operators/.
    // Skip if not present (e.g. fresh checkout pre-Plan-A).
    const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
    try { await fs.access(goldOpA); } catch { return; }
    // Skip if BASE_SEPOLIA_RPC_URL is not configured (Tier 2 env requirement).
    if (!process.env['BASE_SEPOLIA_RPC_URL']) return;

    let handle: Awaited<ReturnType<typeof setupTier2Scenario>> | undefined;
    try {
      handle = await setupTier2Scenario({
        scenarioId: 'T2.X-test',
        portBase: 7740,
      });
      expect(handle.workspace.opPaths['op-a']).toContain('op-a');
      expect(handle.workspace.opPaths['op-b']).toContain('op-b');
      expect(handle.anvilRpcUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.daemons.daemons['op-a'].apiPort).toBe(7740);
      expect(handle.daemons.daemons['op-b'].apiPort).toBe(7741);
    } finally {
      if (handle) await handle.teardown();
    }
  }, 90000);

  it('teardown is idempotent and cleans up workspace + anvil + daemons', async () => {
    const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
    try { await fs.access(goldOpA); } catch { return; }
    // Skip if BASE_SEPOLIA_RPC_URL is not configured (Tier 2 env requirement).
    if (!process.env['BASE_SEPOLIA_RPC_URL']) return;

    const handle = await setupTier2Scenario({ scenarioId: 'T2.X-cleanup', portBase: 7742 });
    const workspaceRoot = handle.workspace.workspaceRoot;
    await handle.teardown();
    await expect(fs.access(workspaceRoot)).rejects.toThrow();
    // Idempotent
    await expect(handle.teardown()).resolves.toBeUndefined();
  }, 90000);
});
