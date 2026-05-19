import { baseSepolia } from 'viem/chains';
import { copyWorkspace, type WorkspaceHandle } from '../../../scripts/release/substrate-copy.js';
import { spawnAnvilFork, type AnvilHarness } from '../../_support/chain/anvil.js';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon.js';

export interface Tier2SetupOptions {
  scenarioId: string;                  // for run-id and debugging
  portBase: number;                    // op-a gets portBase, op-b gets portBase+1
  extraEnv?: NodeJS.ProcessEnv;        // additional env per daemon (e.g. JINN_HARNESS_STUB_INSTANCE)
  ops?: string[];                      // default: ['op-a', 'op-b']
}

export interface Tier2Handle {
  workspace: WorkspaceHandle;
  anvil: AnvilHarness;
  anvilRpcUrl: string;
  daemons: MultiOpHandle;
  teardown: () => Promise<void>;
}

export async function setupTier2Scenario(opts: Tier2SetupOptions): Promise<Tier2Handle> {
  const ops = opts.ops ?? ['op-a', 'op-b'];
  if (ops.length < 1 || ops.length > 3) {
    throw new Error(`setupTier2Scenario expects 1-3 ops, got ${ops.length}`);
  }

  let workspace: WorkspaceHandle | null = null;
  let anvil: AnvilHarness | null = null;
  let daemons: MultiOpHandle | null = null;

  const cleanup = async () => {
    if (daemons) { try { await daemons.teardown(); } catch {} }
    if (anvil) { try { await anvil.teardown(); } catch {} }
    if (workspace) { try { await workspace.teardown(); } catch {} }
  };

  try {
    // 1. Substrate workspace copy
    workspace = await copyWorkspace({
      ops,
      runId: `${opts.scenarioId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });

    // 2. Anvil fork of Base Sepolia (one per scenario)
    const forkUrl = process.env['BASE_SEPOLIA_RPC_URL'];
    if (!forkUrl) {
      throw new Error('BASE_SEPOLIA_RPC_URL must be set to fork Base Sepolia for Tier 2 scenarios');
    }
    anvil = await spawnAnvilFork({ forkUrl, chain: baseSepolia, silent: true });

    // 3. Spawn daemons against workspace homes with fork RPC override
    daemons = await spawnMultiOpDaemons({
      ops: ops.map((name, i) => ({
        name,
        home: workspace!.opPaths[name],
        apiPort: opts.portBase + i,
      })),
      extraEnv: { ...opts.extraEnv, JINN_RPC_URL: anvil.rpcUrl },
      readyTimeoutMs: 45000,
    });

    let torn = false;
    return {
      workspace,
      anvil,
      anvilRpcUrl: anvil.rpcUrl,
      daemons,
      teardown: async () => {
        if (torn) return;
        torn = true;
        await cleanup();
      },
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
