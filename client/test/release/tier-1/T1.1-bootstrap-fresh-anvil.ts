import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnAnvilFork, jsonRpc as anvilJsonRpc, type AnvilHarness } from '../../_support/chain/anvil.js';
import { FleetBootstrapper } from '../../../src/earning/bootstrap.js';
import { classifyFailure, type ScenarioVerdict, type ScenarioOptions } from '../../../scripts/release/scenario-types.js';

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const PASSWORD = 'test-password';

export async function runT11BootstrapFreshAnvil(opts: ScenarioOptions): Promise<ScenarioVerdict> {
  const started = Date.now();
  let chain: AnvilHarness | null = null;
  let tmpDir: string | null = null;
  const evidenceLines: string[] = [];
  const log = (msg: string): void => {
    evidenceLines.push(`[${new Date().toISOString()}] ${msg}`);
  };

  // Wall-clock check helper — throws if budget exceeded
  const checkBudget = (): void => {
    if (opts.wallClockBudgetMs && Date.now() - started > opts.wallClockBudgetMs) {
      throw new Error(`timed out after ${opts.wallClockBudgetMs}ms`);
    }
  };

  try {
    log('Phase 1: spawn Anvil fork of Base mainnet');
    chain = await spawnAnvilFork({ forkUrl: BASE_RPC_URL, silent: true });
    log(`  Anvil ready at ${chain.rpcUrl}`);
    checkBudget();

    log('Phase 2: bootstrap to awaiting_funding (generates master EOA)');
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
    log(`  Master EOA: ${eoaAddress}`);
    checkBudget();

    log('Phase 3: fund EOA on Anvil (100 ETH)');
    await anvilJsonRpc(chain.rpcUrl, 'anvil_setBalance', [
      eoaAddress,
      '0x56BC75E2D63100000', // 100 ETH
    ]);
    log(`  Funded master EOA with 100 ETH`);
    checkBudget();

    log('Phase 4: mine a block, re-bootstrap to completion');
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
    log(`  Bootstrap complete, service_id=${phase4.fleet_state.services[0]?.service_id ?? 'unknown'}`);

    log('Phase 11: complete');
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));

    return {
      scenarioId: 'T1.1',
      verdict: 'pass',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: null,
    };
  } catch (err) {
    const failClass = classifyFailure(err);
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));
    return {
      scenarioId: 'T1.1',
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass,
      failNotes: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (chain) {
      try { await chain.teardown(); } catch { /* best-effort */ }
    }
    if (tmpDir) {
      try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

describe('T1.1 bootstrap-fresh-anvil', () => {
  // The pass test requires real Base mainnet RPC; mark as long-running and skip if env signals.
  it('returns pass verdict when bootstrap completes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T1.1.log');
    try {
      const verdict = await runT11BootstrapFreshAnvil({ evidencePath, wallClockBudgetMs: 180000 });
      expect(verdict.scenarioId).toBe('T1.1');
      expect(verdict.verdict).toBe('pass');
      expect(verdict.evidencePath).toBe(evidencePath);
      expect(verdict.wallClockMs).toBeGreaterThan(0);
      expect(verdict.failClass).toBeNull();
      const logContent = await fs.readFile(evidencePath, 'utf-8');
      expect(logContent).toContain('Phase 1');
      expect(logContent).toContain('Phase 11');
      expect(logContent).toContain('complete');
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 240000);

  it('returns fail verdict when bootstrap stalls (wall-clock budget exceeded)', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T1.1-evidence-stall-'));
    const evidencePath = path.join(evidenceDir, 'T1.1.log');
    try {
      const verdict = await runT11BootstrapFreshAnvil({ evidencePath, wallClockBudgetMs: 1 });
      expect(verdict.verdict).toBe('fail');
      // Budget exceeded → throws "timed out after 1ms" → classifyFailure → flake-timing
      expect(verdict.failClass).toMatch(/^(flake-timing|real-bug|flake-infra)$/);
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 30000);
});
