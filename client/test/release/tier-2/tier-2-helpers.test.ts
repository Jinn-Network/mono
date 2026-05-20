import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setupTier2Scenario } from './tier-2-helpers.js';

/**
 * Returns true when the Tier 2 prerequisites are all present:
 * Plan A's gold substrate, the BASE_SEPOLIA_RPC_URL env var, and the built
 * dist binary. Tests call this and `return` early (skip) when it is false.
 */
async function tier2PrereqsMet(): Promise<boolean> {
  // Plan A's substrate at ~/jinn-dev/operators/ (absent on fresh pre-Plan-A checkouts).
  const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
  try { await fs.access(goldOpA); } catch { return false; }
  // BASE_SEPOLIA_RPC_URL is a Tier 2 env requirement.
  if (!process.env['BASE_SEPOLIA_RPC_URL']) return false;
  // The dist binary must be built (avoids confusing process-not-found errors).
  const distPath = path.resolve(import.meta.dirname, '..', '..', '..', 'dist', 'bin', 'jinn.js');
  try { await fs.access(distPath); } catch { return false; }
  return true;
}

describe('setupTier2Scenario', () => {
  it('returns a handle with workspace, anvil, and two daemon URLs', async () => {
    if (!(await tier2PrereqsMet())) return;

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
    if (!(await tier2PrereqsMet())) return;

    const handle = await setupTier2Scenario({ scenarioId: 'T2.X-cleanup', portBase: 7742 });
    const workspaceRoot = handle.workspace.workspaceRoot;
    await handle.teardown();
    await expect(fs.access(workspaceRoot)).rejects.toThrow();
    // Idempotent
    await expect(handle.teardown()).resolves.toBeUndefined();
  }, 90000);
});
