import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnAnvilFork, jsonRpc as anvilJsonRpc, type AnvilHarness } from '../../_support/chain/anvil.js';
import { FleetBootstrapper } from '../../../src/earning/bootstrap.js';
import { runScenario, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const PASSWORD = 'test-password';

export async function runT11BootstrapFreshAnvil(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  return runScenario('T1.1', opts, async (evidence) => {
    const started = Date.now();
    let chain: AnvilHarness | null = null;
    let tmpDir: string | null = null;

    // Wall-clock check helper — throws if budget exceeded.
    const checkBudget = (): void => {
      if (opts.wallClockBudgetMs && Date.now() - started > opts.wallClockBudgetMs) {
        throw new Error(`timed out after ${opts.wallClockBudgetMs}ms`);
      }
    };

    try {
      evidence.log('Phase 1: spawn Anvil fork of Base mainnet');
      chain = await spawnAnvilFork({ forkUrl: BASE_RPC_URL, silent: true });
      evidence.log(`  Anvil ready at ${chain.rpcUrl}`);
      checkBudget();

      evidence.log('Phase 2: bootstrap to awaiting_funding (generates master EOA)');
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jinn-T1.1-'));
      const bootstrapper1 = new FleetBootstrapper({
        earningDir: tmpDir,
        chain: 'base',
        rpcUrl: chain.rpcUrl,
      });
      const phase2 = await bootstrapper1.bootstrap(PASSWORD);
      if (!phase2.funding) {
        throw new Error(`Phase 2 expected funding requirement, got ok=${phase2.ok}, message=${phase2.message}`);
      }
      const eoaAddress = phase2.funding.master_address;
      evidence.log(`  Master EOA: ${eoaAddress}`);
      checkBudget();

      evidence.log('Phase 3: fund EOA on Anvil (100 ETH)');
      await anvilJsonRpc(chain.rpcUrl, 'anvil_setBalance', [
        eoaAddress,
        '0x56BC75E2D63100000', // 100 ETH
      ]);
      evidence.log(`  Funded master EOA with 100 ETH`);
      checkBudget();

      evidence.log('Phase 4: mine a block, re-bootstrap to completion');
      await anvilJsonRpc(chain.rpcUrl, 'evm_mine', []);
      const bootstrapper2 = new FleetBootstrapper({
        earningDir: tmpDir,
        chain: 'base',
        rpcUrl: chain.rpcUrl,
      });
      const phase4 = await bootstrapper2.bootstrap(PASSWORD);
      if (!phase4.ok) {
        throw new Error(`Phase 4 bootstrap did not complete: ${phase4.message}`);
      }
      evidence.log(`  Bootstrap complete, service_id=${phase4.fleet_state.services[0]?.service_id ?? 'unknown'}`);

      evidence.log('Phase 11: complete');
      return { verdict: 'pass' };
    } finally {
      if (chain) {
        try { await chain.teardown(); } catch { /* best-effort */ }
      }
      if (tmpDir) {
        try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  });
}

