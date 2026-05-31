import { baseSepolia } from 'viem/chains';
import { copyWorkspace, type WorkspaceHandle } from '../../../scripts/release/substrate-copy.js';
import { spawnAnvilFork, type AnvilHarness } from '../../_support/chain/anvil.js';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon.js';
import { startMockIpfsServer, type MockIpfsServer } from '../../e2e/_daemon-harness-helpers.js';

export interface Tier2SetupOptions {
  scenarioId: string;                  // for run-id and debugging
  portBase: number;                    // op-a gets portBase, op-b gets portBase+1
  extraEnv?: NodeJS.ProcessEnv;        // additional env per daemon (e.g. JINN_HARNESS_STUB_INSTANCE)
  ops?: string[];                      // default: ['op-a', 'op-b']
  /**
   * Directory under which each spawned daemon's stdout + stderr is streamed
   * for its full lifetime. The helper appends `${scenarioId}-daemons/` so
   * multiple scenarios sharing a single evidenceDir do not stomp on each
   * other's daemon logs. Omit to keep the legacy in-memory-tail-only behaviour
   * (e.g. unit tests that don't care about post-bootstrap output).
   *
   * Typical caller pattern from a Tier-2 scenario:
   *   evidenceDir: path.dirname(opts.evidencePath)
   */
  evidenceDir?: string;
  /**
   * Opt-in: start ONE in-process mock IPFS server and point BOTH daemons'
   * `JINN_IPFS_REGISTRY_URL` + `JINN_IPFS_GATEWAY_URL` at it (default false so
   * T2.1 is unaffected). The mock supports runtime pinning — `POST /api/v0/add`
   * stores content under a deterministic CID, served back at `GET /ipfs/{cid}`
   * — so a manifest one operator pins at launch time is fetchable by the other.
   *
   * T2.3 needs this: its catalog enriches each launched-SolverNet row by
   * IPFS-fetching the manifest body. Without shared IPFS, op-a pins its
   * launch-time manifest to its own (real Autonolas) registry and op-b cannot
   * read it back, so the catalog row is skipped and "op-b sees op-a's
   * SolverNet" times out. A single shared mock closes that gap deterministically
   * and offline.
   */
  sharedMockIpfs?: boolean;
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
  let mockIpfs: MockIpfsServer | null = null;

  const cleanup = async () => {
    if (daemons) { try { await daemons.teardown(); } catch {} }
    if (mockIpfs) { try { await mockIpfs.close(); } catch {} }
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

    // 2b. Optional shared mock IPFS — one server both daemons read+write so a
    // manifest one operator pins at launch is fetchable by the other (T2.3
    // catalog enrichment). Point both registry (upload) and gateway (fetch)
    // URLs at it via the daemon spawn env.
    const sharedIpfsEnv: NodeJS.ProcessEnv = {};
    if (opts.sharedMockIpfs) {
      mockIpfs = await startMockIpfsServer();
      sharedIpfsEnv['JINN_IPFS_REGISTRY_URL'] = mockIpfs.baseUrl;
      sharedIpfsEnv['JINN_IPFS_GATEWAY_URL'] = mockIpfs.baseUrl;
    }

    // 3. Spawn daemons against workspace homes with fork RPC override
    // When the caller supplied an evidenceDir, route per-daemon stdout/stderr
    // into ${evidenceDir}/${scenarioId}-daemons/${op.name}-daemon.log so a
    // T2.x timeout 5+ minutes in has a readable log to point an investigator
    // at instead of forcing them to spelunk chain + db + harness logs.
    const logDir = opts.evidenceDir
      ? `${opts.evidenceDir.replace(/\/+$/, '')}/${opts.scenarioId}-daemons`
      : undefined;
    daemons = await spawnMultiOpDaemons({
      ops: ops.map((name, i) => ({
        name,
        home: workspace!.opPaths[name],
        apiPort: opts.portBase + i,
      })),
      extraEnv: { ...opts.extraEnv, ...sharedIpfsEnv, JINN_RPC_URL: anvil.rpcUrl },
      readyTimeoutMs: 45000,
      logDir,
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
